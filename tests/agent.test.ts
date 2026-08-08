import { describe, expect, it } from "vitest";
import { createCannedExecutors } from "../src/lib/agent/canned-executors";
import { runPipeline, TRANSITIONS } from "../src/lib/agent";
import type { Executors } from "../src/lib/agent";
import { cannedScenarios } from "../src/lib/mock/canned";

const FAIL_RESULT = {
  pass: false,
  stage: "syntax" as const,
  errors: [{ rule: "syntax", message: "mock 语法错误" }],
};

const OK_RESULT = { pass: true, stage: "structure" as const, errors: [] };

describe("runPipeline（罐头执行器）", () => {
  it("happy path：罐头执行器一路到 done", async () => {
    const { events, finalState, result } = await runPipeline(
      "做一个待办清单",
      createCannedExecutors("todo"),
    );
    expect(finalState).toBe("done");
    expect(result?.code).toBe(cannedScenarios[0].generate.code);
    expect(events.map((e) => e.state)).toEqual([
      "clarify",
      "spec",
      "approve",
      "generate",
      "verify",
      "done",
    ]);
  });

  it("verify 首次失败 → fix → 重新生成 → 成功", async () => {
    let verifyCalls = 0;
    const executors: Executors = {
      ...createCannedExecutors("timer"),
      verify: async () => {
        verifyCalls += 1;
        return verifyCalls === 1 ? FAIL_RESULT : OK_RESULT;
      },
    };
    const { events, finalState } = await runPipeline("计时器", executors);
    expect(finalState).toBe("done");
    expect(events.map((e) => e.state)).toEqual([
      "clarify",
      "spec",
      "approve",
      "generate",
      "verify",
      "fix",
      "generate",
      "verify",
      "done",
    ]);
  });

  it("verify 连续失败达到上限 → fail", async () => {
    const executors: Executors = {
      ...createCannedExecutors("snake"),
      verify: async () => FAIL_RESULT,
    };
    const { events, finalState } = await runPipeline("贪吃蛇", executors);
    expect(finalState).toBe("fail");
    // generate→verify 两轮 + 一轮 fix，第二轮 verify 失败后 fail
    expect(events.map((e) => e.state)).toEqual([
      "clarify",
      "spec",
      "approve",
      "generate",
      "verify",
      "fix",
      "generate",
      "verify",
      "fail",
    ]);
  });

  it("approve 被拒 → 回 clarify", async () => {
    const { events, finalState } = await runPipeline(
      "任意需求",
      createCannedExecutors("todo"),
      async () => false,
    );
    const states = events.map((e) => e.state);
    expect(states).toContain("approve");
    // approve 之后回到 clarify
    expect(
      states.indexOf("clarify", states.indexOf("approve")),
    ).toBeGreaterThan(states.indexOf("approve"));
    expect(finalState).toBe("fail");
  });

  it("事件序列完整性：每个事件含 state/payload/timestamp 且时间戳递增", async () => {
    const { events } = await runPipeline(
      "做一个待办清单",
      createCannedExecutors("todo"),
    );
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.state).toBeTruthy();
      expect(e).toHaveProperty("payload");
      expect(typeof e.timestamp).toBe("number");
    }
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(
        events[i - 1].timestamp,
      );
    }
  });

  it("所有实际转移都符合 TRANSITIONS 转移表", async () => {
    const { events } = await runPipeline(
      "做一个待办清单",
      createCannedExecutors("todo"),
    );
    let prev: "idle" | (typeof events)[number]["state"] = "idle";
    for (const e of events) {
      expect(TRANSITIONS[prev]).toContain(e.state);
      prev = e.state;
    }
  });
});
