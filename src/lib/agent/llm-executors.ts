import type { Executors } from "../agent";
import type { ClarifyOutput, GenerateOutput, SpecOutput } from "../schemas";
import type OpenAI from "openai";
import { chat, streamChat } from "@/lib/llm/client";
import { MODEL_ROUTING } from "@/lib/llm/models";
import {
  buildClarifyPrompt,
  buildGeneratePrompt,
  buildSpecPrompt,
} from "@/lib/llm/prompts";
import { verifyProject } from "../verify";
import type { AgentEventBus } from "./bus";

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
 * 创建真实 LLM 执行器（接入 Agent EventBus）
 * 
 * @param bus - 事件总线，用于 emit 中间进度事件
 */
export function createLLMExecutors(bus?: AgentEventBus): Executors {
  const emit = (event: { type: string; agent: string; role?: string; input?: unknown; output?: unknown; message?: string; percent?: number }) => {
    bus?.emit(event as any);
  };

  return {
    clarify: async (input: string) => {
      emit({ type: "agent:start", agent: "clarify", role: "产品经理", input });
      const messages = buildClarifyPrompt(input);
      const config = MODEL_ROUTING.clarify;
      const response = await chat(config, messages);
      const text = response.choices[0]?.message?.content ?? "";
      const result = extractJson<ClarifyOutput>(text);
      emit({ type: "agent:complete", agent: "clarify", role: "产品经理", output: result });
      return result;
    },

    spec: async (clarify) => {
      emit({ type: "agent:start", agent: "spec", role: "架构师", input: clarify });
      const messages = buildSpecPrompt(clarify.summary);
      const config = MODEL_ROUTING.spec;
      const response = await chat(config, messages);
      const text = response.choices[0]?.message?.content ?? "";
      const result = extractJson<SpecOutput>(text);
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

      try {
        const messages = buildGeneratePrompt(spec, errors);
        // 使用百炼 GLM 5.2 保证代码质量
        const config = { ...MODEL_ROUTING.generate, model: "glm-5.2", maxTokens: 4096 };
        const stream = await streamChat(config, messages);
        
        // 实时收集 + 进度推送
        const { content, charCount, estimatedTokens } = await collectStreamWithProgress(stream, bus);
        const html = extractHtml(content);

        const result: GenerateOutput = {
          files: [{ path: "index.html", content: html }],
          notes: errors
            ? `修复后重新生成，修复 ${errors.length} 处错误，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`
            : `首次生成，共 ${charCount} 字符（约 ${estimatedTokens} tokens）`,
        };

        emit({ 
          type: "agent:complete", 
          agent: "generate", 
          role: "前端工程师", 
          output: result,
          message: `生成完成：${charCount} 字符（约 ${estimatedTokens} tokens）`,
        });
        return result;
      } catch (err) {
        bus?.emit({
          type: "agent:error",
          agent: "generate",
          role: "前端工程师",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },

    verify: async (files) => {
      emit({ type: "agent:start", agent: "verify", role: "代码审查员", input: files });
      const result = verifyProject(files);
      emit({ type: "agent:complete", agent: "verify", role: "代码审查员", output: result });
      return result;
    },
  };
}
