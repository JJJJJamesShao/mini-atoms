"use client";

import { useCallback, useRef, useState } from "react";
import { runPipeline, type Executors } from "@/lib/agent";
import { createCannedExecutors } from "@/lib/agent/canned-executors";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const initialStages = (): StageItem[] =>
  STAGE_ORDER.map((stage) => ({ stage, status: "pending" as const }));

/** 演示阶段的关键词路由：自由文本 → 罐头场景（TODO: 接入真实 LLM 后移除） */
function matchScenarioId(text: string): string | null {
  const t = text.toLowerCase();
  if (text.includes("待办") || t.includes("todo")) return "todo";
  if (text.includes("蛇") || t.includes("snake")) return "snake";
  if (text.includes("计时") || t.includes("timer")) return "timer";
  return null;
}

/**
 * 工作区状态管理：项目 + 多版本。
 * 每个版本对应一次 runPipeline 运行，approve 确认门挂起等待用户决策。
 */
export function useWorkspace() {
  const [project, setProject] = useState<Project | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(
    null,
  );
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [running, setRunning] = useState(false);

  const versionId = useRef(0);
  const lastScenarioId = useRef<string>("todo");
  const activeVersionId = useRef<number | null>(null);
  const approveResolver = useRef<((ok: boolean) => void) | null>(null);

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
    async (request: string, scenarioId: string, freshProject: boolean) => {
      const scenario = getCannedScenario(scenarioId);
      if (!scenario) return;
      lastScenarioId.current = scenarioId;

      const id = ++versionId.current;
      activeVersionId.current = id;
      const version: Version = {
        id,
        request,
        scenarioTitle: scenario.title,
        status: "running",
        stages: initialStages(),
        spec: null,
        note: null,
        html: null,
      };
      setProject((prev) =>
        prev && !freshProject
          ? { ...prev, versions: [...prev.versions, version] }
          : { title: scenario.title, versions: [version] },
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

      // 包装罐头执行器：节点调用 → 版本内执行日志，加延时让阶段逐个点亮
      const base = createCannedExecutors(scenarioId);
      const wrapped: Executors = {
        clarify: async (inp) => {
          setStage("clarify", "active");
          await sleep(500);
          const out = await base.clarify(inp);
          setStage("clarify", "done", out.summary);
          return out;
        },
        spec: async (c) => {
          setStage("spec", "active");
          await sleep(500);
          const out = await base.spec(c);
          setStage(
            "spec",
            "done",
            `${out.requirements.length} 条需求 / ${out.constraints.length} 条约束 / ${out.userStories.length} 条用户故事`,
          );
          return out;
        },
        generate: async (s, errors) => {
          setStage("generate", "active");
          if (errors?.length) {
            setStage(
              "generate",
              "active",
              `校验未通过，自动修复重试（${errors[0].rule}）`,
            );
          }
          await sleep(700);
          const out = await base.generate(s, errors);
          setStage("generate", "done", out.notes);
          return out;
        },
        verify: async (files) => {
          setStage("verify", "active");
          await sleep(500);
          const out = await base.verify(files);
          setStage(
            "verify",
            out.pass ? "done" : "failed",
            out.pass
              ? "语法与结构校验通过"
              : out.errors.map((e) => `${e.rule}: ${e.message}`).join("；"),
          );
          return out;
        },
      };

      // approve 确认门：挂起流水线，直到用户点击「确认」/「修改」
      const approver = async (specOut: SpecOutput) => {
        updateVersion(id, (v) => ({ ...v, spec: specOut, status: "awaiting" }));
        setStage("approve", "active");
        setAwaitingApproval(true);
        return new Promise<boolean>((resolve) => {
          approveResolver.current = resolve;
        });
      };

      try {
        const { events, finalState, result } = await runPipeline(
          request,
          wrapped,
          approver,
        );

        if (finalState === "done" && result) {
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
          const failEvent = [...events]
            .reverse()
            .find((e) => e.state === "fail");
          const reason = (failEvent?.payload as { reason?: string } | undefined)
            ?.reason;
          updateVersion(id, (v) => ({
            ...v,
            status: "failed",
            stages: v.stages.map((s) =>
              s.status === "active" ? { ...s, status: "failed" } : s,
            ),
            note:
              reason === "spec_rejected"
                ? "规格被拒绝，请重新描述需求。"
                : reason === "need_clarification"
                  ? "需求信息不足，请补充更多细节后重试。"
                  : "生成校验多次未通过，请换个描述重试。",
          }));
        }
      } catch (err) {
        updateVersion(id, (v) => ({
          ...v,
          status: "failed",
          note: `流水线执行出错：${err instanceof Error ? err.message : String(err)}`,
        }));
      } finally {
        setRunning(false);
        setAwaitingApproval(false);
        activeVersionId.current = null;
        approveResolver.current = null;
      }
    },
    [updateVersion],
  );

  /** 首页发起新项目；返回 false 表示未命中罐头场景（调用方给提示） */
  const startProject = useCallback(
    (request: string): boolean => {
      if (running) return false;
      const scenarioId = matchScenarioId(request);
      if (!scenarioId) return false;
      void runVersion(request, scenarioId, true);
      return true;
    },
    [running, runVersion],
  );

  /** 工作区内追加输入 → 新版本。未命中场景关键词时复用当前场景（mock 修改） */
  const sendFollowUp = useCallback(
    (request: string) => {
      if (running || !project) return;
      // TODO: 接入真实 LLM 后，修改类需求应真实重新生成，而非复用罐头产物
      const scenarioId = matchScenarioId(request) ?? lastScenarioId.current;
      void runVersion(request, scenarioId, false);
    },
    [running, project, runVersion],
  );

  /** 从 Sidebar 最近项目打开：直接加载已完成版本（TODO: 接入 Supabase 后读真实版本） */
  const openScenario = useCallback(
    (scenarioId: string) => {
      if (running) return;
      const scenario = getCannedScenario(scenarioId);
      if (!scenario) return;
      lastScenarioId.current = scenarioId;
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
    setAwaitingApproval(false);
    approveResolver.current?.(true);
    approveResolver.current = null;
  }, [updateVersion]);

  const reject = useCallback(() => {
    setAwaitingApproval(false);
    approveResolver.current?.(false);
    approveResolver.current = null;
  }, []);

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
