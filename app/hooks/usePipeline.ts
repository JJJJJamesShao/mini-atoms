"use client";

import { useCallback, useRef, useState } from "react";
import type { SpecOutput } from "@/lib/schemas";

/** 时间线上展示的阶段 */
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

  const pushMessage = useCallback(
    (role: ChatMessage["role"], content: string) => {
      const id = ++msgId.current;
      setMessages((prev) => [...prev, { id, role, content }]);
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
      setRunning(true);
      setStages(initialStages());
      setSpec(null);
      setAwaitingApproval(false);

      try {
        const response = await fetch("/api/pipeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(err || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("响应体为空");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;

            const json = trimmed.slice(6);
            if (json === "[DONE]") continue;

            try {
              const event = JSON.parse(json);
              handleEvent(event);
            } catch {
              // 忽略解析失败的行
            }
          }
        }
      } catch (err) {
        pushMessage(
          "system",
          `请求失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setRunning(false);
      }

      function handleEvent(event: Record<string, unknown>) {
        const type = event.type as string;

        if (type === "stage") {
          const state = event.state as TimelineStage;
          const payload = event.payload as Record<string, unknown>;

          if (state === "clarify") {
            setStage("clarify", "done", payload?.summary as string);
          } else if (state === "spec") {
            setStage(
              "spec",
              "done",
              `${(payload?.spec as SpecOutput)?.requirements?.length ?? 0} 条需求`,
            );
          } else if (state === "approve") {
            setStage("approve", "active");
            setSpec(payload?.spec as SpecOutput);
            setAwaitingApproval(true);
          } else if (state === "generate") {
            setStage("generate", "active");
          } else if (state === "verify") {
            const pass = (payload as Record<string, unknown>)?.pass as boolean;
            setStage(
              "verify",
              pass ? "done" : "failed",
              pass ? "校验通过" : "校验失败",
            );
          } else if (state === "done") {
            setStage("done", "done");
          } else if (state === "fail") {
            const reason = (payload as Record<string, unknown>)?.reason as string;
            pushMessage(
              "assistant",
              reason === "spec_rejected"
                ? "规格被拒绝，请重新描述需求。"
                : "生成失败，请换个描述重试。",
            );
          }
        } else if (type === "done") {
          const result = event.result as {
            files: { path: string; content: string }[];
            notes: string;
          } | null;
          if (result) {
            const html = result.files.find((f) => f.path === "index.html");
            if (html) {
              setPreview({ title: input, html: html.content });
              pushMessage("assistant", "已生成，请在右侧预览 →");
            }
          }
        } else if (type === "error") {
          pushMessage("system", `服务端错误：${event.message}`);
        }
      }
    },
    [running, pushMessage, setStage],
  );

  const approve = useCallback(() => {
    setStage("approve", "done", "用户已确认");
    setAwaitingApproval(false);
    // TODO: 接入前端确认门后，通过 SSE 反向发送确认信号
  }, [setStage]);

  const reject = useCallback(() => {
    setAwaitingApproval(false);
    // TODO: 接入前端确认门后，通过 SSE 反向发送拒绝信号
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
