import type { File, SpecOutput } from "../schemas";
import { getSupabase } from "../supabase/server";

/** 阶段卡片终态（与前端 StageItem 同构） */
export interface StageState {
  stage: string;
  status: "pending" | "active" | "done" | "failed";
  detail?: string;
}

/** 执行日志条目（与前端 ExecutionLog 同构，id/versionId 由前端重建时分配） */
export interface ProcessLog {
  seq: number;
  stage: string;
  phase: "start" | "end" | "progress";
  detail?: string;
  timestamp: number;
}

/** 一次流水线运行的过程数据（成功与失败运行都落库，供刷新后完整回放） */
export interface ProcessData {
  request: string;
  notes: string | null;
  spec: SpecOutput | null;
  sopId: string;
  stages: StageState[];
  logs: ProcessLog[];
  /** 分叉基准：本版本基于哪个 version_no 修改（首版为 null） */
  parentVersionNo: number | null;
  /** need_clarification 软着陆：待用户补充的澄清问题清单（003_clarify_questions.sql） */
  questions: string[] | null;
  /** 多阶段 SOP 中间产物（005_stage_outputs.sql，{schema,shell,pages} 原始代码） */
  stageOutputs: Record<string, unknown> | null;
}

export interface VersionRow {
  id: string;
  project_id: string;
  files: File[];
  version_no: number;
  is_snapshot: boolean;
  snapshot_name: string | null;
  created_at: string;
  // 过程数据（002_process_data.sql，存量行为 null）
  request: string | null;
  notes: string | null;
  spec: SpecOutput | null;
  sop_id: string | null;
  stages: StageState[] | null;
  logs: ProcessLog[] | null;
  parent_version_no: number | null;
  questions: string[] | null;
  stage_outputs: Record<string, unknown> | null;
}

export async function createVersion(
  projectId: string,
  files: File[],
  versionNo: number,
  process?: ProcessData,
): Promise<VersionRow> {
  const { data, error } = await getSupabase()
    .from("versions")
    .insert({
      project_id: projectId,
      files,
      version_no: versionNo,
      ...(process
        ? {
            request: process.request,
            notes: process.notes,
            spec: process.spec,
            sop_id: process.sopId,
            stages: process.stages,
            logs: process.logs,
            parent_version_no: process.parentVersionNo,
            questions: process.questions,
            stage_outputs: process.stageOutputs,
          }
        : {}),
    })
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
