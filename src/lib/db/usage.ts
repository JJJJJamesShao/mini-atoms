import { getSupabase } from "../supabase/server";

export type UsageAction = "generate";

/** 记录一次 LLM 生成用量（限流与审计依据） */
export async function logUsage(
  userId: string,
  action: UsageAction,
): Promise<void> {
  const { error } = await getSupabase()
    .from("usage")
    .insert({ user_id: userId, action });
  if (error) throw error;
}

/** 统计用户当日用量（UTC 日界） */
export async function countUsageToday(
  userId: string,
  action: UsageAction,
): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await getSupabase()
    .from("usage")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("action", action)
    .gte("created_at", todayStart.toISOString());
  if (error) throw error;
  return count ?? 0;
}
