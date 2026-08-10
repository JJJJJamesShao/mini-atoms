"use client";

import { useCallback, useRef, useState } from "react";
import { getCannedScenario } from "@/lib/mock/canned";
import type { SpecOutput } from "@/lib/schemas";

/** 阶段全集与默认值（完整 web-app 流程）；实际版本的阶段由服务端 SOP 动态下发（fix 为内部步骤，不展示） */
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
  quality?: {
    score: number;
    checks: Array<{ name: string; passed: boolean }>;
  };
}

export interface ExecutionLog {
  id: number;
  versionId: number;
  stage: StageName;
  phase: "start" | "end" | "progress";
  detail?: string;
  timestamp: number;
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
  /** 全局执行日志：所有版本的阶段事件统一队列 */
  const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([]);

  const versionId = useRef(0);
  const logId = useRef(0);
  const activeVersionId = useRef<number | null>(null);
  /** 当前挂起审批的会话 id（服务端确认门凭证） */
  const approvalSessionId = useRef<string | null>(null);
  /** 当前运行版本的阶段列表（由服务端 SOP 动态下发，默认完整流程） */
  const activeStages = useRef<readonly string[]>(STAGE_ORDER);

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
    async (request: string, freshProject: boolean, currentHtml?: string) => {
      const id = ++versionId.current;
      activeVersionId.current = id;
      approvalSessionId.current = null;
      activeStages.current = STAGE_ORDER;

      const title = request.length > 30 ? `${request.slice(0, 30)}…` : request;
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

      /** 推送全局执行日志 */
      const pushLog = (
        stage: StageName,
        phase: "start" | "end" | "progress",
        detail?: string,
      ) => {
        const entry: ExecutionLog = {
          id: ++logId.current,
          versionId: id,
          stage,
          phase,
          detail,
          timestamp: Date.now(),
        };
        setExecutionLogs((prev) => [...prev, entry]);
      };

      const handleEvent = (event: Record<string, unknown>) => {
        const type = event.type as string;

        // 辅助：强制同步所有未完成的 stages
        const finalizeStages = (status: StageStatus, note?: string) => {
          updateVersion(id, (v) => ({
            ...v,
            stages: v.stages.map((s) => {
              if (s.status === "active" || s.status === "pending") {
                return { ...s, status, detail: note ?? s.detail };
              }
              return s;
            }),
          }));
        };

        if (type === "start") {
          // 服务端 SOP 路由结果：动态生成阶段卡片，版本标题标注 SOP 名称
          const sop = event.sop as
            { id: string; name: string; steps: string[] } | undefined;
          if (sop) {
            const steps = sop.steps.filter((s): s is StageName =>
              (STAGE_ORDER as readonly string[]).includes(s),
            );
            activeStages.current = steps;
            updateVersion(id, (v) => ({
              ...v,
              scenarioTitle: `【${sop.name}】${v.scenarioTitle}`,
              stages: steps.map((stage) => ({
                stage,
                status: "pending" as const,
              })),
            }));
          }
          return;
        }

        if (type === "agent_event") {
          const ae = event.payload as {
            type: string;
            agent: string;
            role?: string;
            message?: string;
            percent?: number;
            output?: unknown;
            error?: string;
          };
          const agentStage = ae.agent as StageName;

          if (
            ae.type === "agent:start" &&
            activeStages.current.includes(agentStage)
          ) {
            setStage(agentStage, "active", ae.role);
            pushLog(agentStage, "start", ae.role);
            return;
          }

          if (
            ae.type === "agent:complete" &&
            activeStages.current.includes(agentStage)
          ) {
            pushLog(agentStage, "end", ae.message);
            if (agentStage === "clarify") {
              const out = ae.output as { summary?: string } | undefined;
              setStage("clarify", "done", out?.summary ?? "需求已澄清");
            } else if (agentStage === "spec") {
              const out = ae.output as SpecOutput | undefined;
              setStage(
                "spec",
                "done",
                out
                  ? `${out.requirements.length} 条需求 / ${out.constraints.length} 条约束`
                  : "规格已生成",
              );
            } else if (agentStage === "generate") {
              setStage("generate", "done", ae.message ?? "代码已生成");
            } else if (agentStage === "verify") {
              const out = ae.output as { pass?: boolean } | undefined;
              setStage(
                "verify",
                out?.pass !== false ? "done" : "failed",
                ae.message ?? "校验完成",
              );
            }
            return;
          }

          if (
            (ae.type === "agent:thinking" || ae.type === "agent:progress") &&
            ae.agent === "generate"
          ) {
            const msg =
              ae.message ||
              (ae.percent ? `进度 ${ae.percent}%` : "正在生成...");
            setStage("generate", "active", msg);
            pushLog("generate", "progress", msg);
            return;
          }

          if (ae.type === "agent:error") {
            setStage(
              agentStage,
              "failed",
              ae.error ?? ae.message ?? "执行出错",
            );
            return;
          }

          if (ae.type === "file:generated") {
            const file = ae.output as
              { path: string; size: number } | undefined;
            pushLog(
              agentStage,
              "progress",
              `📄 ${file?.path ?? "文件"}（${file?.size ?? 0} 字符）`,
            );
            return;
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
            // 强制同步所有未完成的 stages，防止状态不一致
            finalizeStages("done", result.notes);
            setStage("done", "done", result.notes);
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
            const reason = failReasonText(event.reason as string | null);
            finalizeStages("failed", reason);
            failVersion(reason);
          }
        } else if (type === "persist_error") {
          updateVersion(id, (v) => ({
            ...v,
            note: `${v.note ?? ""}（保存到云端失败：${event.message}）`,
          }));
        } else if (type === "error") {
          const msg = `服务端错误：${event.message}`;
          finalizeStages("failed", msg);
          failVersion(msg);
        }
      };

      try {
        const payload: Record<string, unknown> = { input: request };
        if (currentHtml) {
          payload.currentFiles = [{ path: "index.html", content: currentHtml }];
        }

        const response = await fetch("/api/pipeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

  /** 工作区内追加输入 → 基于当前代码生成新版本 */
  const sendFollowUp = useCallback(
    (request: string) => {
      if (running || !project) return;
      // 获取当前选中版本的 HTML，传给 LLM 做增量修改
      const currentVersion = project.versions.find(
        (v) => v.id === selectedVersionId,
      );
      const currentHtml = currentVersion?.html ?? undefined;
      void runVersion(request, false, currentHtml);
    },
    [running, project, selectedVersionId, runVersion],
  );

  /** 从 Sidebar 打开真实项目：调 API 获取项目详情 */
  const openProject = useCallback(
    async (projectId: string) => {
      if (running) return;
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const id = ++versionId.current;
        const version: Version = {
          id,
          request: data.project.title,
          scenarioTitle: data.project.title,
          status: "done",
          stages: STAGE_ORDER.map((stage) => ({
            stage,
            status: "done" as const,
          })),
          spec: null,
          note: `创建于 ${new Date(data.project.created_at).toLocaleDateString()}`,
          html: data.latestHtml,
        };
        setProject({ title: data.project.title, versions: [version] });
        setSelectedVersionId(id);
      } catch (err) {
        console.error("[openProject]", err);
      }
    },
    [running],
  );

  /** 从 Sidebar 打开示例项目（罐头演示） */
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
  const submitApproval = useCallback((approved: boolean) => {
    const sessionId = approvalSessionId.current;
    setAwaitingApproval(false);
    if (!sessionId) return;
    void fetch("/api/pipeline/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, approved }),
    });
  }, []);

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
    executionLogs,
    startProject,
    sendFollowUp,
    openProject,
    openScenario,
    selectVersion: setSelectedVersionId,
    approve,
    reject,
  };
}
