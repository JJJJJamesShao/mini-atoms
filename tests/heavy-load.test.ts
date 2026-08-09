/**
 * Heavy Load 测试 — 验证 SOP 引擎 + 消息池在高并发/大输入下的稳定性。
 * 使用 mock 执行器（不调 LLM），聚焦架构层稳定性而非模型表现。
 * 真实 LLM 压力测试需登录态 + 计费，不在自动化范围内（见任务卡 4.2 手动项）。
 */

import { describe, expect, it } from "vitest";
import { runSOP } from "../src/lib/agent/engine";
import { AgentEventBus } from "../src/lib/agent/bus";
import { DEFAULT_SOP, GAME_SOP } from "../src/lib/agent/sop";
import type { Executors } from "../src/lib/agent";
import type { VerifyResult } from "../src/lib/schemas";

const VERIFY_OK: VerifyResult = { pass: true, stage: "structure", errors: [] };

function makeExecutors(): Executors {
  return {
    clarify: async (input) => ({
      status: "ready",
      questions: [],
      summary: `需求：${input.slice(0, 50)}`,
    }),
    spec: async () => ({
      requirements: ["r1"],
      constraints: ["c1"],
      userStories: ["u1"],
    }),
    generate: async () => ({
      files: [{ path: "index.html", content: "<!DOCTYPE html><html></html>" }],
      notes: "mock",
    }),
    verify: async () => VERIFY_OK,
  };
}

describe("Heavy Load", () => {
  it("10 个并发流水线（各自独立 bus + 角色记忆）", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runSOP(
          `做一个计算器 ${i}`,
          DEFAULT_SOP,
          makeExecutors(),
          async () => true,
          new AgentEventBus(),
        ),
      ),
    );
    expect(results.every((r) => r.finalState === "done")).toBe(true);
  });

  it("超大输入（5000 字符）不炸", async () => {
    const input = "x".repeat(5000);
    const result = await runSOP(
      input,
      GAME_SOP,
      makeExecutors(),
      undefined,
      new AgentEventBus(),
    );
    expect(result.finalState).toBe("done");
  });

  it("连续 50 次运行无内存泄漏（增长 < 50MB）", async () => {
    // 预热，排除一次性分配干扰
    for (let i = 0; i < 5; i++) {
      await runSOP("预热", GAME_SOP, makeExecutors(), undefined, new AgentEventBus());
    }
    globalThis.gc?.();

    const initialMemory = process.memoryUsage().heapUsed;
    for (let i = 0; i < 50; i++) {
      await runSOP(
        "做一个待办清单",
        DEFAULT_SOP,
        makeExecutors(),
        async () => true,
        new AgentEventBus(),
      );
    }
    globalThis.gc?.();

    const growth = process.memoryUsage().heapUsed - initialMemory;
    expect(growth).toBeLessThan(50 * 1024 * 1024);
  }, 30000);

  it("bus 历史上限在长跑下不膨胀", async () => {
    const bus = new AgentEventBus();
    for (let i = 0; i < 30; i++) {
      // 故意复用同一个 bus：每次运行发布 4+ 条消息
      await runSOP("做一个数独游戏", GAME_SOP, makeExecutors(), undefined, bus);
    }
    expect(bus.stats().historySize).toBeLessThanOrEqual(100);
  }, 30000);
});
