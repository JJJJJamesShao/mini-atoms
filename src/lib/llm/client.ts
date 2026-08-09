import OpenAI from "openai";
import type { ModelConfig } from "./models";

const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
const baseURL = process.env.ANTHROPIC_BASE_URL;

if (!apiKey || !baseURL) {
  throw new Error(
    "Missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL in environment",
  );
}

/** 百炼 OpenAI 兼容客户端 */
export const client = new OpenAI({
  apiKey,
  baseURL,
});

/** 发起流式对话 */
export async function streamChat(
  config: ModelConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
) {
  return client.chat.completions.create({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
  });
}

/** 发起非流式对话（用于轻量任务） */
export async function chat(
  config: ModelConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
) {
  return client.chat.completions.create({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
  });
}
