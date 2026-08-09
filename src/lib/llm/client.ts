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
  const baseURL = process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";

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

/** 发起非流式对话 */
export async function chat(
  config: ModelConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
) {
  return getClient(config.model).chat.completions.create({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
  });
}

/** GLM 专用流式对话（供 generate 节点使用） */
export async function streamGLM(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options?: { maxTokens?: number; temperature?: number },
) {
  const client = getGLMClient();
  return client.chat.completions.create({
    model: "glm-5.2",
    messages,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.2,
    stream: true,
  });
}

/** GLM 专用非流式对话 */
export async function chatGLM(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options?: { maxTokens?: number; temperature?: number },
) {
  const client = getGLMClient();
  return client.chat.completions.create({
    model: "glm-5.2",
    messages,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.2,
    stream: false,
  });
}
