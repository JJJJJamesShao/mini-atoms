/**
 * modify SOP 运行统计聚合测试 — 口径与 engine/apply 事件语义对齐：
 * patch start 计尝试、apply end 含「补丁应用失败」计失败、stages 全 done 计成功。
 */

import { describe, expect, it } from "vitest";
import {
  aggregateModifyRuns,
  formatModifyStats,
  type ModifyRunRow,
} from "../src/lib/stats/modify-stats";
import type { ProcessLog, StageState } from "../src/lib/db/versions";

let seq = 0;
function log(stage: string, phase: ProcessLog["phase"], detail?: string) {
  return { seq: ++seq, stage, phase, detail, timestamp: 0 };
}

const ALL_DONE: StageState[] = [
  { stage: "locate", status: "done" },
  { stage: "patch", status: "done" },
  { stage: "apply", status: "done" },
  { stage: "verify", status: "done" },
];

const APPLY_FAILED: StageState[] = [
  { stage: "locate", status: "done" },
  { stage: "patch", status: "done" },
  { stage: "apply", status: "failed" },
  { stage: "verify", status: "pending" },
];

/** 一次成功运行：patch 1 次，apply 成功 */
const RUN_FIRST_TRY: ModifyRunRow = {
  sop_id: "modify",
  stages: ALL_DONE,
  logs: [
    log("locate", "start"),
    log("patch", "start"),
    log("apply", "end", "修改 1 处：主题色（~10 字符）"),
    log("verify", "end"),
  ],
};

/** 重试后成功：patch 2 次（首次块未命中），最终 done */
const RUN_RETRY_DONE: ModifyRunRow = {
  sop_id: "modify",
  stages: ALL_DONE,
  logs: [
    log("patch", "start"),
    log("apply", "end", "补丁应用失败：1 个块未命中，转入重试"),
    log("patch", "start"),
    log("apply", "end", "修改 1 处：标题（~8 字符）"),
    log("verify", "end"),
  ],
};

/** 重试后成功：首次 no-op */
const RUN_NOOP_DONE: ModifyRunRow = {
  sop_id: "modify",
  stages: ALL_DONE,
  logs: [
    log("patch", "start"),
    log("apply", "end", "补丁应用失败：0 个块未命中 / 无实际修改，转入重试"),
    log("patch", "start"),
    log("apply", "end", "修改 1 处：按钮（~5 字符）"),
  ],
};

/** 次数用尽失败：patch 5 次，apply 始终失败 */
const RUN_EXHAUSTED: ModifyRunRow = {
  sop_id: "modify",
  stages: APPLY_FAILED,
  logs: Array.from({ length: 5 }, () => [
    log("patch", "start"),
    log("apply", "end", "补丁应用失败：1 个块未命中，转入重试"),
  ]).flat(),
};

/** 无过程数据的存量行 */
const RUN_LEGACY: ModifyRunRow = {
  sop_id: "modify",
  stages: null,
  logs: null,
};

describe("aggregateModifyRuns", () => {
  it("一次成功：done + patch 尝试分布 + 一次成功率", () => {
    const stats = aggregateModifyRuns([RUN_FIRST_TRY]);
    expect(stats.analyzedRuns).toBe(1);
    expect(stats.doneRuns).toBe(1);
    expect(stats.failedRuns).toBe(0);
    expect(stats.patchAttemptsDist).toEqual({ "1": 1 });
    expect(stats.firstTrySuccessRate).toBe(1);
  });

  it("混合运行：成败比、尝试分布、失败细分、跳过行", () => {
    const stats = aggregateModifyRuns([
      RUN_FIRST_TRY,
      RUN_RETRY_DONE,
      RUN_NOOP_DONE,
      RUN_EXHAUSTED,
      RUN_LEGACY,
    ]);
    expect(stats.totalRuns).toBe(5);
    expect(stats.analyzedRuns).toBe(4);
    expect(stats.skippedRuns).toBe(1);
    expect(stats.doneRuns).toBe(3);
    expect(stats.failedRuns).toBe(1);
    expect(stats.patchAttemptsDist).toEqual({ "1": 1, "2": 2, "5+": 1 });
    // 一次成功仅 RUN_FIRST_TRY
    expect(stats.firstTrySuccessRate).toBe(0.25);
    expect(stats.applyFailBreakdown).toEqual({ block_mismatch: 6, noop: 1 });
  });

  it("空数据集不报错，比率为 0", () => {
    const stats = aggregateModifyRuns([]);
    expect(stats.totalRuns).toBe(0);
    expect(stats.firstTrySuccessRate).toBe(0);
    expect(formatModifyStats(stats)).toContain("总运行数：0");
  });

  it("报告含关键指标行", () => {
    const report = formatModifyStats(
      aggregateModifyRuns([RUN_FIRST_TRY, RUN_EXHAUSTED]),
    );
    expect(report).toContain("总运行数：2");
    expect(report).toContain("done 1 / fail 1");
    expect(report).toContain("一次成功率");
    expect(report).toContain("块未命中 5 次");
  });
});
