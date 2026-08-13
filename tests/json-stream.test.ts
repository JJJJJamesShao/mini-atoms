/**
 * json-stream 容错测试 — clarify/spec/locate 的坏 JSON 护栏：
 * - extractJson 多级兜底：fence / 首尾废话 / 字符串内 raw 控制字符
 * - callJsonLlm 解析失败自动重试：坏输出回喂 + 用户可读终态文案
 * 背景：模型间歇输出非法 JSON 曾直接杀死整条流水线（spec 步骤事故）。
 */

import { describe, expect, it } from "vitest";
import type { streamChat } from "../src/lib/llm/client";
import type { AgentEventBus } from "../src/lib/agent/bus";
import type { AgentEvent } from "../src/lib/agent/bus";
import { callJsonLlm, extractJson } from "../src/lib/llm/json-stream";

type ChatFn = typeof streamChat;
type ChatMessages = Parameters<ChatFn>[1];

/** 构造一次性产出 text 的假流式响应 */
function fakeStream(text: string): Awaited<ReturnType<ChatFn>> {
  const chunk = { choices: [{ delta: { content: text } }] };
  return (async function* () {
    yield chunk;
  })() as unknown as Awaited<ReturnType<ChatFn>>;
}

const TEST_CONFIG = { model: "test-model", desc: "测试", maxTokens: 1024 };

describe("extractJson 多级兜底", () => {
  it("合法 JSON 直接解析", () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("markdown fence 包裹可解析", () => {
    const text = '```json\n{"a": 2}\n```';
    expect(extractJson<{ a: number }>(text)).toEqual({ a: 2 });
  });

  it("首尾废话容忍：截取花括号范围", () => {
    const text = '好的，以下是结果：\n{"a": 3}\n希望对你有帮助！';
    expect(extractJson<{ a: number }>(text)).toEqual({ a: 3 });
  });

  it("字符串内 raw 换行/制表符：转义后可解析", () => {
    // JSON 字符串内不允许 raw 控制字符，模型长文本输出偶发违反
    const text = '{"summary": "第一行\n第二行\t缩进"}';
    expect(extractJson<{ summary: string }>(text)).toEqual({
      summary: "第一行\n第二行\t缩进",
    });
  });

  it("完全非 JSON：抛错且错误信息不内嵌原始输出", () => {
    const secret = "这是一段不应该出现在错误信息里的模型输出";
    expect(() => extractJson(secret)).toThrowError(/不是合法 JSON/);
    try {
      extractJson(secret);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("无闭合花括号的截断输出：抛错", () => {
    expect(() => extractJson('{"a": 1, "b": "截断')).toThrowError(
      /不是合法 JSON/,
    );
  });
});

describe("callJsonLlm 解析失败重试", () => {
  it("截断输出（finish_reason=length）：走重试路径而非抛 StreamTruncatedError", async () => {
    // 回归：截断抛错是 GLM 出码期 opt-in 行为，JSON 节点必须保持
    // 「收多少解析多少 → 失败重试」的既有容错（spec 事故护栏）
    let calls = 0;
    const chatFn = (async () => {
      calls += 1;
      if (calls === 1) {
        return (async function* () {
          yield {
            choices: [
              { delta: { content: '{"ok": tru' }, finish_reason: null },
            ],
          };
          yield {
            choices: [{ delta: { content: "" }, finish_reason: "length" }],
          };
        })();
      }
      return fakeStream('{"ok": true}');
    }) as unknown as ChatFn;
    const result = await callJsonLlm<{ ok: boolean }>({
      config: TEST_CONFIG,
      messages: [{ role: "user", content: "hi" }],
      chatFn,
      agent: "spec",
      role: "架构师",
      progressLabel: "规格设计中",
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("首次即合法：只调用一次", async () => {
    let calls = 0;
    const chatFn = (async () => {
      calls += 1;
      return fakeStream('{"ok": true}');
    }) as ChatFn;
    const result = await callJsonLlm<{ ok: boolean }>({
      config: TEST_CONFIG,
      messages: [{ role: "user", content: "hi" }],
      chatFn,
      agent: "spec",
      role: "架构师",
      progressLabel: "规格设计中",
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it("首次坏 JSON → 回喂坏输出重试 → 第二次成功", async () => {
    const captured: ChatMessages[] = [];
    const outputs = ["这不是 JSON", '{"ok": true}'];
    let calls = 0;
    const chatFn = (async (_c: unknown, messages: ChatMessages) => {
      captured.push(messages);
      const text = outputs[calls];
      calls += 1;
      return fakeStream(text);
    }) as unknown as ChatFn;
    const result = await callJsonLlm<{ ok: boolean }>({
      config: TEST_CONFIG,
      messages: [{ role: "user", content: "hi" }],
      chatFn,
      agent: "spec",
      role: "架构师",
      progressLabel: "规格设计中",
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    // 第二次调用应携带：assistant 坏输出 + 重试指令
    const retry = captured[1];
    expect(retry.at(-2)).toMatchObject({
      role: "assistant",
      content: "这不是 JSON",
    });
    expect(retry.at(-1)?.role).toBe("user");
    expect(String(retry.at(-1)?.content)).toContain("不是合法 JSON");
  });

  it("重试时经 bus 推送 thinking 事件", async () => {
    const events: AgentEvent[] = [];
    const bus = {
      emit: (e: Omit<AgentEvent, "timestamp">) => events.push(e as AgentEvent),
    } as unknown as AgentEventBus;
    let calls = 0;
    const chatFn = (async () => {
      calls += 1;
      return fakeStream(calls === 1 ? "坏输出" : '{"ok": 1}');
    }) as ChatFn;
    await callJsonLlm({
      config: TEST_CONFIG,
      messages: [],
      chatFn,
      bus,
      agent: "spec",
      role: "架构师",
      progressLabel: "规格设计中",
    });
    const thinking = events.filter((e) => e.type === "agent:thinking");
    expect(thinking.length).toBe(1);
    expect(thinking[0].message).toContain("自动重试");
  });

  it("重试耗尽：抛出用户可读文案（不含 raw JSON），调用次数等于上限", async () => {
    const bad = "始终不是 JSON 的输出内容";
    let calls = 0;
    const chatFn = (async () => {
      calls += 1;
      return fakeStream(bad);
    }) as ChatFn;
    const err = await callJsonLlm({
      config: TEST_CONFIG,
      messages: [],
      chatFn,
      agent: "spec",
      role: "架构师",
      progressLabel: "规格设计中",
    }).catch((e: Error) => e);
    expect(calls).toBe(3); // 首次 + 2 次重试
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("架构师");
    expect((err as Error).message).toContain("已自动重试 2 次");
    expect((err as Error).message).not.toContain(bad);
  });
});
