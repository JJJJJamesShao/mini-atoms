/**
 * modify SOP 运行统计脚本（手动执行，不进生产 API）。
 *
 * 用法：npx tsx src/scripts/modify-stats.ts
 * 数据：versions 表 sop_id='modify' 的过程数据（002_process_data.sql 起）
 * 用途：V2「自主多补丁/多轮迭代」的立项决策依据——
 *   若一次成功率低、重试集中在块未命中 → 优先改进 locate/prompt；
 *   若大量需求单次补丁装不下 → 再评估自主多轮。
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSupabase } from "../lib/supabase/server";
import {
  aggregateModifyRuns,
  formatModifyStats,
  type ModifyRunRow,
} from "../lib/stats/modify-stats";

async function main() {
  const { data, error } = await getSupabase()
    .from("versions")
    .select("sop_id, stages, logs")
    .eq("sop_id", "modify");

  if (error) {
    console.error("查询 versions 失败：", error.message);
    process.exit(1);
  }

  const stats = aggregateModifyRuns((data ?? []) as ModifyRunRow[]);
  console.log(formatModifyStats(stats));
}

main();
