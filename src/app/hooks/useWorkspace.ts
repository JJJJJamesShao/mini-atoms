"use client";

import { useCallback, useRef, useState } from "react";
import { getCannedScenario } from "@/lib/mock/canned";
import type { SpecOutput } from "@/lib/schemas";

/** 执行日志展示的阶段（fix 为内部重试，不单独列出） */
export const STAGE_ORDER = [
  "clarify",
  "spec",
  "approve",
  "generate",
  "verify",
  "done",
] as const;
export type StageName = (typeof STAGE_ORDER)[number];

export type StageStatus = "pending" | "active" | "done" | "failed";

export interface StageItem {
  stage: StageName;
  status: StageStatus;
  /** 产物摘要 */
  detail?: string;
}

export type VersionStatus = "running" | "awaiting" | "done" | "failed";

export interface Version {
  id: number;
  /** 触发本版本的用户输入 */
  request: string;
  scenarioTitle: string;
  status: VersionStatus;
  stages: StageItem[];
  spec: SpecOutput | null;
  /** 结果说明（成功产物 notes / 失败原因） */
  note: string | null;
  html: string | null;
}

export interface Project {
  title: string;
  versions: Version[];
}

const initialStages = (): StageItem[] =>
  STAGE_ORDER.map((stage) => ({ stage, status: "pending" as const }));

/** 失败原因 → 用户可读文案 */
function failReasonText(reason: string | null): string {
  switch (reason) {
    case "spec_rejected":
      return "规格被拒绝，请重新描述需求。";
    case "need_clarification":
      return "需求信息不足，请补充更多细节后重试。";
    default:
      return "生成校验多次未通过，请换个描述重试。";
  }
}

/**
 * 工作区状态管理：项目 + 多版本。
 * 每个版本对应一次 /api/pipeline SSE 运行，approve 确认门经
 * /api/pipeline/confirm 注入用户决策。Sidebar 罐头演示仍走本地数据（零成本）。
 */
export function useWorkspace() {
  const [project, setProject] = useState<Project | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(
    null,
  );
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [running, setRunning] = useState(false);

  const versionId = useRef(0);
  const activeVersionId = useRef<number | null>(null);
  /** 当前挂起审批的会话 id（服务端确认门凭证） */
  const approvalSessionId = useRef<string | null>(null);

  const updateVersion = useCallback(
    (id: number, fn: (v: Version) => Version) => {
      setProject((prev) =>
        prev
          ? {
              ...prev,
              versions: prev.versions.map((v) => (v.id === id ? fn(v) : v)),
            }
          : prev,
      );
    },
    [],
  );

  const runVersion = useCallback(
    async (request: string, freshProject: boolean) => {
      const id = ++versionId.current;
      activeVersionId.current = id;
      approvalSessionId.current = null;

      const title =
        request.length > 30 ? `${request.slice(0, 30)}…` : request;
      const version: Version = {
        id,
        request,
        scenarioTitle: title,
        status: "running",
        stages: initialStages(),
        spec: null,
        note: null,
        html: null,
      };
      setProject((prev) =>
        prev && !freshProject
          ? { ...prev, versions: [...prev.versions, version] }
          : { title, versions: [version] },
      );
      setSelectedVersionId(id);
      setRunning(true);
      setAwaitingApproval(false);

      const setStage = (
        stage: StageName,
        status: StageStatus,
        detail?: string,
      ) =>
        updateVersion(id, (v) => ({
          ...v,
          stages: v.stages.map((s) =>
            s.stage === stage
              ? { ...s, status, detail: detail ?? s.detail }
              : s,
          ),
        }));

      const failVersion = (note: string) =>
        updateVersion(id, (v) => ({
          ...v,
          status: "failed",
          stages: v.stages.map((s) =>
            s.status === "active" ? { ...s, status: "failed" } : s,
          ),
          note,
        }));

      const handleEvent = (event: Record<string, unknown>) => {
        const type = event.type as string;

        if (type === "stage") {
          const state = event.state as StageName;
          if (!STAGE_ORDER.includes(state)) return;

          if (event.phase === "start") {
            setStage(
              state,
              "active",
              event.isRetry ? "校验未通过，自动修复重试" : undefined,
            );
            return;
          }

          // phase === "end"
          if (state === "clarify") {
            setStage("clarify", "done", event.summary as string);
          } else if (state === "spec") {
            const spec = event.spec as SpecOutput | undefined;
            setStage(
              "spec",
              "done",
              spec
                ? `${spec.requirements.length} 条需求 / ${spec.constraints.length} 条约束 / ${spec.userStories.length} 条用户故事`
                : undefined,
            );
          } else if (state === "generate") {
            setStage("generate", "done", event.notes as string);
          } else if (state === "verify") {
            const pass = event.pass as boolean;
            const errors = event.errors as
              | { rule: string; message: string }[]
              | undefined;
            setStage(
              "verify",
              pass ? "done" : "failed",
              pass
                ? "语法与结构校验通过"
                : errors?.map((e) => `${e.rule}: ${e.message}`).join("；"),
            );
          }
        } else if (type === "approve_needed") {
          approvalSessionId.current = event.sessionId as string;
          updateVersion(id, (v) => ({
            ...v,
            spec: event.spec as SpecOutput,
            status: "awaiting",
          }));
          setStage("approve", "active");
          setAwaitingApproval(true);
        } else if (type === "done") {
          const result = event.result as {
            files: { path: string; content: string }[];
            notes: string;
          } | null;

          if (event.finalState === "done" && result) {
            setStage("done", "done", `${result.files.length} 个文件`);
            const html =
              result.files.find((f) => f.path === "index.html") ??
              result.files[0];
            updateVersion(id, (v) => ({
              ...v,
              status: "done",
              html: html.content,
              note: result.notes,
            }));
          } else {
            failVersion(failReasonText(event.reason as string | null));
          }
        } else if (type === "persist_error") {
          updateVersion(id, (v) => ({
            ...v,
            note: `${v.note ?? ""}（保存到云端失败：${event.message}）`,
          }));
        } else if (type === "error") {
          failVersion(`服务端错误：${event.message}`);
        }
      };

      try {
        const response = await fetch("/api/pipeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: request }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(
            (data as { message?: string } | null)?.message ??
              `请求失败（HTTP ${response.status}）`,
          );
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("响应体为空");

        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            try {
              handleEvent(JSON.parse(trimmed.slice(6)));
            } catch {
              // 忽略解析失败的行
            }
          }
        }
      } catch (err) {
        failVersion(
          err instanceof Error ? err.message : `请求出错：${String(err)}`,
        );
      } finally {
        setRunning(false);
        setAwaitingApproval(false);
        activeVersionId.current = null;
        approvalSessionId.current = null;
      }
    },
    [updateVersion],
  );

  /** 首页发起新项目：任何输入都直接交给后端 LLM 处理 */
  const startProject = useCallback(
    (request: string): boolean => {
      if (running) return false;
      void runVersion(request, true);
      return true;
    },
    [running, runVersion],
  );

  /** 工作区内追加输入 → 调 API 生成新版本 */
  const sendFollowUp = useCallback(
    (request: string) => {
      if (running || !project) return;
      void runVersion(request, false);
    },
    [running, project, runVersion],
  );

  /** 从 Sidebar 最近项目打开：加载本地罐头演示（零成本，免费账号可用） */
  const openScenario = useCallback(
    (scenarioId: string) => {
      if (running) return;
      const scenario = getCannedScenario(scenarioId);
      if (!scenario) return;
      const id = ++versionId.current;
      const version: Version = {
        id,
        request: scenario.input,
        scenarioTitle: scenario.title,
        status: "done",
        stages: STAGE_ORDER.map((stage) => ({
          stage,
          status: "done" as const,
        })),
        spec: scenario.spec,
        note: scenario.generate.notes,
        html: scenario.generate.files[0].content,
      };
      setProject({ title: scenario.title, versions: [version] });
      setSelectedVersionId(id);
    },
    [running],
  );

  /** 用户决策 → 服务端确认门 */
  const submitApproval = useCallback(
    (approved: boolean) => {
      const sessionId = approvalSessionId.current;
      setAwaitingApproval(false);
      if (!sessionId) return;
      void fetch("/api/pipeline/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, approved }),
      });
    },
    [],
  );

  const approve = useCallback(() => {
    const id = activeVersionId.current;
    if (id !== null) {
      updateVersion(id, (v) => ({
        ...v,
        status: "running",
        stages: v.stages.map((s) =>
          s.stage === "approve"
            ? { ...s, status: "done", detail: "用户已确认规格" }
            : s,
        ),
      }));
    }
    submitApproval(true);
  }, [updateVersion, submitApproval]);

  const reject = useCallback(() => {
    const id = activeVersionId.current;
    if (id !== null) {
      updateVersion(id, (v) => ({
        ...v,
        status: "running",
        stages: v.stages.map((s) =>
          s.stage === "approve"
            ? { ...s, status: "failed", detail: "用户拒绝规格" }
            : s,
        ),
      }));
    }
    submitApproval(false);
  }, [updateVersion, submitApproval]);

  return {
    project,
    selectedVersionId,
    awaitingApproval,
    running,
    startProject,
    sendFollowUp,
    openScenario,
    selectVersion: setSelectedVersionId,
    approve,
    reject,
  };
}
