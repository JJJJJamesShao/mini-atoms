import OpenAI from "openai";
import type { ModelConfig } from "./models";

/** 懒加载百炼客户端 — 构建时不检查环境变量，只在运行时检查 */
function getBailianClient(): OpenAI {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = process.env.ANTHROPIC_BASE_URL;

  if (!apiKey || !baseURL) {
    throw new Error(
      "Missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL in environment",
    );
  }

  return new OpenAI({ apiKey, baseURL });
}

/** 懒加载 GLM 客户端 */
function getGLMClient(): OpenAI {
  const apiKey = process.env.GLM_API_KEY;
  const baseURL =
    process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";

  if (!apiKey) {
    throw new Error("Missing GLM_API_KEY in environment");
  }

  return new OpenAI({ apiKey, baseURL });
}

/** 根据模型名判断使用哪个 Provider */
function getClient(model: string): OpenAI {
  if (model.startsWith("glm")) {
    return getGLMClient();
  }
  return getBailianClient();
}

/** 发起流式对话（自动按模型选择 Provider） */
export async function streamChat(
  config: ModelConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
) {
  return getClient(config.model).chat.completions.create({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
  });
}

/**
 * 发起非流式对话 — 仅供 src/scripts/ 手动测试脚本使用。
 * 生产代码一律走 streamChat + collectStreamText：
 * 非流式长请求曾被代理静默挂起 15 分钟（follow-up 假死事故），
 * 流式 + 主动 idle/total 超时可观测、可干预。
 */
export async function chat(
  config: ModelConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
) {
  return getClient(config.model).chat.completions.create(
    {
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      stream: false,
    },
    { timeout: 120_000, maxRetries: 1 },
  );
}

/** GLM 专用流式对话（供 generate 节点使用）；signal 用于首 token 看门狗主动断连 */
export async function streamGLM(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
) {
  const client = getGLMClient();
  const model = process.env.GLM_5_2 ?? "glm-5.2";
  return client.chat.completions.create(
    {
      model,
      messages,
      max_tokens: options?.maxTokens ?? 131072,
      temperature: options?.temperature ?? 0.2,
      stream: true,
    },
    { signal: options?.signal },
  );
}
