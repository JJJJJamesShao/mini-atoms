import { getSupabase } from "../supabase/server";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRow {
  id: string;
  project_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

export async function createMessage(
  projectId: string,
  role: MessageRole,
  content: string,
): Promise<MessageRow> {
  const { data, error } = await getSupabase()
    .from("messages")
    .insert({ project_id: projectId, role, content })
    .select()
    .single();
  if (error) throw error;
  return data as MessageRow;
}

export async function getMessages(projectId: string): Promise<MessageRow[]> {
  const { data, error } = await getSupabase()
    .from("messages")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MessageRow[];
}
