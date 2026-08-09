import { config } from "dotenv";
config({ path: ".env.local" });
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN!,
  baseURL: process.env.ANTHROPIC_BASE_URL!,
});

async function test() {
  console.log("=== 测试 1: 基础对话 ===");
  const resp1 = await client.chat.completions.create({
    model: "qwen3.6-flash",
    messages: [{ role: "user", content: "你好，请用一句话介绍自己" }],
    max_tokens: 256,
  });
  console.log("qwen3.6-flash:", resp1.choices[0]?.message?.content);

  console.log("\n=== 测试 2: 流式输出 ===");
  const stream = await client.chat.completions.create({
    model: "qwen3.6-flash",
    messages: [{ role: "user", content: "写一首五言绝句" }],
    max_tokens: 256,
    stream: true,
  });

  let content = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    content += delta;
    process.stdout.write(delta);
  }
  console.log("\n\n完整输出:", content);

  console.log("\n=== 测试 3: JSON 结构化输出（clarify 节点） ===");
  const resp3 = await client.chat.completions.create({
    model: "qwen3.6-flash",
    messages: [
      {
        role: "system",
        content:
          '你是一位产品经理。请判断需求是否清晰，严格按 JSON 输出：{ "status": "ready" | "need_clarification", "questions": [], "summary": "..." }',
      },
      { role: "user", content: "我想要一个待办清单应用" },
    ],
    max_tokens: 512,
  });
  const jsonText = resp3.choices[0]?.message?.content ?? "";
  console.log("原始输出:", jsonText);
  try {
    const parsed = JSON.parse(jsonText);
    console.log("解析成功:", JSON.stringify(parsed, null, 2));
  } catch {
    console.log("解析失败，尝试提取 markdown 代码块...");
    const match = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      console.log("提取后:", JSON.parse(match[1].trim()));
    }
  }

  console.log("\n=== 全部测试通过 ===");
}

test().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
