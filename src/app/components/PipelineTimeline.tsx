"use client";

import { useState } from "react";
import type { SpecOutput } from "@/lib/schemas";
import type { StageItem, TimelineStage } from "../hooks/usePipeline";
import SpecCard from "./SpecCard";

const STAGE_LABELS: Record<TimelineStage, string> = {
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
      <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-blue-500" />
    );
  return (
    <span className="inline-block h-2.5 w-2.5 rounded-full border border-neutral-300 dark:border-neutral-600" />
  );
}

interface PipelineTimelineProps {
  stages: StageItem[];
  spec: SpecOutput | null;
  awaitingApproval: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/** L1 里程碑：纵向阶段时间线，产物详情默认折叠、点击展开 */
export default function PipelineTimeline({
  stages,
  spec,
  awaitingApproval,
  onApprove,
  onReject,
}: PipelineTimelineProps) {
  const [expanded, setExpanded] = useState<TimelineStage | null>(null);

  return (
    <ol className="space-y-2 p-4">
      {stages.map(({ stage, status, detail }) => {
        const isActive = status === "active";
        const showSpecCard =
          stage === "approve" && (isActive || awaitingApproval) && spec;
        return (
          <li key={stage}>
            <button
              type="button"
              onClick={() =>
                setExpanded((cur) => (cur === stage ? null : stage))
              }
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-300 ${
                isActive
                  ? "border-blue-400 bg-blue-50 shadow-sm dark:border-blue-600 dark:bg-blue-950/40"
                  : status === "failed"
                    ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
                    : "border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
              }`}
            >
              <StatusIcon status={status} />
              <span className="flex-1 text-sm font-medium">
                {STAGE_LABELS[stage]}
              </span>
              {detail && (
                <span className="text-xs opacity-50">
                  {expanded === stage ? "收起" : "详情"}
                </span>
              )}
            </button>
            {expanded === stage && detail && (
              <p className="mx-3 mt-1 rounded-md bg-neutral-100 px-3 py-2 text-xs text-neutral-600 transition-all dark:bg-neutral-800 dark:text-neutral-300">
                {detail}
              </p>
            )}
            {showSpecCard && (
              <div className="mx-3 mt-2">
                <SpecCard
                  spec={spec}
                  onApprove={onApprove}
                  onReject={onReject}
                  disabled={!awaitingApproval}
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
