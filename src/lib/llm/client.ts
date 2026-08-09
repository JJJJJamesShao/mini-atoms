import OpenAI from "openai";
import type { ModelConfig } from "./models";

/** 懒加载百炼客户端 — 构建时不检查环境变量，只在运行时检查 */
function getClient(): OpenAI {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = process.env.ANTHROPIC_BASE_URL;

  if (!apiKey || !baseURL) {
    throw new Error(
      "Missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL in environment",
    );
  }

  return new OpenAI({ apiKey, baseURL });
}

/** 发起流式对话 */
export async function streamChat(
  config: ModelConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
) {
  return getClient().chat.completions.create({
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
  return getClient().chat.completions.create({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
  });
}
