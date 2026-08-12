import type { Executors, PatchOutput } from "../agent";
import type {
  ClarifyOutput,
  GenerateOutput,
  LocateOutput,
  SpecOutput,
} from "../schemas";
import type OpenAI from "openai";
import { streamChat, streamGLM } from "@/lib/llm/client";
import { collectStreamText, throttleByChars } from "@/lib/llm/stream";
import { callJsonLlm } from "@/lib/llm/json-stream";
import { MODEL_ROUTING } from "@/lib/llm/models";
import {
  buildClarifyPrompt,
  buildGameGeneratePrompt,
  buildGeneratePrompt,
  buildLocatePrompt,
  buildModifyPatchPrompt,
  buildPatchPrompt,
  buildSpecPrompt,
  buildStagePrompt,
} from "@/lib/llm/prompts";
import {
  mergeToSingleHtml,
  parseCodeArtifact,
  wrapHtmlAsArtifact,
} from "@/lib/schemas/code-artifact";
import { applyPatch, parsePatch } from "./patch";
import { verifyProject } from "../verify";
import { verifyStageCode } from "../verify/stage";
import type { AgentEvent, AgentEventBus } from "./bus";
import { AgentMemory } from "./memory";
import { MessageTopic } from "./message";

/**
 * 流式超时档位（卡死判定统一只靠 idle；total 仅作失控兜底）：
 * - GENERATE：generate 系路径——完整重写 2 万+ 字符的大文件属正常时长，
 *   曾统一 300s 导致 follow-up 回退重写被误杀，故放宽到 600s
 * - FAST_JSON（clarify/spec/locate）已迁至 lib/llm/json-stream.ts
 * - SUMMARY：一句话代码摘要，秒级
 */
const GENERATE_STREAM_TIMEOUTS = {
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 600_000,
};
const SUMMARY_STREAM_TIMEOUTS = {
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 60_000,
};

/**
 * generate 系路径统一流式收集入口：超时档位 + 节流进度事件。
 * 此前 stage/follow-up/patch 三处逐字复制同一段"每 2000 字符 emit"模板。
 * @param intervalChars - 进度事件节流间隔（字符）；补丁类小输出用 300，
 *   全量生成用默认 2000
 */
async function collectGenerateStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  bus: AgentEventBus | undefined,
  agentName: string,
  messageFor: (accLength: number) => string,
  intervalChars = 2000,
): Promise<string> {
  return collectStreamText(
    stream,
    GENERATE_STREAM_TIMEOUTS,
    throttleByChars(intervalChars, (acc) => {
      bus?.emit({
        type: "agent:progress",
        agent: agentName,
        role: "前端工程师",
        message: messageFor(acc.length),
      });
    }),
  );
}

/**
 * 异步代码摘要器 — 生成过程中定期把已产出的代码片段发给快模型，
 * 返回"正在做什么"的一句话摘要，经 bus 推送前端，缓解长生成的"卡住感"。
 *
 * 设计约束：
 * - 异步非阻塞（调用方用 void 触发，不 await）
 * - 节流：最少间隔 10s 且新增 3000 字符才触发
 * - 快模型（qwen3.6-flash），成本可忽略
 * - 失败静默，绝不影响主生成流程
 */
export class CodeSummarizer {
  private lastSummaryTime = 0;
  private lastSummaryLength = 0;
  private isSummarizing = false;

  private readonly MIN_INTERVAL = 10000; // 最少 10s 间隔
  private readonly MIN_CHARS = 3000; // 最少新增 3000 字符

  /** summarizeFn 可注入（测试用）；默认走 qwen3.6-flash */
  constructor(
    private readonly summarizeFn: (
      snippet: string,
    ) => Promise<string> = defaultSummarize,
  ) {}

  /** 满足节流条件时异步生成摘要并回调；否则立即返回 */
  async maybeSummarize(
    content: string,
    onSummary: (summary: string) => void,
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastSummaryTime < this.MIN_INTERVAL) return;
    if (content.length - this.lastSummaryLength < this.MIN_CHARS) return;
    if (this.isSummarizing) return; // 避免并发

    this.isSummarizing = true;
    this.lastSummaryTime = now;
    this.lastSummaryLength = content.length;

    try {
      const summary = await this.summarizeFn(content.slice(-2000));
      if (summary) onSummary(summary);
    } catch (e) {
      // 摘要失败静默处理，不影响主流程
      console.warn("[Summarizer] failed:", e);
    } finally {
      this.isSummarizing = false;
    }
  }
}

/** 默认摘要实现：快模型一句话总结代码片段在做什么（流式 + 短超时） */
async function defaultSummarize(snippet: string): Promise<string> {
  const text = await collectStreamText(
    await streamChat(MODEL_ROUTING.clarify, [
      {
        role: "system",
        content:
          "你是一位代码分析助手。请用一句话（不超过 20 个字）总结这段代码正在实现什么功能。只输出总结，不要解释。",
      },
      { role: "user", content: `代码片段：\n${snippet}` },
    ]),
    SUMMARY_STREAM_TIMEOUTS,
  );
  return text.trim();
}

/**
 * 实时收集流式响应，同时 emit 进度事件
 *
 * 超时保护（collectStreamText，GENERATE_STREAM_TIMEOUTS）：
 * 60s 无 chunk 判定 provider 挂起；600s 总时长仅作失控兜底——
 * 完整重写大文件属正常时长，曾用 300s 误杀 follow-up 回退重写。
 *
 * @param stream - OpenAI 流式响应
 * @param bus - 事件总线
 * @returns 完整文本 + 统计信息
 */
async function collectStreamWithProgress(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  bus?: AgentEventBus,
): Promise<{ content: string; charCount: number; estimatedTokens: number }> {
  // 每 200 字符 emit 一次进度（节流公共函数）
  const emitProgress = throttleByChars(200, (acc) => {
    const estimatedTokens = Math.round(acc.length * 0.75); // 中文字符估算
    bus?.emit({
      type: "agent:progress",
      agent: "generate",
      role: "前端工程师",
      percent: Math.min(Math.round((acc.length / 3000) * 100), 99),
      message: `已生成 ${acc.length} 字符（约 ${estimatedTokens} tokens）...`,
    });
  });

  // 子步骤解析：检测 <!-- SECTION: XXX --> 标记
  const SECTION_MARKERS = [
    {
      pattern: /<!--\s*SECTION:\s*HEAD\s*-->/i,
      name: "HTML 结构",
      desc: "生成 <head> 和 DOCTYPE",
    },
    {
      pattern: /<!--\s*SECTION:\s*CSS\s*-->/i,
      name: "CSS 样式",
      desc: "生成内联样式",
    },
    {
      pattern: /<!--\s*SECTION:\s*BODY\s*-->/i,
      name: "页面主体",
      desc: "生成 <body> 内容",
    },
    {
      pattern: /<!--\s*SECTION:\s*JS\s*-->/i,
      name: "JavaScript",
      desc: "生成交互脚本",
    },
  ];
  const emittedSections = new Set<string>();
  const summarizer = new CodeSummarizer();

  const content = await collectStreamText(
    stream,
    GENERATE_STREAM_TIMEOUTS,
    (acc) => {
      emitProgress(acc);

      // 检测子步骤标记
      for (const marker of SECTION_MARKERS) {
        if (!emittedSections.has(marker.name) && marker.pattern.test(acc)) {
          emittedSections.add(marker.name);
          bus?.emit({
            type: "agent:thinking",
            agent: "generate",
            role: "前端工程师",
            message: `正在生成 ${marker.name}：${marker.desc}`,
          });
        }
      }

      // 异步代码摘要（节流 + 失败静默，不阻塞主流程）
      if (bus) {
        void summarizer.maybeSummarize(acc, (summary) => {
          bus.emit({
            type: "agent:summary",
            agent: "generate",
            role: "前端工程师",
            message: summary,
          });
        });
      }
    },
  );

  const estimatedTokens = Math.round(content.length * 0.75);
  console.log("[DEBUG] Stream complete:", {
    totalChars: content.length,
    firstChars: content.slice(0, 100),
  });
  return { content, charCount: content.length, estimatedTokens };
}

/** 清理 HTML 输出（去除可能的 markdown 包裹） */
function extractHtml(text: string): string {
  // 使用贪婪匹配找到最后一个 ``` 结束标记，处理嵌套代码块
  const match = text.match(/```(?:html|css|js|javascript)?\s*([\s\S]+)```\s*$/);
  if (match) {
    return match[1].trim();
  }
  return text.trim();
}

/**
 * 创建真实 LLM 执行器（接入 Agent EventBus + 角色 Memory）
 *
 * @param bus - 事件总线，用于 emit 中间进度事件
 * @param options.structured - true 时（游戏 SOP）强制结构化 JSON 输出（CodeArtifact）
 * @param options.memories - 各节点角色的记忆实例（由调用方按 Role 注入）；
 *   缺省时每节点各自创建——保证单次运行内记忆隔离、跨运行不串扰
 */
export function createLLMExecutors(
  bus?: AgentEventBus,
  options?: {
    structured?: boolean;
    memories?: Partial<
      Record<"clarify" | "spec" | "generate" | "verify", AgentMemory>
    >;
  },
): Executors {
  const emit = (event: Omit<AgentEvent, "timestamp">) => {
    bus?.emit(event);
  };
  const memory = {
    clarify: options?.memories?.clarify ?? new AgentMemory(),
    spec: options?.memories?.spec ?? new AgentMemory(),
    generate: options?.memories?.generate ?? new AgentMemory(),
    verify: options?.memories?.verify ?? new AgentMemory(),
  };

  return {
    clarify: async (input: string) => {
      emit({ type: "agent:start", agent: "clarify", role: "产品经理", input });
      memory.clarify.add({
        topic: MessageTopic.SYSTEM,
        content: input,
        metadata: { direction: "in" },
      });
      const messages = buildClarifyPrompt(input);
      const config = MODEL_ROUTING.clarify;
      console.log("[DEBUG] Clarify 请求:", {
        model: config.model,
        promptLength: messages[1]?.content?.length ?? 0,
      });
      // 流式收集 + 坏 JSON 多级兜底 + 解析失败自动重试（快模型成本低）
      const result = await callJsonLlm<ClarifyOutput>({
        config,
        messages,
        bus,
        agent: "clarify",
        role: "产品经理",
        progressLabel: "需求澄清中",
      });
      console.log("[DEBUG] Clarify 响应: status =", result.status);
      memory.clarify.add({
        topic: MessageTopic.PRD,
        content: JSON.stringify(result),
        metadata: { direction: "out" },
      });
      emit({
        type: "agent:complete",
        agent: "clarify",
        role: "产品经理",
        output: result,
      });
      return result;
    },

    spec: async (clarify) => {
      emit({
        type: "agent:start",
        agent: "spec",
        role: "架构师",
        input: clarify,
      });
      memory.spec.add({
        topic: MessageTopic.PRD,
        content: JSON.stringify(clarify),
        metadata: { direction: "in" },
      });
      // 新版 clarify 输出含结构化 requirements；旧输出回退到 summary 包装
      // constraints/assumptions 一并透传，架构师方案需尊重澄清阶段的约束
      const messages = buildSpecPrompt({
        requirements: clarify.requirements?.length
          ? clarify.requirements
          : [clarify.summary],
        constraints: clarify.constraints,
        assumptions: clarify.assumptions,
      });
      const config = MODEL_ROUTING.spec;
      console.log("[DEBUG] Spec 请求:", {
        model: config.model,
        promptLength: messages[1]?.content?.length ?? 0,
      });
      // 流式收集 + 坏 JSON 多级兜底 + 解析失败自动重试（曾间歇性坏 JSON
      // 直接杀死整条流水线——web-app 运行死在 spec 步骤的事故）
      const result = await callJsonLlm<SpecOutput>({
        config,
        messages,
        bus,
        agent: "spec",
        role: "架构师",
        progressLabel: "规格设计中",
      });
      console.log(
        "[DEBUG] Spec 响应: requirements =",
        result.requirements?.length ?? 0,
      );
      memory.spec.add({
        topic: MessageTopic.ARCH_SPEC,
        content: JSON.stringify(result),
        metadata: { direction: "out" },
      });
      emit({
        type: "agent:complete",
        agent: "spec",
        role: "架构师",
        output: result,
      });
      return result;
    },

    generate: async (spec, errors, currentFiles, attempt = 0, stage) => {
      const isFixMode = errors && errors.length > 0;
      const hasCurrentCode = currentFiles && currentFiles.length > 0;
      const fixAttempt = attempt; // 0=首次, 1+=修复轮次
      // 多阶段 SOP：事件以步骤名命名（generate-schema 等），与前端阶段卡片对齐
      const agentName = stage ? `generate-${stage}` : "generate";

      emit({
        type: "agent:start",
        agent: agentName,
        role: "前端工程师",
        input: { spec, errors, isFixMode, hasCurrentCode, stage },
      });
      memory.generate.add({
        topic: MessageTopic.ARCH_SPEC,
        content: JSON.stringify(spec),
        metadata: { direction: "in" },
      });
      if (errors?.length) {
        memory.generate.add({
          topic: MessageTopic.REVIEW,
          content: JSON.stringify(errors),
          metadata: { direction: "in" },
        });
      }

      try {
        // === 多阶段 SOP 模式：stage 存在 → 阶段专用 prompt，产出中间产物 ===
        if (stage) {
          const stageFile =
            stage === "schema"
              ? "schema.js"
              : stage === "shell"
                ? "shell.html"
                : "pages.js";
          bus?.emit({
            type: "agent:progress",
            agent: agentName,
            role: "前端工程师",
            percent: 5,
            message: isFixMode
              ? `重修 ${stage} 阶段产物（第 ${fixAttempt} 次修复）...`
              : `生成 ${stage} 阶段产物...`,
          });

          const messages = buildStagePrompt(
            stage,
            spec,
            hasCurrentCode ? currentFiles : undefined,
            errors,
          );
          // 流式 + 超时保护（统一走 collectGenerateStream 公共入口）
          const rawContent = await collectGenerateStream(
            await streamChat(MODEL_ROUTING.generate, messages),
            bus,
            agentName,
            (len) => `${stage} 阶段：已生成 ${len} 字符...`,
          );
          // 剥离可能的 markdown 围栏（与主生成路径 extractHtml 对齐，
          // 模型用 ``` 包裹时不过阶段校验会白耗 fix 轮次）
          const content = extractHtml(rawContent);

          const result: GenerateOutput = {
            files: [{ path: stageFile, content: content.trim() }],
            notes: `${stage} 阶段产物生成完成（${content.trim().length} 字符）`,
          };
          memory.generate.add({
            topic: MessageTopic.CODE,
            content: JSON.stringify(result),
            metadata: { direction: "out" },
          });
          bus?.emit({
            type: "file:generated",
            agent: agentName,
            role: "前端工程师",
            message: `${stageFile}（${result.files[0].content.length} 字符）`,
            output: {
              path: stageFile,
              size: result.files[0].content.length,
            },
          });
          emit({
            type: "agent:complete",
            agent: agentName,
            role: "前端工程师",
            output: result,
            message: result.notes,
          });
          return result;
        }

        // FOLLOW-UP 模式已移除：用户主动修改由 modify SOP
        // （locate→patch→apply→verify 小循环）承担，不再寄生在 generate 里。
        // 此处保留的 PATCH 模式仅服务生成 SOP 内 verify 失败后的 fix 回路。

        // === PATCH 模式：校验失败 + 有当前代码 → 精确编辑，避免完整重写 ===
        if (isFixMode && hasCurrentCode) {
          const currentHtml = currentFiles[0].content;
          const patchRound = fixAttempt;
          bus?.emit({
            type: "agent:progress",
            agent: "generate",
            role: "前端工程师",
            percent: 10,
            message: `第 ${patchRound} 轮 Patch 修复：当前代码 ${currentHtml.length} 字符，${errors.length} 处错误...`,
          });

          // 使用 patch prompt，传入当前代码和错误详情
          const messages = buildPatchPrompt(currentHtml, errors);

          // 流式 + 超时保护（同 follow-up：非流式长请求会被代理静默挂起）
          const patchText = await collectGenerateStream(
            await streamChat(MODEL_ROUTING.generate, messages),
            bus,
            "generate",
            (len) => `第 ${patchRound} 轮修复：已接收 ${len} 字符 Patch...`,
          );

          bus?.emit({
            type: "agent:thinking",
            agent: "generate",
            role: "前端工程师",
            message: `收到 Patch 指令，正在解析并应用...`,
          });

          // 解析并应用 patch
          const blocks = parsePatch(patchText);
          const patchResult = applyPatch(currentHtml, blocks);

          if (!patchResult.success) {
            // Patch 应用失败 → 回退到完整重写
            bus?.emit({
              type: "agent:thinking",
              agent: "generate",
              role: "前端工程师",
              message: `第 ${patchRound} 轮 Patch 应用失败（${patchResult.failed}/${blocks.length} 块匹配失败），回退到完整重写...`,
            });
            // 继续执行下方的完整生成逻辑
          } else if (patchResult.newContent === currentHtml) {
            // Patch 应用了但内容没变 → 无效 Patch，回退完整重写
            bus?.emit({
              type: "agent:thinking",
              agent: "generate",
              role: "前端工程师",
              message: `第 ${patchRound} 轮 Patch 未产生实际修改，回退到完整重写...`,
            });
            // 继续执行下方的完整生成逻辑
          } else {
            const newHtml = patchResult.newContent;
            const result: GenerateOutput = {
              files: [{ path: "index.html", content: newHtml }],
              notes: `第 ${patchRound} 轮 Patch 修复成功：应用 ${patchResult.applied} 处修改，代码从 ${currentHtml.length} → ${newHtml.length} 字符`,
            };

            memory.generate.add({
              topic: MessageTopic.CODE,
              content: JSON.stringify(result),
              metadata: { direction: "out" },
            });

            bus?.emit({
              type: "file:generated",
              agent: "generate",
              role: "前端工程师",
              message: `${result.files[0].path}（第 ${patchRound} 轮 Patch 编辑，${newHtml.length} 字符）`,
              output: { path: result.files[0].path, size: newHtml.length },
            });

            emit({
              type: "agent:complete",
              agent: "generate",
              role: "前端工程师",
              output: result,
              message: `第 ${patchRound} 轮 Patch 修复完成：${patchResult.applied} 处修改已应用`,
            });
            return result;
          }
        }

        // === 正常生成模式（首次生成 或 Patch 失败回退） ===
        const messages = options?.structured
          ? buildGameGeneratePrompt(spec, errors)
          : buildGeneratePrompt(spec, errors);

        bus?.emit({
          type: "agent:progress",
          agent: "generate",
          role: "前端工程师",
          percent: 10,
          message: isFixMode
            ? "Patch 失败，回退到完整重写..."
            : "正在调用 GLM-5.2 生成代码...",
        });

        let content: string;
        let charCount: number;
        let estimatedTokens: number;

        try {
          const stream = await streamGLM(messages, {
            maxTokens: 131072,
            temperature: 0.2,
          });
          const result = await collectStreamWithProgress(stream, bus);
          content = result.content;
          charCount = result.charCount;
          estimatedTokens = result.estimatedTokens;
        } catch (glmErr) {
          console.warn("[GLM Fallback]", glmErr);
          bus?.emit({
            type: "agent:thinking",
            agent: "generate",
            role: "前端工程师",
            message: "GLM 服务暂不可用，降级到百炼流式模型...",
          });
          const stream = await streamChat(MODEL_ROUTING.generate, messages);
          const result = await collectStreamWithProgress(stream, bus);
          content = result.content;
          charCount = result.charCount;
          estimatedTokens = result.estimatedTokens;
        }

        let result: GenerateOutput;
        if (options?.structured) {
          const artifact =
            parseCodeArtifact(content) ?? wrapHtmlAsArtifact(content);
          const singleHtml = mergeToSingleHtml(artifact);
          result = {
            files: [{ path: "index.html", content: singleHtml }],
            notes:
              (artifact.notes ? `${artifact.notes}；` : "") +
              (isFixMode
                ? `完整重写修复 ${errors!.length} 处错误，${artifact.files.length} 个文件合并为单文件，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`
                : `结构化生成 ${artifact.files.length} 个文件，已合并为单文件，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`),
          };
        } else {
          const html = extractHtml(content);
          result = {
            files: [{ path: "index.html", content: html }],
            notes: isFixMode
              ? `完整重写修复 ${errors!.length} 处错误，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`
              : `首次生成，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`,
          };
        }

        memory.generate.add({
          topic: MessageTopic.CODE,
          content: JSON.stringify(result),
          metadata: { direction: "out" },
        });

        for (const file of result.files) {
          bus?.emit({
            type: "file:generated",
            agent: "generate",
            role: "前端工程师",
            message: `${file.path}（${file.content.length} 字符）`,
            output: { path: file.path, size: file.content.length },
          });
        }

        emit({
          type: "agent:complete",
          agent: "generate",
          role: "前端工程师",
          output: result,
          message: `生成完成：${result.files.length} 个文件，${charCount} 字符`,
        });
        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[Generate Error]", errorMsg, err);
        bus?.emit({
          type: "agent:error",
          agent: agentName,
          role: "前端工程师",
          error: errorMsg,
        });
        throw err;
      }
    },

    verify: async (files, stage) => {
      // 多阶段 SOP：阶段产物走阶段级校验（schema/pages 验 JS 语法、shell 验骨架），
      // 事件以步骤名命名（verify-schema 等），与前端阶段卡片对齐
      const agentName = stage ? `verify-${stage}` : "verify";
      emit({
        type: "agent:start",
        agent: agentName,
        role: "代码审查员",
        input: files,
      });
      memory.verify.add({
        topic: MessageTopic.CODE,
        content: JSON.stringify(files),
        metadata: { direction: "in" },
      });
      const result = stage
        ? verifyStageCode(files[0]?.content ?? "", stage)
        : verifyProject(files);
      memory.verify.add({
        topic: MessageTopic.REVIEW,
        content: JSON.stringify(result),
        metadata: { direction: "out" },
      });
      emit({
        type: "agent:complete",
        agent: agentName,
        role: "代码审查员",
        output: result,
      });
      return result;
    },

    // === modify SOP：改动定位（架构师，快模型） ===
    locate: async (input, currentFiles) => {
      emit({ type: "agent:start", agent: "locate", role: "架构师", input });
      const currentHtml = currentFiles[0]?.content ?? "";
      memory.spec.add({
        topic: MessageTopic.SYSTEM,
        content: JSON.stringify({ input, codeLength: currentHtml.length }),
        metadata: { direction: "in" },
      });
      const messages = buildLocatePrompt(currentHtml, input);
      // 与 clarify/spec 同一入口：流式收集 + 坏 JSON 兜底 + 解析失败重试
      const result = await callJsonLlm<LocateOutput>({
        config: MODEL_ROUTING.clarify,
        messages,
        bus,
        agent: "locate",
        role: "架构师",
        progressLabel: "改动定位中",
      });
      memory.spec.add({
        topic: MessageTopic.ARCH_SPEC,
        content: JSON.stringify(result),
        metadata: { direction: "out" },
      });
      emit({
        type: "agent:complete",
        agent: "locate",
        role: "架构师",
        output: result,
        message: `定位到 ${result.anchors.length} 个改动点`,
      });
      return result;
    },

    // === modify SOP：补丁生成（工程师，强模型，锚点聚焦 + 反馈重试） ===
    patch: async (locate, currentFiles, feedback, attempt = 0) => {
      emit({
        type: "agent:start",
        agent: "patch",
        role: "前端工程师",
        input: {
          intent: locate.intent,
          anchors: locate.anchors.length,
          attempt,
        },
      });
      const currentHtml = currentFiles[0]?.content ?? "";
      memory.generate.add({
        topic: MessageTopic.ARCH_SPEC,
        content: JSON.stringify(locate),
        metadata: { direction: "in" },
      });
      bus?.emit({
        type: "agent:progress",
        agent: "patch",
        role: "前端工程师",
        percent: 10,
        message:
          attempt > 0
            ? `第 ${attempt} 次补丁重试：根据反馈修正...`
            : `基于 ${locate.anchors.length} 个改动点生成补丁（现有代码 ${currentHtml.length} 字符）...`,
      });

      const messages = buildModifyPatchPrompt(currentHtml, locate, feedback);
      // 补丁是小输出：300 字符节流让进度动态可见（全量生成路径默认 2000）
      const patchText = await collectGenerateStream(
        await streamChat(MODEL_ROUTING.generate, messages),
        bus,
        "patch",
        (len) => `已接收 ${len} 字符补丁...`,
        300,
      );

      const result: PatchOutput = {
        patchText,
        notes: `补丁生成完成（${patchText.length} 字符${attempt > 0 ? `，第 ${attempt} 次重试` : ""}）`,
      };
      memory.generate.add({
        topic: MessageTopic.CODE,
        content: JSON.stringify(result),
        metadata: { direction: "out" },
      });
      emit({
        type: "agent:complete",
        agent: "patch",
        role: "前端工程师",
        output: result,
        message: result.notes,
      });
      return result;
    },
  };
}
