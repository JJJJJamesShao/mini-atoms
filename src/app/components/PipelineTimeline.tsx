"use client";

import type { StageItem, StageName } from "../hooks/useWorkspace";

const STAGE_LABELS: Record<StageName, string> = {
  clarify: "需求澄清",
  spec: "规格生成",
  approve: "规格确认",
  generate: "代码生成",
  verify: "校验",
  done: "完成",
};

function StatusIcon({ status }: { status: StageItem["status"] }) {
  if (status === "done")
    return <span className="text-green-600 dark:text-green-400">✓</span>;
  if (status === "failed")
    return <span className="text-red-600 dark:text-red-400">✗</span>;
  if (status === "active")
    return (
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
    );
  return (
    <span className="inline-block h-2 w-2 rounded-full border border-neutral-300 dark:border-neutral-600" />
  );
}

/** 版本卡片内的执行日志：每个阶段一行（状态图标 + 名称 + 产物摘要） */
export default function PipelineTimeline({ stages }: { stages: StageItem[] }) {
  return (
    <ol className="space-y-1.5">
      {stages.map(({ stage, status, detail }) => (
        <li
          key={stage}
          className={`flex items-baseline gap-2 text-sm transition-opacity duration-300 ${
            status === "pending" ? "opacity-40" : "opacity-100"
          }`}
        >
          <span className="relative top-[-1px] shrink-0">
            <StatusIcon status={status} />
          </span>
          <span
            className={`shrink-0 ${status === "active" ? "font-medium text-blue-600 dark:text-blue-400" : ""}`}
          >
            {STAGE_LABELS[stage]}
          </span>
          {detail && (
            <span className="truncate text-xs text-[#a3a3a3]">{detail}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
