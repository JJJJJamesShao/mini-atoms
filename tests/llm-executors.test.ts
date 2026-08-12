/**
 * verify 执行器事件文案测试 — 判定结果必须可见。
 * 背景：agent:complete 此前无 message（前端回退显示"校验完成"），
 * 连判失败时用户在 UI 上看不出系统在为什么循环。
 * verify 是确定性校验（零 LLM），可直接单测。
 */

import { describe, expect, it } from "vitest";
import { createLLMExecutors } from "../src/lib/agent/llm-executors";
import type { AgentEvent, AgentEventBus } from "../src/lib/agent/bus";
import type { File } from "../src/lib/schemas";

function captureBus(): { bus: AgentEventBus; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const bus = {
    emit: (e: Omit<AgentEvent, "timestamp">) => events.push(e as AgentEvent),
  } as unknown as AgentEventBus;
  return { bus, events };
}

const VALID_HTML: File[] = [
  {
    path: "index.html",
    content:
      "<!DOCTYPE html><html><head><title>t</title></head><body><script>let count = 0;</script></body></html>",
  },
];

const INVALID_HTML: File[] = [
  {
    path: "index.html",
    content: "<html><body>缺少 DOCTYPE</body></html>",
  },
];

describe("verify 执行器事件文案", () => {
  it("校验通过：message 明确为「校验通过」", async () => {
    const { bus, events } = captureBus();
    const exec = createLLMExecutors(bus);
    const result = await exec.verify(VALID_HTML);
    expect(result.pass).toBe(true);
    const complete = events.find((e) => e.type === "agent:complete");
    expect(complete?.message).toBe("校验通过");
  });

  it("校验未通过：message 含问题数量与首条简述", async () => {
    const { bus, events } = captureBus();
    const exec = createLLMExecutors(bus);
    const result = await exec.verify(INVALID_HTML);
    expect(result.pass).toBe(false);
    const complete = events.find((e) => e.type === "agent:complete");
    expect(complete?.message).toContain("校验未通过");
    expect(complete?.message).toContain("处问题");
  });
});
