"use client";

import { useCallback, useRef, useState } from "react";
import { runPipeline, type Executors } from "@/lib/agent";
import { createCannedExecutors } from "@/lib/agent/canned-executors";
import { getCannedScenario } from "@/lib/mock/canned";
import type { SpecOutput } from "@/lib/schemas";

/** 时间线上展示的阶段（fix 为内部重试，不单独列卡片） */
export const TIMELINE_STAGES = [
  "clarify",
  "spec",
  "approve",
  "generate",
  "verify",
  "done",
] as const;
export type TimelineStage = (typeof TIMELINE_STAGES)[number];

export type StageStatus = "pending" | "active" | "done" | "failed";

export interface StageItem {
  stage: TimelineStage;
  status: StageStatus;
  /** 产物摘要，点击卡片展开时展示 */
  detail?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface PreviewData {
  title: string;
  html: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 演示阶段的关键词路由：自由文本 → 罐头场景（接入真实 LLM 后移除） */
function matchScenarioId(text: string): string | null {
  const t = text.toLowerCase();
  if (text.includes("待办") || t.includes("todo")) return "todo";
  if (text.includes("蛇") || t.includes("snake")) return "snake";
  if (text.includes("计时") || t.includes("timer")) return "timer";
  return null;
}

const initialStages = (): StageItem[] =>
  TIMELINE_STAGES.map((stage) => ({ stage, status: "pending" as const }));

export function usePipeline() {
  const [stages, setStages] = useState<StageItem[]>(initialStages);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [spec, setSpec] = useState<SpecOutput | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [running, setRunning] = useState(false);

  const msgId = useRef(0);
  const approveResolver = useRef<((ok: boolean) => void) | null>(null);

  const pushMessage = useCallback(
    (role: ChatMessage["role"], content: string) => {
      msgId.current += 1;
      setMessages((prev) => [...prev, { id: msgId.current, role, content }]);
    },
    [],
  );

  const setStage = useCallback(
    (stage: TimelineStage, status: StageStatus, detail?: string) => {
      setStages((prev) =>
        prev.map((s) =>
          s.stage === stage ? { ...s, status, detail: detail ?? s.detail } : s,
        ),
      );
    },
    [],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (running) return;
      const input = text.trim();
      if (!input) return;

      pushMessage("user", input);

      const scenarioId = matchScenarioId(input);
      const scenario = scenarioId ? getCannedScenario(scenarioId) : undefined;
      if (!scenario) {
        pushMessage(
          "system",
          "演示模式暂未接入真实 LLM，请点击上方快捷按钮（或输入包含「待办 / 贪吃蛇 / 计时」的描述）选择罐头场景。",
        );
        return;
      }

      setRunning(true);
      setStages(initialStages());
      setSpec(null);
      setAwaitingApproval(false);

      // 包装罐头执行器：把节点调用转换为 UI 阶段状态，加延时让里程碑逐个点亮
      const base = createCannedExecutors(scenario.id);
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
            pushMessage(
              "system",
              `校验未通过，自动修复后重新生成（${errors[0].rule}: ${errors[0].message}）`,
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
            "done",
            out.pass
              ? "语法与结构校验通过"
              : out.errors.map((e) => `${e.rule}: ${e.message}`).join("；"),
          );
          return out;
        },
      };

      // approve 确认门：挂起流水线，直到用户点击「确认」/「修改」
      const approver = async (specOut: SpecOutput) => {
        setSpec(specOut);
        setStage("approve", "active");
        setAwaitingApproval(true);
        pushMessage("assistant", "规格已生成，请确认是否继续。");
        return new Promise<boolean>((resolve) => {
          approveResolver.current = resolve;
        });
      };

      try {
        const { events, finalState, result } = await runPipeline(
          input,
          wrapped,
          approver,
        );

        if (finalState === "done" && result) {
          setStage("done", "done", `${result.files.length} 个文件`);
          const html =
            result.files.find((f) => f.path === "index.html") ??
            result.files[0];
          setPreview({ title: scenario.title, html: html.content });
          pushMessage(
            "assistant",
            `已生成「${scenario.title}」，请在右侧预览交互 →`,
          );
        } else {
          const failEvent = [...events]
            .reverse()
            .find((e) => e.state === "fail");
          const reason = (failEvent?.payload as { reason?: string } | undefined)
            ?.reason;
          setStages((prev) =>
            prev.map((s) =>
              s.status === "active" ? { ...s, status: "failed" } : s,
            ),
          );
          if (reason === "spec_rejected") {
            pushMessage("assistant", "规格被拒绝，请重新描述需求。");
          } else if (reason === "need_clarification") {
            pushMessage("assistant", "需求信息不足，请补充更多细节后重试。");
          } else {
            pushMessage("assistant", "生成校验多次未通过，请换个描述重试。");
          }
        }
      } catch (err) {
        pushMessage(
          "system",
          `流水线执行出错：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setRunning(false);
        setAwaitingApproval(false);
        approveResolver.current = null;
      }
    },
    [running, pushMessage, setStage],
  );

  const approve = useCallback(() => {
    setStage("approve", "done", "用户已确认规格");
    setAwaitingApproval(false);
    approveResolver.current?.(true);
    approveResolver.current = null;
  }, [setStage]);

  const reject = useCallback(() => {
    setAwaitingApproval(false);
    approveResolver.current?.(false);
    approveResolver.current = null;
  }, []);

  return {
    stages,
    messages,
    spec,
    awaitingApproval,
    preview,
    running,
    sendMessage,
    approve,
    reject,
  };
}
