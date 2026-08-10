import type { SpecOutput } from "../schemas";
import { getSupabase } from "../supabase/server";

export type GateType = "approve" | "need_input";
export type GateStatus = "pending" | "approved" | "rejected" | "expired";

/** 挂起门 payload：刷新后重建"等待确认"UI 所需的全部上下文 */
export interface GatePayload {
  spec: SpecOutput;
  /** 触发本次运行的用户输入（恢复版本卡片标题用） */
  input: string;
  /** 分叉基准（follow-up 运行时记录） */
  baseVersionNo: number | null;
}

export interface GateRow {
  id: string;
  session_id: string;
  project_id: string | null;
  user_id: string;
  type: GateType;
  status: GateStatus;
  payload: GatePayload | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
}

/** 创建挂起门记录（与内存 resolver 双写；失败仅降级为内存态，不阻断流水线） */
export async function createGate(
  sessionId: string,
  projectId: string | null,
  userId: string,
  type: GateType,
  payload: GatePayload,
  timeoutMs: number,
): Promise<void> {
  const { error } = await getSupabase()
    .from("gates")
    .insert({
      session_id: sessionId,
      project_id: projectId,
      user_id: userId,
      type,
      payload,
      expires_at: new Date(Date.now() + timeoutMs).toISOString(),
    });
  if (error) throw error;
}

/**
 * 查询用户的挂起门（惰性过期：读到的过期 pending 行顺手标记 expired）。
 * projectId 提供时只查该项目的挂起门。
 */
export async function getPendingGates(
  userId: string,
  projectId?: string,
): Promise<GateRow[]> {
  let query = getSupabase()
    .from("gates")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query;
  if (error) throw error;

  const now = new Date().toISOString();
  const alive: GateRow[] = [];
  const expiredIds: string[] = [];
  for (const row of (data ?? []) as GateRow[]) {
    if (row.expires_at <= now) expiredIds.push(row.id);
    else alive.push(row);
  }
  if (expiredIds.length > 0) {
    // 惰性过期：标记为 expired（下次查询不再返回）
    await getSupabase()
      .from("gates")
      .update({ status: "expired", resolved_at: now })
      .in("id", expiredIds);
  }
  return alive;
}

/**
 * 解决挂起门：仅允许本人且仍为 pending 的记录；返回是否真实更新了一行
 */
export async function resolveGate(
  sessionId: string,
  userId: string,
  status: "approved" | "rejected",
): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("gates")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** 超时标记过期（内存 resolver 超时时调用） */
export async function expireGate(sessionId: string): Promise<void> {
  await getSupabase()
    .from("gates")
    .update({ status: "expired", resolved_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("status", "pending");
}
