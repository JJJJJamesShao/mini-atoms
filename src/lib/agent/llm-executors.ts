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
 * 从流式响应中提取完整内容
 * TODO: 后续改为 SSE 逐字推送，当前先收集完整结果
 */
async function collectStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
): Promise<string> {
  let content = "";
  for await (const chunk of stream) {
    content += chunk.choices[0]?.delta?.content ?? "";
  }
  return content;
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
  const emit = (event: { type: string; agent: string; role?: string; input?: unknown; output?: unknown; message?: string }) => {
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

      // 模拟进度事件：每 3 秒推送一次，让前端知道系统还活着
      const progressTimer = bus
        ? setInterval(() => {
            bus.emit({
              type: "agent:thinking",
              agent: "generate",
              role: "前端工程师",
              message: errors?.length
                ? "正在修复代码并重新生成..."
                : "正在生成 HTML 代码，请稍候...",
            });
          }, 3000)
        : null;

      try {
        const messages = buildGeneratePrompt(spec, errors);
        const config = MODEL_ROUTING.generate;
        const stream = await streamChat(config, messages);
        const text = await collectStream(stream);
        const html = extractHtml(text);

        const result: GenerateOutput = {
          files: [{ path: "index.html", content: html }],
          notes: errors
            ? `修复后重新生成，修复 ${errors.length} 处错误`
            : "首次生成",
        };

        emit({ type: "agent:complete", agent: "generate", role: "前端工程师", output: result });
        return result;
      } finally {
        if (progressTimer) clearInterval(progressTimer);
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
