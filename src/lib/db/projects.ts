import { getSupabase } from "../supabase/server";

export interface ProjectRow {
  id: string;
  user_id: string | null;
  title: string;
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
  let query = getSupabase()
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ProjectRow[];
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
