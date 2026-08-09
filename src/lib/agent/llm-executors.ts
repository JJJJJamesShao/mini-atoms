import type { Executors } from "../agent";
import type { ClarifyOutput, GenerateOutput, SpecOutput } from "../schemas";
import type OpenAI from "openai";
import { chat, streamChat } from "@/lib/llm/client";
import { MODEL_ROUTING } from "@/lib/llm/models";
import {
  buildClarifyPrompt,
  buildGameGeneratePrompt,
  buildGeneratePrompt,
  buildSpecPrompt,
} from "@/lib/llm/prompts";
import {
  parseCodeArtifact,
  wrapHtmlAsArtifact,
} from "@/lib/schemas/code-artifact";
import { verifyProject } from "../verify";
import type { AgentEvent, AgentEventBus } from "./bus";
import { AgentMemory } from "./memory";
import { MessageTopic } from "./message";

/**
 * 实时收集流式响应，同时 emit 进度事件
 * 
 * @param stream - OpenAI 流式响应
 * @param bus - 事件总线
 * @returns 完整文本 + 统计信息
 */
async function collectStreamWithProgress(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  bus?: AgentEventBus,
): Promise<{ content: string; charCount: number; estimatedTokens: number }> {
  let content = "";
  let lastEmitLength = 0;
  const EMIT_INTERVAL = 200; // 每 200 字符 emit 一次

  // 子步骤解析：检测 <!-- SECTION: XXX --> 标记
  const SECTION_MARKERS = [
    { pattern: /<!--\s*SECTION:\s*HEAD\s*-->/i, name: "HTML 结构", desc: "生成 <head> 和 DOCTYPE" },
    { pattern: /<!--\s*SECTION:\s*CSS\s*-->/i, name: "CSS 样式", desc: "生成内联样式" },
    { pattern: /<!--\s*SECTION:\s*BODY\s*-->/i, name: "页面主体", desc: "生成 <body> 内容" },
    { pattern: /<!--\s*SECTION:\s*JS\s*-->/i, name: "JavaScript", desc: "生成交互脚本" },
  ];
  const emittedSections = new Set<string>();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    content += delta;

    // 每 200 字符 emit 进度
    if (content.length - lastEmitLength >= EMIT_INTERVAL) {
      lastEmitLength = content.length;
      const estimatedTokens = Math.round(content.length * 0.75); // 中文字符估算
      bus?.emit({
        type: "agent:progress",
        agent: "generate",
        role: "前端工程师",
        percent: Math.min(Math.round((content.length / 3000) * 100), 99),
        message: `已生成 ${content.length} 字符（约 ${estimatedTokens} tokens）...`,
      });
    }

    // 检测子步骤标记
    for (const marker of SECTION_MARKERS) {
      if (!emittedSections.has(marker.name) && marker.pattern.test(content)) {
        emittedSections.add(marker.name);
        bus?.emit({
          type: "agent:thinking",
          agent: "generate",
          role: "前端工程师",
          message: `正在生成 ${marker.name}：${marker.desc}`,
        });
      }
    }
  }

  const estimatedTokens = Math.round(content.length * 0.75);
  return { content, charCount: content.length, estimatedTokens };
}

/** 尝试从 LLM 输出中解析 JSON */
function extractJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim()) as T;
    }
    throw new Error("无法从 LLM 输出中解析 JSON: " + text.slice(0, 200));
  }
}

/** 清理 HTML 输出（去除可能的 markdown 包裹） */
function extractHtml(text: string): string {
  const match = text.match(/```(?:html)?\s*([\s\S]*?)```/);
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
    memories?: Partial<Record<"clarify" | "spec" | "generate" | "verify", AgentMemory>>;
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
      memory.clarify.add({ topic: MessageTopic.SYSTEM, content: input, metadata: { direction: "in" } });
      const messages = buildClarifyPrompt(input);
      const config = MODEL_ROUTING.clarify;
      console.log("[DEBUG] Clarify 请求:", { model: config.model, promptLength: messages[1]?.content?.length ?? 0 });
      const response = await chat(config, messages);
      const text = response.choices[0]?.message?.content ?? "";
      console.log("[DEBUG] Clarify 响应:", { textLength: text.length, textPrefix: text.slice(0, 100) });
      const result = extractJson<ClarifyOutput>(text);
      memory.clarify.add({ topic: MessageTopic.PRD, content: JSON.stringify(result), metadata: { direction: "out" } });
      emit({ type: "agent:complete", agent: "clarify", role: "产品经理", output: result });
      return result;
    },

    spec: async (clarify) => {
      emit({ type: "agent:start", agent: "spec", role: "架构师", input: clarify });
      memory.spec.add({ topic: MessageTopic.PRD, content: JSON.stringify(clarify), metadata: { direction: "in" } });
      const messages = buildSpecPrompt(clarify.summary);
      const config = MODEL_ROUTING.spec;
      console.log("[DEBUG] Spec 请求:", { model: config.model, promptLength: messages[1]?.content?.length ?? 0 });
      const response = await chat(config, messages);
      const text = response.choices[0]?.message?.content ?? "";
      console.log("[DEBUG] Spec 响应:", { textLength: text.length, textPrefix: text.slice(0, 100) });
      const result = extractJson<SpecOutput>(text);
      memory.spec.add({ topic: MessageTopic.ARCH_SPEC, content: JSON.stringify(result), metadata: { direction: "out" } });
      emit({ type: "agent:complete", agent: "spec", role: "架构师", output: result });
      return result;
    },

    generate: async (spec, errors) => {
      emit({
        type: "agent:start",
        agent: "generate",
        role: "前端工程师",
        input: { spec, errors },
      });
      memory.generate.add({ topic: MessageTopic.ARCH_SPEC, content: JSON.stringify(spec), metadata: { direction: "in" } });
      if (errors?.length) {
        memory.generate.add({ topic: MessageTopic.REVIEW, content: JSON.stringify(errors), metadata: { direction: "in" } });
      }

      try {
        // 游戏 SOP：结构化 JSON 输出；其他 SOP：单文件 HTML
        const messages = options?.structured
          ? buildGameGeneratePrompt(spec, errors)
          : buildGeneratePrompt(spec, errors);
        const config = MODEL_ROUTING.generate;
        console.log("[DEBUG] Generate 使用模型:", config.model);

        // GLM 5.2 流式 API 偶发返回空内容，降级为非流式 + 模拟进度
        bus?.emit({
          type: "agent:progress",
          agent: "generate",
          role: "前端工程师",
          percent: 10,
          message: "正在调用 LLM 生成代码，预计 15-30 秒...",
        });

        console.log("[DEBUG] Generate 请求:", {
          model: config.model,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
          promptLength: messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
          isStructured: options?.structured,
          messageCount: messages.length,
        });

        const response = await chat(config, messages);
        
        console.log("[DEBUG] Generate 响应:", {
          status: response.choices?.[0]?.finish_reason,
          contentLength: response.choices?.[0]?.message?.content?.length ?? 0,
          contentPrefix: response.choices?.[0]?.message?.content?.slice(0, 200) ?? "EMPTY",
        });

        const content = response.choices[0]?.message?.content ?? "";
        const charCount = content.length;
        const estimatedTokens = Math.round(charCount * 0.75);

        bus?.emit({
          type: "agent:progress",
          agent: "generate",
          role: "前端工程师",
          percent: 90,
          message: `代码生成完成，共 ${charCount} 字符，正在解析...`,
        });

        let result: GenerateOutput;
        if (options?.structured) {
          // 结构化解析；失败时降级为单文件 HTML 包装（不阻塞流水线）
          const artifact = parseCodeArtifact(content) ?? wrapHtmlAsArtifact(content);
          result = {
            files: artifact.files.map((f) => ({ path: f.path, content: f.content })),
            notes:
              (artifact.notes ? `${artifact.notes}；` : "") +
              (errors
                ? `修复后重新生成，修复 ${errors.length} 处错误，${artifact.files.length} 个文件共 ${charCount} 字符（约 ${estimatedTokens} tokens）`
                : `结构化生成 ${artifact.files.length} 个文件，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`),
          };
        } else {
          const html = extractHtml(content);
          result = {
            files: [{ path: "index.html", content: html }],
            notes: errors
              ? `修复后重新生成，修复 ${errors.length} 处错误，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`
              : `首次生成，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`,
          };
        }

        memory.generate.add({ topic: MessageTopic.CODE, content: JSON.stringify(result), metadata: { direction: "out" } });

        // 发出文件级事件，供 UI 展示文件变更
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
          agent: "generate",
          role: "前端工程师",
          error: errorMsg,
        });
        throw err;
      }
    },

    verify: async (files) => {
      emit({ type: "agent:start", agent: "verify", role: "代码审查员", input: files });
      memory.verify.add({ topic: MessageTopic.CODE, content: JSON.stringify(files), metadata: { direction: "in" } });
      const result = verifyProject(files);
      memory.verify.add({ topic: MessageTopic.REVIEW, content: JSON.stringify(result), metadata: { direction: "out" } });
      emit({ type: "agent:complete", agent: "verify", role: "代码审查员", output: result });
      return result;
    },
  };
}
