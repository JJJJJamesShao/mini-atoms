/**
 * modify SOP 运行统计（V2「自主多补丁/多轮迭代」的立项决策依据）。
 * 纯函数：从 versions 表过程数据聚合，零 LLM 成本、零生产 API 面。
 *
 * 口径定义（与 engine/apply 的事件语义对齐）：
 * - patch 尝试次数 = logs 中 stage="patch" 且 phase="start" 的条数
 * - apply 失败 = logs 中 stage="apply" 且 phase="end" 且 detail 含「补丁应用失败」
 *   - 细分：detail 含「无实际修改」→ no-op；否则 → 块未命中
 * - 运行成败 = stages 全部 done → done；否则 fail（与落库终态语义一致）
 * - 无过程数据的存量行（stages/logs 为 null）计入 skipped，不参与比率
 */

import type { ProcessLog, StageState } from "../db/versions";

/** 聚合输入的最小行形状（与 VersionRow 子集同构） */
export interface ModifyRunRow {
  sop_id: string | null;
  stages: StageState[] | null;
  logs: ProcessLog[] | null;
}

export interface ModifyStats {
  /** sop_id = modify 的总运行数（含跳过行） */
  totalRuns: number;
  /** 有过程数据、参与统计的运行数 */
  analyzedRuns: number;
  /** 无过程数据被跳过的行数 */
  skippedRuns: number;
  doneRuns: number;
  failedRuns: number;
  /** 一次成功率：patch 仅 1 次尝试且最终 done（占 analyzedRuns） */
  firstTrySuccessRate: number;
  /** patch 尝试次数分布（"1" / "2" / "3" / "4" / "5+"） */
  patchAttemptsDist: Record<string, number>;
  /** apply 失败细分：block_mismatch（块未命中）/ noop（无实际修改） */
  applyFailBreakdown: { block_mismatch: number; noop: number };
}

export function aggregateModifyRuns(rows: ModifyRunRow[]): ModifyStats {
  const stats: ModifyStats = {
    totalRuns: rows.length,
    analyzedRuns: 0,
    skippedRuns: 0,
    doneRuns: 0,
    failedRuns: 0,
    firstTrySuccessRate: 0,
    patchAttemptsDist: {},
    applyFailBreakdown: { block_mismatch: 0, noop: 0 },
  };

  let firstTryDone = 0;

  for (const row of rows) {
    if (!row.stages || !row.logs) {
      stats.skippedRuns++;
      continue;
    }
    stats.analyzedRuns++;

    const patchAttempts = row.logs.filter(
      (l) => l.stage === "patch" && l.phase === "start",
    ).length;
    const bucket = patchAttempts >= 5 ? "5+" : String(patchAttempts);
    stats.patchAttemptsDist[bucket] =
      (stats.patchAttemptsDist[bucket] ?? 0) + 1;

    for (const log of row.logs) {
      if (
        log.stage === "apply" &&
        log.phase === "end" &&
        log.detail?.includes("补丁应用失败")
      ) {
        if (log.detail.includes("无实际修改")) {
          stats.applyFailBreakdown.noop++;
        } else {
          stats.applyFailBreakdown.block_mismatch++;
        }
      }
    }

    const done = row.stages.every((s) => s.status === "done");
    if (done) {
      stats.doneRuns++;
      if (patchAttempts === 1) firstTryDone++;
    } else {
      stats.failedRuns++;
    }
  }

  stats.firstTrySuccessRate =
    stats.analyzedRuns > 0 ? firstTryDone / stats.analyzedRuns : 0;
  return stats;
}

/** 格式化为终端可读的报告 */
export function formatModifyStats(stats: ModifyStats): string {
  const pct = (n: number, d: number) =>
    d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "-";
  const dist = Object.entries(stats.patchAttemptsDist)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${k} 次：${v} 次运行`)
    .join("\n");
  return [
    "=== modify SOP 运行统计 ===",
    `总运行数：${stats.totalRuns}（参与统计 ${stats.analyzedRuns}，无过程数据跳过 ${stats.skippedRuns}）`,
    `成败：done ${stats.doneRuns} / fail ${stats.failedRuns}（fail 率 ${pct(stats.failedRuns, stats.analyzedRuns)}）`,
    `一次成功率（patch 1 次且 done）：${(stats.firstTrySuccessRate * 100).toFixed(1)}%`,
    `patch 尝试次数分布：`,
    dist || "  （无数据）",
    `apply 失败细分：块未命中 ${stats.applyFailBreakdown.block_mismatch} 次 / 无实际修改 ${stats.applyFailBreakdown.noop} 次`,
  ].join("\n");
}
