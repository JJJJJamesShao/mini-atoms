/**
 * 两阶段生成测试：思考期（规划）与出码期（关思考）拆分。
 *
 * 背景：GLM-5.2 的 max_tokens 对思考+正文合并计费，深度思考会挤占
 * 输出预算，导致长代码生成触及 128K 上限被截断（finish_reason=length），
 * 症状是"模型不再吐字、UI 干等"。拆分后出码期独占输出预算，
 * 且截断被显式检测并上抛（不切百炼兜底——8K 上限更装不下）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/llm/client", () => ({
  streamGLM: vi.fn(),
  streamChat: vi.fn(),
}));

import { streamChat, streamGLM } from "@/lib/llm/client";
import { createLLMExecutors } from "../src/lib/agent/llm-executors";
import { StreamTruncatedError } from "../src/lib/llm/stream";
import {
  GENERATE_MAX_TOKENS,
  parseEstimatedTokens,
  PLAN_MAX_TOKENS,
} from "../src/lib/llm/planner";
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

describe("parseEstimatedTokens", () => {
  it("解析标准标记", () => {
    expect(parseEstimatedTokens("方案内容\n估算token：85000")).toBe(85000);
  });
  it("容忍「约」前缀、英文冒号与千分位", () => {
    expect(parseEstimatedTokens("估算token: 约 120,000")).toBe(120000);
  });
  it("无标记返回 null", () => {
    expect(parseEstimatedTokens("方案内容，没有估计")).toBeNull();
  });
});

describe("两阶段生成", () => {
  it("阶段 1 思考开/32K，阶段 2 思考关/100K，方案注入出码消息", async () => {
    streamGLMMock
      .mockImplementationOnce(() =>
        fakeStream([{ content: PLAN_TEXT, finish: "stop" }]),
      )
      .mockImplementationOnce(() =>
        fakeStream([
          {
            content: "<!DOCTYPE html><html><body>app</body></html>",
            finish: "stop",
          },
        ]),
      );

    const { bus, events } = captureBus();
    const exec = createLLMExecutors(bus);
    const result = await exec.generate(SPEC);

    expect(streamGLMMock).toHaveBeenCalledTimes(2);
    const call1 = streamGLMMock.mock.calls[0];
    const call2 = streamGLMMock.mock.calls[1];
    expect(call1[1]).toMatchObject({
      maxTokens: PLAN_MAX_TOKENS,
      thinking: true,
    });
    expect(call2[1]).toMatchObject({
      maxTokens: GENERATE_MAX_TOKENS,
      thinking: false,
    });
    // 阶段 1 的方案必须注入阶段 2 的消息
    const phase2Messages = call2[0] as Array<{ role: string; content: string }>;
    expect(phase2Messages.at(-1)?.content).toContain(
      "实现方案：单页面三区块布局",
    );
    expect(result.files[0].content).toContain("<!DOCTYPE html>");
    expect(streamChatMock).not.toHaveBeenCalled();
    // 阶段进度事件可见
    const phaseEvents = events.filter(
      (e) => e.type === "agent:progress" && e.message?.includes("阶段"),
    );
    expect(phaseEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("预估超安全线：emit 截断风险提示但继续生成", async () => {
    streamGLMMock
      .mockImplementationOnce(() =>
        fakeStream([
          { content: "庞大方案\n估算token：120000", finish: "stop" },
        ]),
      )
      .mockImplementationOnce(() =>
        fakeStream([
          {
            content: "<!DOCTYPE html><html><body>big</body></html>",
            finish: "stop",
          },
        ]),
      );

    const { bus, events } = captureBus();
    const exec = createLLMExecutors(bus);
    await exec.generate(SPEC);

    const warning = events.find(
      (e) => e.type === "agent:thinking" && e.message?.includes("截断风险"),
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("120000");
  });

  it("出码期截断（finish_reason=length）：显式上抛，不走百炼兜底", async () => {
    streamGLMMock
      .mockImplementationOnce(() =>
        fakeStream([{ content: PLAN_TEXT, finish: "stop" }]),
      )
      .mockImplementationOnce(() =>
        fakeStream([
          { content: "<!DOCTYPE html><html><body>半成品" },
          { content: "", finish: "length" },
        ]),
      );

    const { bus } = captureBus();
    const exec = createLLMExecutors(bus);
    await expect(exec.generate(SPEC)).rejects.toThrow(StreamTruncatedError);
    expect(streamChatMock).not.toHaveBeenCalled();
  });
});
