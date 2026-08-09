import { getSupabase } from "../supabase/server";

export type UserRole = "free" | "paid";

export interface ProfileRow {
  id: string;
  role: UserRole;
  created_at: string;
}

/** 从数据库读取用户角色（账号状态的唯一权威来源）；无记录按 free 处理 */
export async function getUserRole(userId: string): Promise<UserRole> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (error) {
    // PGRST116 = 0 rows：触发器补建前的老账号兜底为 free
    if (error.code === "PGRST116") return "free";
    throw error;
  }
  return (data as Pick<ProfileRow, "role">).role;
}

/** 设置用户角色（仅服务端，用于预创建 paid 账号） */
export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<void> {
  const { error } = await getSupabase()
    .from("profiles")
    .upsert({ id: userId, role });
  if (error) throw error;
}
