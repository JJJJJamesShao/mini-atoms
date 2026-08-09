import { getSupabase } from "../supabase/server";

export interface ProjectRow {
  id: string;
  user_id: string | null;
  title: string;
  pinned: boolean;
  created_at: string;
}

export async function createProject(
  title: string,
  userId?: string,
): Promise<ProjectRow> {
  const { data, error } = await getSupabase()
    .from("projects")
    .insert({ title, user_id: userId ?? null })
    .select()
    .single();
  if (error) throw error;
  return data as ProjectRow;
}

export async function getProjects(userId?: string): Promise<ProjectRow[]> {
  // 兼容旧数据库（无 pinned 字段）
  try {
    let query = getSupabase()
      .from("projects")
      .select("*")
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as ProjectRow[];
  } catch {
    let query = getSupabase()
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((p) => ({ ...p, pinned: false })) as ProjectRow[];
  }
}

/** 按用户查询项目；user_id 为 null 的视为历史演示数据，对所有登录用户可见 */
export async function getProjectsForUser(
  userId: string,
): Promise<ProjectRow[]> {
  // 兼容旧数据库（无 pinned 字段）：先尝试带 pinned 排序，失败时回退
  try {
    const { data, error } = await getSupabase()
      .from("projects")
      .select("*")
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as ProjectRow[];
  } catch {
    // 旧数据库回退：不带 pinned 排序
    const { data, error } = await getSupabase()
      .from("projects")
      .select("*")
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((p) => ({ ...p, pinned: false })) as ProjectRow[];
  }
}

export async function getProject(id: string): Promise<ProjectRow> {
  const { data, error } = await getSupabase()
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as ProjectRow;
}

/** 删除项目（级联删除版本和消息由数据库外键处理） */
export async function deleteProject(id: string, userId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("projects")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

/** 切换项目 pinned 状态（旧数据库无 pinned 字段时会静默失败） */
export async function togglePinProject(
  id: string,
  userId: string,
  pinned: boolean,
): Promise<void> {
  const { error } = await getSupabase()
    .from("projects")
    .update({ pinned })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}
