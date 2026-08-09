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
  // 先尝试直接解析
  try {
    return JSON.parse(text) as T;
  } catch {
    // 尝试提取 markdown 代码块中的 JSON
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim()) as T;
    }
    throw new Error("无法从 LLM 输出中解析 JSON: " + text.slice(0, 200));
  }
}

/** 清理 HTML 输出（去除可能的 markdown 包裹） */
function extractHtml(text: string): string {
  // 如果 LLM 用 markdown 代码块包裹了 HTML，提取出来
  const match = text.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (match) {
    return match[1].trim();
  }
  return text.trim();
}

/**
 * 创建真实 LLM 执行器
 * 【替换点】当前为同步收集实现，后续接入 SSE 流式推送
 */
export function createLLMExecutors(): Executors {
  return {
    clarify: async (input: string) => {
      const messages = buildClarifyPrompt(input);
      const config = MODEL_ROUTING.clarify;
      const response = await chat(config, messages);
      const text = response.choices[0]?.message?.content ?? "";
      return extractJson<ClarifyOutput>(text);
    },

    spec: async (clarify) => {
      const messages = buildSpecPrompt(clarify.summary);
      const config = MODEL_ROUTING.spec;
      const response = await chat(config, messages);
      const text = response.choices[0]?.message?.content ?? "";
      return extractJson<SpecOutput>(text);
    },

    generate: async (spec, errors) => {
      const messages = buildGeneratePrompt(spec, errors);
      const config = MODEL_ROUTING.generate;
      const stream = await streamChat(config, messages);
      const text = await collectStream(stream);
      const html = extractHtml(text);

      return {
        files: [{ path: "index.html", content: html }],
        notes: errors
          ? `修复后重新生成，修复 ${errors.length} 处错误`
          : "首次生成",
      };
    },

    verify: async (files) => verifyProject(files),
  };
}
