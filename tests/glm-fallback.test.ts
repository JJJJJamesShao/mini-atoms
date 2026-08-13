/**
 * GLM 韧性测试：reasoning 思考展示 + 首 token 看门狗 + 百炼兜底。
 *
 * 背景：GLM-5.2 深度思考阶段可静默数分钟（实测 193s 空窗），
 * Vercel 上直连 bigmodel.cn 不可达时会挂起到被平台 300s 强杀。
 * 设计：reasoning_content 流式展示为 agent:thinking；
 * 首 token（content 或 reasoning）200s 未到达 → 主动断连，切换百炼 QWEN_3_8。
 *
 * 注意：非结构化生成已是两阶段（规划→出码），每次 generate 调用
 * streamGLM 两次；两个阶段各自独立执行看门狗与兜底。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/llm/client", () => ({
  streamGLM: vi.fn(),
  streamChat: vi.fn(),
}));

import { streamChat, streamGLM } from "@/lib/llm/client";
import { createLLMExecutors } from "../src/lib/agent/llm-executors";
import { collectStreamText } from "../src/lib/llm/stream";
import type { AgentEvent, AgentEventBus } from "../src/lib/agent/bus";
import type { SpecOutput } from "../src/lib/schemas";

const streamGLMMock = streamGLM as unknown as Mock;
const streamChatMock = streamChat as unknown as Mock;

const SPEC: SpecOutput = {
  requirements: ["单文件 HTML 待办清单"],
  constraints: ["不引入外部依赖"],
  userStories: ["作为用户，我可以添加待办"],
};

const PLAN_TEXT =
  "实现方案：单页面三区块布局，状态用数组管理。\n估算token：50000";

/** 构造 OpenAI 流式 chunk 序列的假 Stream（content / reasoning_content 可混排） */
function fakeStream(
  chunks: Array<{ content?: string; reasoning?: string; finish?: string }>,
): AsyncIterable<never> {
  return (async function* () {
    for (const c of chunks) {
      yield {
        choices: [
          {
            index: 0,
            finish_reason: c.finish ?? null,
            delta: {
              content: c.content ?? "",
              reasoning_content: c.reasoning,
            },
          },
        ],
      } as never;
    }
  })();
}

function captureBus(): { bus: AgentEventBus; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const bus = {
    emit: (e: Omit<AgentEvent, "timestamp">) => events.push(e as AgentEvent),
  } as unknown as AgentEventBus;
  return { bus, events };
}

beforeEach(() => {
  streamGLMMock.mockReset();
  streamChatMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("collectStreamText 思考回调", () => {
  it("reasoning_content 走 onThinking，不混入 content 产物", async () => {
    const thinkingAcc: string[] = [];
    const content = await collectStreamText(
      fakeStream([
        { reasoning: "先分析布局。" },
        { reasoning: "再实现交互。" },
        { content: "<!DOCTYPE html>", finish: "stop" },
      ]) as Parameters<typeof collectStreamText>[0],
      { idleTimeoutMs: 1000, totalTimeoutMs: 5000 },
      undefined,
      (acc) => thinkingAcc.push(acc),
    );
    expect(content).toBe("<!DOCTYPE html>");
    expect(thinkingAcc.length).toBeGreaterThan(0);
    expect(thinkingAcc.at(-1)).toBe("先分析布局。再实现交互。");
  });
});

describe("generate 执行器 GLM 韧性", () => {
  it("GLM 正常：思考过程转为 agent:thinking 事件，产物不含思考内容", async () => {
    // emitThinking 按 300 字符节流，构造足够长的思考内容
    const reasoningChunk = "正在分析页面结构与状态管理设计。".repeat(20);
    streamGLMMock.mockImplementation(() =>
      fakeStream([
        { reasoning: reasoningChunk },
        { reasoning: reasoningChunk },
        {
          content: "<!DOCTYPE html><html><body>app</body></html>",
          finish: "stop",
        },
      ]),
    );

    const { bus, events } = captureBus();
    const exec = createLLMExecutors(bus);
    const result = await exec.generate(SPEC);

    const thinkingEvents = events.filter(
      (e) => e.type === "agent:thinking" && e.message?.startsWith("思考中："),
    );
    expect(thinkingEvents.length).toBeGreaterThan(0);
    expect(result.files[0].content).toContain("<!DOCTYPE html>");
    expect(result.files[0].content).not.toContain("正在分析页面结构");
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("GLM 首 token 200s 无响应：看门狗断连，切换百炼兜底", async () => {
    streamGLMMock.mockImplementation(
      (_messages: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new Error("This operation was aborted")),
          );
        }),
    );
    // 两阶段各兜底一次：规划、出码各消费一条新流
    streamChatMock
      .mockImplementationOnce(() =>
        fakeStream([{ content: PLAN_TEXT, finish: "stop" }]),
      )
      .mockImplementationOnce(() =>
        fakeStream([
          {
            content: "<!DOCTYPE html><html><body>fallback</body></html>",
            finish: "stop",
          },
        ]),
      );

    vi.useFakeTimers();
    const { bus, events } = captureBus();
    const exec = createLLMExecutors(bus);
    const promise = exec.generate(SPEC);

    // 阶段 1 看门狗触发 → 兜底出方案；阶段 2 看门狗再次触发 → 兜底出码
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(200_000);
    vi.useRealTimers();

    const result = await promise;
    expect(streamChatMock).toHaveBeenCalledTimes(2);
    expect(result.files[0].content).toContain("fallback");
    const fallbackNotice = events.find(
      (e) =>
        e.type === "agent:thinking" &&
        e.message?.includes("首 token 超过 200s"),
    );
    expect(fallbackNotice).toBeDefined();
  });

  it("GLM 立即报错（如 401）：走通用降级文案，仍由百炼完成生成", async () => {
    streamGLMMock.mockRejectedValue(new Error("401 Unauthorized"));
    streamChatMock
      .mockImplementationOnce(() =>
        fakeStream([{ content: PLAN_TEXT, finish: "stop" }]),
      )
      .mockImplementationOnce(() =>
        fakeStream([
          {
            content: "<!DOCTYPE html><html><body>fallback</body></html>",
            finish: "stop",
          },
        ]),
      );

    const { bus, events } = captureBus();
    const exec = createLLMExecutors(bus);
    const result = await exec.generate(SPEC);

    expect(streamChatMock).toHaveBeenCalledTimes(2);
    expect(result.files[0].content).toContain("fallback");
    const fallbackNotice = events.find(
      (e) =>
        e.type === "agent:thinking" && e.message?.includes("GLM 服务暂不可用"),
    );
    expect(fallbackNotice).toBeDefined();
  });
});
