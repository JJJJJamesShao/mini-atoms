import type { File } from "../schemas";
import { getSupabase } from "../supabase/server";

export interface VersionRow {
  id: string;
  project_id: string;
  files: File[];
  version_no: number;
  is_snapshot: boolean;
  snapshot_name: string | null;
  created_at: string;
}

export async function createVersion(
  projectId: string,
  files: File[],
  versionNo: number,
): Promise<VersionRow> {
  const { data, error } = await getSupabase()
    .from("versions")
    .insert({ project_id: projectId, files, version_no: versionNo })
    .select()
    .single();
  if (error) throw error;
  return data as VersionRow;
}

export async function getVersions(projectId: string): Promise<VersionRow[]> {
  const { data, error } = await getSupabase()
    .from("versions")
    .select("*")
    .eq("project_id", projectId)
    .order("version_no", { ascending: true });
  if (error) throw error;
  return (data ?? []) as VersionRow[];
}
