"use client";

import { useEffect, useRef, useState } from "react";
import type { ExecutionLog, Project } from "../hooks/useWorkspace";
import AgentLogPanel from "./AgentLogPanel";
import VersionCard from "./VersionCard";

interface ProjectWorkspaceProps {
  project: Project;
  selectedVersionId: number | null;
  awaitingApproval: boolean;
  running: boolean;
  executionLogs: ExecutionLog[];
  onSelectVersion: (id: number) => void;
  onApprove: () => void;
  onReject: () => void;
  onSend: (text: string) => void;
}

/** 项目工作区：对话流（用户请求气泡 + 版本卡片）+ 底部输入框 */
export default function ProjectWorkspace({
  project,
  selectedVersionId,
  awaitingApproval,
  running,
  executionLogs,
  onSelectVersion,
  onApprove,
  onReject,
  onSend,
}: ProjectWorkspaceProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [project.versions.length, project.versions.map((v) => v.status).join()]);

  const submit = () => {
    const text = draft.trim();
    if (!text || running) return;
    onSend(text);
    setDraft("");
  };

  // 追问基准：当前选中版本（分叉修改时用户必须清楚自己在改哪一版）
  const selectedNo =
    project.versions.findIndex((v) => v.id === selectedVersionId) + 1;
  const selectedNeedInput =
    project.versions.find((v) => v.id === selectedVersionId)?.status ===
    "need_input";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {/* Agent 执行日志队列 */}
        {executionLogs.length > 0 && (
          <div className="rounded-lg border border-[#e5e5e5] bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
            <h3 className="mb-2 text-xs font-medium text-neutral-500">
              Agent 执行队列
            </h3>
            <AgentLogPanel logs={executionLogs} />
          </div>
        )}

        {project.versions.map((version, i) => (
          <div key={version.id} className="flex flex-col gap-2">
            <div className="max-w-[85%] self-end rounded-xl bg-neutral-900 px-3 py-1.5 text-sm whitespace-pre-wrap text-white dark:bg-neutral-100 dark:text-neutral-900">
              {version.request}
            </div>
            <VersionCard
              version={version}
              no={i + 1}
              expanded={version.id === selectedVersionId}
              awaitingApproval={awaitingApproval}
              onToggle={() => onSelectVersion(version.id)}
              onApprove={onApprove}
              onReject={onReject}
            />
          </div>
        ))}
      </div>

      <div className="border-t border-[#e5e5e5] p-3 dark:border-neutral-700">
        {selectedNo > 0 && (
          <div className="pb-2 text-xs text-[#a3a3a3]">
            {selectedNeedInput ? (
              <>
                你的补充将与{" "}
                <span className="font-medium">版本 {selectedNo}</span>{" "}
                的原始需求合并后继续
              </>
            ) : (
              <>
                追问将基于{" "}
                <span className="font-medium">版本 {selectedNo}</span>{" "}
                的代码修改
              </>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法组词期间的 Enter 是确认候选词，不应触发发送
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
            }}
            disabled={running}
            placeholder={
              selectedNeedInput
                ? "针对上方问题补充描述，例如：需要历史记录和科学计算"
                : "输入修改需求，例如：改成深色模式"
            }
            className="flex-1 rounded-xl border border-[#e5e5e5] bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-200 disabled:opacity-40 dark:border-neutral-700 dark:focus:ring-neutral-700"
          />
          <button
            type="button"
            onClick={submit}
            disabled={running || !draft.trim()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
