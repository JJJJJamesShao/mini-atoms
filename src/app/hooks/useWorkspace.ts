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
  "generate-schema",
  "verify-schema",
  "generate-shell",
  "verify-shell",
  "generate-pages",
  "verify-pages",
  "merge",
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

export type VersionStatus =
  | "running"
  | "awaiting"
  | "done"
  | "failed"
  /** 澄清不足软着陆：流程暂停等待用户补充信息，不是失败 */
  | "need_input";

export interface Version {
  id: number;
  /** 数据库 version_no（持久化成功后由服务端事件回填；未持久化为 null） */
  versionNo: number | null;
  /** 分叉基准：本版本基于哪个 version_no 修改（首版为 null） */
  parentVersionNo: number | null;
  /** 触发本版本的用户输入 */
  request: string;
  scenarioTitle: string;
  status: VersionStatus;
  stages: StageItem[];
  spec: SpecOutput | null;
  /** need_input 状态下，模型希望用户补充的问题清单 */
  questions?: string[] | null;
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

/** 失败原因 → 用户可读文案（与服务端 pipeline route 保持一致） */
function failReasonText(reason: string | null): string {
  switch (reason) {
    case "spec_rejected":
      return "规格被拒绝，请重新描述需求。";
    case "need_clarification":
      return "还需要你补充几点信息，流程已暂停等待你（见问题清单）。";
    default:
      return "生成校验多次未通过，请换个描述重试。";
  }
}

/** 挂起门（/api/gates/pending 返回的行，仅取前端需要的字段） */
interface PendingGate {
  session_id: string;
  project_id?: string | null;
  created_at?: string;
  payload: {
    spec?: SpecOutput;
    input?: string;
    baseVersionNo?: number | null;
  } | null;
}

/** 挂起门 → awaiting 恢复卡片（openProject 项目内恢复与首页全局恢复共用） */
function buildRestoredGateVersion(
  id: number,
  gate: PendingGate,
): Version | null {
  if (!gate.payload?.spec) return null;
  const input = gate.payload.input ?? "（刷新前未完成的生成）";
  const title = input.length > 30 ? `${input.slice(0, 30)}…` : input;
  const approveIdx = STAGE_ORDER.indexOf("approve");
  return {
    id,
    versionNo: null,
    parentVersionNo: gate.payload.baseVersionNo ?? null,
    request: input,
    scenarioTitle: title,
    status: "awaiting",
    stages: STAGE_ORDER.map((stage, i) => ({
      stage,
      status:
        i < approveIdx
          ? ("done" as const)
          : i === approveIdx
            ? ("active" as const)
            : ("pending" as const),
    })),
    spec: gate.payload.spec,
    note: "规格待确认（页面刷新后恢复）",
    html: null,
  };
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
  /** 当前工作区对应的持久化项目 id（对话迭代时传给后端追加版本；新项目/罐头演示为 null） */
  const lastPersistedProjectId = useRef<string | null>(null);
  /** 恢复模式的轮询定时器（刷新后确认，原流水线在后台续跑时轮询新版本落库） */
  const resumePollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 首轮恢复的门的创建时间（新项目轮询按 created_at 识别新建项目行） */
  const restoredGateCreatedAt = useRef<string | null>(null);
  /** 当前运行版本的阶段列表（由服务端 SOP 动态下发，默认完整流程） */
  const activeStages = useRef<readonly string[]>(STAGE_ORDER);

  const stopResumePolling = useCallback(() => {
    if (resumePollTimer.current) {
      clearInterval(resumePollTimer.current);
      resumePollTimer.current = null;
    }
  }, []);

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
    async (
      request: string,
      freshProject: boolean,
      currentHtml?: string,
      baseVersionNo?: number,
    ) => {
      const id = ++versionId.current;
      activeVersionId.current = id;
      approvalSessionId.current = null;
      activeStages.current = STAGE_ORDER;
      stopResumePolling(); // 新运行开始，停止恢复模式的轮询
      // 新项目必须先清空已持久化的项目 id，否则会被错误追加到上一个项目
      if (freshProject) lastPersistedProjectId.current = null;
      const title = request.length > 30 ? `${request.slice(0, 30)}…` : request;
      const version: Version = {
        id,
        versionNo: null,
        parentVersionNo: baseVersionNo ?? null,
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

      /** SSE 断流检测：最近一次收到任何数据的时间（含 heartbeat） */
      let lastHeartbeat = Date.now();
      /** 断流巡检定时器（finally 中清理） */
      let heartbeatChecker: ReturnType<typeof setInterval> | null = null;

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
            } else if (agentStage.startsWith("verify")) {
              // verify / verify-schema / verify-shell / verify-pages
              const out = ae.output as { pass?: boolean } | undefined;
              setStage(
                agentStage,
                out?.pass !== false ? "done" : "failed",
                ae.message ?? "校验完成",
              );
            } else {
              // 多阶段步骤（generate-schema / generate-shell / generate-pages / merge）
              setStage(agentStage, "done", ae.message ?? "完成");
            }
            return;
          }

          if (
            (ae.type === "agent:thinking" || ae.type === "agent:progress") &&
            agentStage.startsWith("generate")
          ) {
            const msg =
              ae.message ||
              (ae.percent ? `进度 ${ae.percent}%` : "正在生成...");
            setStage(agentStage, "active", msg);
            pushLog(agentStage, "progress", msg);
            return;
          }

          if (ae.type === "agent:summary" && ae.agent === "generate") {
            // 异步代码摘要：覆盖式更新，始终显示最新进度
            const msg = ae.message ?? "";
            setStage("generate", "active", msg);
            pushLog("generate", "progress", msg);
            updateVersion(id, (v) => ({ ...v, note: msg }));
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
        } else if (type === "project_created" || type === "project_updated") {
          // 持久化闭环：记录项目 id，后续对话迭代追加版本而非新建项目
          if (typeof event.projectId === "string") {
            lastPersistedProjectId.current = event.projectId;
          }
          // 回填数据库 version_no（版本卡片"基于 vN"与后续分叉基准依赖它）
          if (typeof event.versionNo === "number") {
            const versionNo = event.versionNo;
            updateVersion(id, (v) => ({ ...v, versionNo }));
          }
        } else if (type === "done") {
          const result = event.result as {
            files: { path: string; content: string }[];
            notes: string;
          } | null;
          if (event.finalState === "done" && result) {
            // 兜底：done 事件也携带 projectId（persist 失败时为 null，不覆盖）
            if (typeof event.projectId === "string") {
              lastPersistedProjectId.current = event.projectId;
            }
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
            const reason = event.reason as string | null;
            if (reason === "need_clarification") {
              // 软着陆：澄清不足不是失败——版本标记 need_input，阶段保持
              // 已执行状态（clarify 为 done、其余 pending），附问题清单引导补充
              const questions =
                (event.questions as string[] | null | undefined) ?? null;
              updateVersion(id, (v) => ({
                ...v,
                status: "need_input",
                questions,
                note: failReasonText(reason),
              }));
            } else {
              const text = failReasonText(reason);
              finalizeStages("failed", text);
              failVersion(text);
            }
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
        // 分叉基准：告诉后端本次基于哪个版本修改（版本卡片"基于 vN"）
        if (typeof baseVersionNo === "number") {
          payload.baseVersionNo = baseVersionNo;
        }
        // 如果有持久化的项目 ID，传递 projectId 让后端追加版本
        if (lastPersistedProjectId.current) {
          payload.projectId = lastPersistedProjectId.current;
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

        // 断流巡检：45s 无任何数据（含心跳）判定连接已死——收敛终态并取消读取，
        // 否则版本会永远停在 running（中间代理断连后 read() 可能悬挂）。
        // 取值依据：服务端心跳 15s 一跳且"静默≥15s 才发"，真实数据恰好落在某次
        // tick 之后时首个心跳要等两个 tick，最坏数据间隙≈30s+定时器滞后；
        // 45s（3× 间隔）留出足够容差，避免把健康连接误判为断流。
        const HEARTBEAT_TIMEOUT = 45000;
        heartbeatChecker = setInterval(() => {
          if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT) {
            if (heartbeatChecker) clearInterval(heartbeatChecker);
            console.warn("[Workspace] SSE 心跳超时，连接可能已断开");
            failVersion("连接已断开，请重试");
            void reader.cancel().catch(() => {});
          }
        }, 5000);

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
            lastHeartbeat = Date.now(); // 任何数据（含心跳）都视为存活信号
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
        if (heartbeatChecker) clearInterval(heartbeatChecker);
        setRunning(false);
        setAwaitingApproval(false);
        activeVersionId.current = null;
        approvalSessionId.current = null;
      }
    },
    [updateVersion, stopResumePolling],
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

  /** 工作区内追加输入 → 基于当前选中版本的代码生成新版本（支持回退旧版本分叉修改） */
  const sendFollowUp = useCallback(
    (request: string) => {
      if (running || !project) return;
      // 获取当前选中版本的 HTML，传给 LLM 做增量修改
      const currentVersion = project.versions.find(
        (v) => v.id === selectedVersionId,
      );
      const currentHtml = currentVersion?.html ?? undefined;
      // 软着陆续跑：选中版本在等待补充信息时，把原始需求与补充说明合并提交，
      // 让 clarify 看到完整上下文（否则模型只拿到半截回答）
      const effectiveRequest =
        currentVersion?.status === "need_input"
          ? `${currentVersion.request}\n\n补充说明：\n${request}`
          : request;
      void runVersion(
        effectiveRequest,
        false,
        currentHtml,
        currentVersion?.versionNo ?? undefined,
      );
    },
    [running, project, selectedVersionId, runVersion],
  );

  /** 从 Sidebar 打开真实项目：调 API 获取项目详情，按落库数据完整重建版本与执行日志 */
  const openProject = useCallback(
    async (projectId: string) => {
      if (running) return;
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        interface StoredVersion {
          version_no: number;
          files: { path: string; content: string }[] | null;
          request: string | null;
          notes: string | null;
          spec: SpecOutput | null;
          stages:
            { stage: string; status: StageStatus; detail?: string }[] | null;
          logs:
            | {
                seq: number;
                stage: string;
                phase: "start" | "end" | "progress";
                detail?: string;
                timestamp: number;
              }[]
            | null;
          parent_version_no: number | null;
          questions: string[] | null;
        }

        const stored: StoredVersion[] = data.versions ?? [];
        const versions: Version[] = [];
        const logs: ExecutionLog[] = [];

        for (const v of stored) {
          const id = ++versionId.current;
          const html =
            v.files?.find((f) => f.path === "index.html")?.content ??
            v.files?.[0]?.content ??
            null;
          // 存量行无过程数据：回退为全 done 阶段（仅兼容旧数据，新运行必带 stages）
          const stages: StageItem[] = v.stages?.length
            ? v.stages
                .filter((s): s is StageItem =>
                  (STAGE_ORDER as readonly string[]).includes(s.stage),
                )
                .map((s) => ({ ...s, stage: s.stage as StageName }))
            : STAGE_ORDER.map((stage) => ({
                stage,
                status: "done" as const,
              }));
          const failed = stages.some((s) => s.status === "failed");
          // 无失败但有未执行阶段 → 流程中途暂停等待用户补充（need_input 软着陆）
          const interrupted = stages.some(
            (s) => s.status === "pending" || s.status === "active",
          );
          const request = v.request ?? data.project.title;
          const title =
            request.length > 30 ? `${request.slice(0, 30)}…` : request;

          versions.push({
            id,
            versionNo: v.version_no,
            parentVersionNo: v.parent_version_no,
            request,
            scenarioTitle: title,
            status: failed ? "failed" : interrupted ? "need_input" : "done",
            stages,
            spec: v.spec,
            questions: v.questions,
            note: v.notes,
            html,
          });

          for (const l of v.logs ?? []) {
            logs.push({
              id: ++logId.current,
              versionId: id,
              stage: l.stage as StageName,
              phase: l.phase,
              detail: l.detail,
              timestamp: l.timestamp,
            });
          }
        }

        setProject({ title: data.project.title, versions });
        setExecutionLogs(logs);
        // 默认选中最新版本
        setSelectedVersionId(versions[versions.length - 1]?.id ?? null);
        // 打开已有项目后，后续对话迭代应追加到该项目
        lastPersistedProjectId.current = projectId;

        // 恢复挂起的确认门：刷新前卡在 approve 的运行，从 gates 表重建
        // "等待确认"卡片，用户可继续决策（原流水线同进程存活时可真正续跑）
        try {
          const gatesRes = await fetch(
            `/api/gates/pending?projectId=${projectId}`,
          );
          if (gatesRes.ok) {
            const { gates } = (await gatesRes.json()) as {
              gates?: PendingGate[];
            };
            const gate = gates?.[0];
            if (gate) {
              const gid = ++versionId.current;
              const restored = buildRestoredGateVersion(gid, gate);
              if (restored) {
                setProject((prev) =>
                  prev
                    ? { ...prev, versions: [...prev.versions, restored] }
                    : prev,
                );
                setSelectedVersionId(gid);
                approvalSessionId.current = gate.session_id;
                setAwaitingApproval(true);
              }
            }
          }
        } catch (err) {
          console.error("[openProject] 恢复挂起门失败:", err);
        }
      } catch (err) {
        console.error("[openProject]", err);
      }
    },
    [running],
  );

  /**
   * 全局挂起门恢复（首页挂载时调用）：首轮生成的门 project_id 为 null，
   * openProject 的项目内查询覆盖不到，必须不带 projectId 全局查询。
   * 返回 true 表示恢复了待确认卡片（调用方应切换到工作区视图）。
   */
  const restorePendingGate = useCallback(async (): Promise<boolean> => {
    if (running || project) return false;
    try {
      const res = await fetch("/api/gates/pending");
      if (!res.ok) return false;
      const { gates } = (await res.json()) as { gates?: PendingGate[] };
      const gate = gates?.find((g) => g.payload?.spec);
      if (!gate) return false;
      // follow-up 门（带 project_id）：直接走 openProject——真实版本列表 +
      // 项目内门恢复路径已存在，且 lastPersistedProjectId / 版本号基准都正确，
      // 避免合成空工作区导致续跑轮询永远等不到"新项目"
      if (gate.project_id) {
        await openProject(gate.project_id);
        return true;
      }
      // 首轮门（project_id 为 null）：项目行尚未创建，合成仅含恢复卡片的工作区
      const id = ++versionId.current;
      const restored = buildRestoredGateVersion(id, gate);
      if (!restored) return false;
      restoredGateCreatedAt.current = gate.created_at ?? null;
      setProject({ title: restored.scenarioTitle, versions: [restored] });
      setSelectedVersionId(id);
      approvalSessionId.current = gate.session_id;
      setAwaitingApproval(true);
      return true;
    } catch {
      return false;
    }
  }, [running, project, openProject]);

  /** 从 Sidebar 打开示例项目（罐头演示） */
  const openScenario = useCallback(
    (scenarioId: string) => {
      if (running) return;
      const scenario = getCannedScenario(scenarioId);
      if (!scenario) return;
      const id = ++versionId.current;
      const version: Version = {
        id,
        versionNo: null,
        parentVersionNo: null,
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
      // 罐头演示未持久化：清空项目 id，后续 follow-up 会创建新项目再迭代
      lastPersistedProjectId.current = null;
    },
    [running],
  );

  /** 恢复模式轮询：原流水线在后台续跑，检测到新版本落库后全量重建工作区 */
  const startResumePolling = useCallback(
    (projectId: string) => {
      stopResumePolling();
      // 以数据库 version_no 为基准（客户端 versions 含合成卡片，数量不可比）
      const knownMaxNo = Math.max(
        0,
        ...(project?.versions.map((v) => v.versionNo ?? 0) ?? []),
      );
      const startedAt = Date.now();
      resumePollTimer.current = setInterval(() => {
        void (async () => {
          // 最坏时长：generate 300s + 至多 5 轮 fix 重试（MAX_FIX_ATTEMPTS）
          // 每轮都可能吃满节点超时，25 分钟覆盖极端慢路径
          if (Date.now() - startedAt > 25 * 60 * 1000) {
            stopResumePolling();
            return;
          }
          try {
            const res = await fetch(`/api/projects/${projectId}`);
            if (!res.ok) return;
            const data = (await res.json()) as {
              versions?: Array<{ version_no?: number }>;
            };
            const maxNo = Math.max(
              0,
              ...(data.versions ?? []).map((v) => v.version_no ?? 0),
            );
            if (maxNo > knownMaxNo) {
              stopResumePolling();
              await openProject(projectId);
            }
          } catch {
            // 轮询失败下一轮再试
          }
        })();
      }, 5000);
    },
    [project, openProject, stopResumePolling],
  );

  /** 首轮恢复轮询：项目行尚未创建（门 project_id 为 null），
      轮询项目列表直到出现 created_at 晚于门创建时间的新项目 */
  const startNewProjectPolling = useCallback(
    (gateCreatedAt: string | null) => {
      stopResumePolling();
      const threshold = gateCreatedAt
        ? new Date(gateCreatedAt).getTime() - 5000
        : 0;
      const startedAt = Date.now();
      resumePollTimer.current = setInterval(() => {
        void (async () => {
          // 与 startResumePolling 同窗口：覆盖 5 轮 fix 的极端慢路径
          if (Date.now() - startedAt > 25 * 60 * 1000) {
            stopResumePolling();
            return;
          }
          try {
            const res = await fetch("/api/projects");
            if (!res.ok) return;
            const data = (await res.json()) as {
              projects?: Array<{ id: string; created_at?: string }>;
            };
            const created = (data.projects ?? []).find(
              (p) =>
                p.created_at && new Date(p.created_at).getTime() >= threshold,
            );
            if (created) {
              stopResumePolling();
              lastPersistedProjectId.current = created.id;
              await openProject(created.id);
            }
          } catch {
            // 轮询失败下一轮再试
          }
        })();
      }, 5000);
    },
    [openProject, stopResumePolling],
  );

  /** 用户决策 → 服务端确认门；返回门状态（live=原流水线存活并已唤醒续跑） */
  const submitApproval = useCallback(
    async (
      approved: boolean,
    ): Promise<"live" | "recorded" | "expired" | "failed"> => {
      const sessionId = approvalSessionId.current;
      setAwaitingApproval(false);
      if (!sessionId) return "failed";
      try {
        const res = await fetch("/api/pipeline/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, approved }),
        });
        // 404 = 会话不存在或已过期（区别于网络抖动，文案需诚实）
        if (res.status === 404) return "expired";
        if (!res.ok) return "failed";
        const data = (await res.json().catch(() => null)) as {
          live?: boolean;
        } | null;
        return data?.live === true ? "live" : "recorded";
      } catch {
        return "failed";
      }
    },
    [],
  );

  /** 恢复模式下的决策收尾：live 则轮询等待后台续跑结果，否则按真实原因降级 */
  const settleRestoredDecision = useCallback(
    (
      id: number | null,
      result: "live" | "recorded" | "expired" | "failed",
      approved: boolean,
    ) => {
      if (id === null) return;
      if (result === "live") {
        // follow-up 恢复：项目行已存在，按 version_no 轮询；
        // 首轮恢复：项目行未创建，按 created_at 轮询新项目
        if (lastPersistedProjectId.current) {
          startResumePolling(lastPersistedProjectId.current);
        } else {
          startNewProjectPolling(restoredGateCreatedAt.current);
        }
        return;
      }
      if (result === "expired") {
        updateVersion(id, (v) => ({
          ...v,
          status: "failed",
          note: "确认门已超时过期（30 分钟未操作），请重新发起",
        }));
        return;
      }
      if (result === "failed") {
        // 网络异常：决策可能未被记录，恢复待确认态允许重试
        updateVersion(id, (v) => ({
          ...v,
          status: "awaiting",
          note: "网络异常，你的选择可能未被记录，请重试",
        }));
        setAwaitingApproval(true);
        return;
      }
      // recorded：DB 已记决策但无存活流水线（服务重启/多实例）
      updateVersion(id, (v) => ({
        ...v,
        status: "failed",
        note: approved
          ? "原生成已随服务重启终止，请基于当前版本重新发起修改"
          : "已记录你的拒绝；原生成已随服务重启终止",
      }));
    },
    [startResumePolling, startNewProjectPolling, updateVersion],
  );

  const approve = useCallback(() => {
    // 恢复模式：刷新后没有活跃运行（activeVersionId 为 null），
    // 决策作用于当前选中的恢复卡片
    const isRestored = activeVersionId.current === null;
    const id = activeVersionId.current ?? selectedVersionId;
    if (id !== null) {
      updateVersion(id, (v) => ({
        ...v,
        status: "running",
        note: isRestored ? "已确认，后台生成中…（完成后自动刷新）" : v.note,
        stages: v.stages.map((s) =>
          s.stage === "approve"
            ? { ...s, status: "done", detail: "用户已确认规格" }
            : s,
        ),
      }));
    }
    void submitApproval(true).then((result) => {
      if (isRestored) settleRestoredDecision(id, result, true);
    });
  }, [
    updateVersion,
    submitApproval,
    selectedVersionId,
    settleRestoredDecision,
  ]);

  const reject = useCallback(() => {
    const isRestored = activeVersionId.current === null;
    const id = activeVersionId.current ?? selectedVersionId;
    if (id !== null) {
      updateVersion(id, (v) => ({
        ...v,
        status: isRestored ? v.status : "running",
        stages: v.stages.map((s) =>
          s.stage === "approve"
            ? { ...s, status: "failed", detail: "用户拒绝规格" }
            : s,
        ),
      }));
    }
    void submitApproval(false).then((result) => {
      if (isRestored) settleRestoredDecision(id, result, false);
    });
  }, [
    updateVersion,
    submitApproval,
    selectedVersionId,
    settleRestoredDecision,
  ]);

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
    restorePendingGate,
    selectVersion: setSelectedVersionId,
    approve,
    reject,
  };
}
