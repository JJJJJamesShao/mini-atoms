import OpenAI from "openai";

const apiKey = process.env["GLM_5.2"];
const baseURL = "https://open.bigmodel.cn/api/paas/v4/";

if (!apiKey) {
  throw new Error("Missing GLM_5.2 API key in environment");
}

/** 智谱 GLM OpenAI 兼容客户端 */
export const glmClient = new OpenAI({
  apiKey,
  baseURL,
});

/** GLM 流式对话 */
export async function glmStreamChat(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens?: number,
) {
  return glmClient.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens ?? 4096,
    temperature: 0.2,
    stream: true,
  });
}

/** GLM 非流式对话 */
export async function glmChat(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens?: number,
) {
  return glmClient.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens ?? 4096,
    temperature: 0.2,
    stream: false,
  });
}
