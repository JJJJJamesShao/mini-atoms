/**
 * collectStreamText 超时保护回归测试 — follow-up 非流式挂起 15 分钟事故的修复：
 * 流式收集必须具备 idle（单 chunk 空闲）与 total（总时长）双重超时，
 * 且超时时主动断开底层连接（controller.abort）。
 */

import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import {
  collectStreamText,
  StreamTimeoutError,
  throttleByChars,
} from "../src/lib/llm/stream";

type Chunk = OpenAI.Chat.ChatCompletionChunk;
type FakeStream = AsyncIterable<Chunk> & { controller?: AbortController };

function makeChunk(text: string): Chunk {
  return {
    choices: [{ delta: { content: text } }],
  } as unknown as Chunk;
}

/** 构造一个按节拍吐出 chunk 的假流（delayMs 为吐出前的等待） */
function fakeStream(
  parts: { text: string; delayMs?: number }[],
  controller?: AbortController,
): FakeStream {
  const stream: FakeStream = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<Chunk>> {
          if (i >= parts.length) return { done: true, value: undefined };
          const part = parts[i++];
          if (part.delayMs) {
            await new Promise((r) => setTimeout(r, part.delayMs));
          }
          return { done: false, value: makeChunk(part.text) };
        },
        async return(): Promise<IteratorResult<Chunk>> {
          return { done: true, value: undefined };
        },
      };
    },
  };
  if (controller) stream.controller = controller;
  return stream;
}

describe("collectStreamText 超时保护", () => {
  it("正常流式：收集全部文本并触发 onText 回调", async () => {
    const seen: string[] = [];
    const content = await collectStreamText(
      fakeStream([{ text: "你好" }, { text: "世界" }, { text: "！" }]),
      { idleTimeoutMs: 1000, totalTimeoutMs: 5000 },
      (acc) => seen.push(acc),
    );
    expect(content).toBe("你好世界！");
    expect(seen.length).toBe(3);
    expect(seen[2]).toBe("你好世界！");
  });

  it("idle 超时：chunk 间隔超过上限抛 StreamTimeoutError(idle)", async () => {
    await expect(
      collectStreamText(
        fakeStream([{ text: "第一段" }, { text: "第二段", delayMs: 200 }]),
        { idleTimeoutMs: 50, totalTimeoutMs: 5000 },
      ),
    ).rejects.toMatchObject({ name: "StreamTimeoutError", kind: "idle" });
  });

  it("total 超时：总时长超限抛 StreamTimeoutError(total)", async () => {
    // 每个 chunk 30ms，idle 上限很宽松，但 80ms 总时长装不下 5 个 chunk
    await expect(
      collectStreamText(
        fakeStream(
          Array.from({ length: 5 }, (_, i) => ({
            text: `段${i}`,
            delayMs: 30,
          })),
        ),
        { idleTimeoutMs: 5000, totalTimeoutMs: 80 },
      ),
    ).rejects.toMatchObject({ name: "StreamTimeoutError", kind: "total" });
  });

  it("超时时主动断开底层连接（controller.abort 被调用）", async () => {
    const controller = new AbortController();
    await expect(
      collectStreamText(
        fakeStream([{ text: "x" }, { text: "y", delayMs: 200 }], controller),
        { idleTimeoutMs: 50, totalTimeoutMs: 5000 },
      ),
    ).rejects.toBeInstanceOf(StreamTimeoutError);
    expect(controller.signal.aborted).toBe(true);
  });

  it("空流立即返回空字符串", async () => {
    const content = await collectStreamText(fakeStream([]), {
      idleTimeoutMs: 1000,
      totalTimeoutMs: 5000,
    });
    expect(content).toBe("");
  });
});

describe("throttleByChars 字符增量节流", () => {
  it("每新累积 intervalChars 才触发一次，携带累计文本", () => {
    const seen: string[] = [];
    const throttled = throttleByChars(10, (acc) => seen.push(acc));

    throttled("abcde", "abcde"); // 5 < 10，不触发
    throttled("abcdefghij", "fghij"); // 达到 10，触发
    throttled("abcdefghijk", "k"); // 11-10=1 < 10，不触发
    throttled("abcdefghijklmnopqrst", "lmnopqrst"); // 达到 20，触发

    expect(seen).toEqual(["abcdefghij", "abcdefghijklmnopqrst"]);
  });

  it("单次增量跨越多倍间隔也只触发一次（以最新累计为准）", () => {
    const seen: string[] = [];
    const throttled = throttleByChars(5, (acc) => seen.push(acc));

    throttled("x".repeat(12), "x".repeat(12)); // 一次跨越 2 个间隔
    expect(seen).toEqual(["x".repeat(12)]);
  });

  it("从零开始计数，首个 chunk 不足间隔不触发", () => {
    const seen: string[] = [];
    const throttled = throttleByChars(100, (acc) => seen.push(acc));

    throttled("short", "short");
    expect(seen).toEqual([]);
  });
});
