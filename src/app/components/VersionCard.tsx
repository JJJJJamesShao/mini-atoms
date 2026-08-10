"use client";

import { useEffect, useState } from "react";
import type { Version } from "../hooks/useWorkspace";
import PipelineTimeline from "./PipelineTimeline";
import SpecCard from "./SpecCard";

/** 运行耗时：每秒自增，仅在 running 状态挂载（卸载即清理定时器） */
function RunningElapsed() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span>AI 正在思考中…（已运行 {elapsed}s）</span>;
}

const STATUS_PILLS: Record<
  Version["status"],
  { label: string; className: string }
> = {
  running: {
    label: "执行中",
    className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  },
  awaiting: {
    label: "等待确认",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  done: {
    label: "已完成",
    className:
      "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  },
  failed: {
    label: "已失败",
    className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  need_input: {
    label: "待补充",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
};

/** 质量评分组件 */
function QualityBadge({ score }: { score: number }) {
  const color =
    score >= 90
      ? "bg-green-100 text-green-700"
      : score >= 70
        ? "bg-amber-100 text-amber-700"
        : "bg-red-100 text-red-700";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      质量 {score}
    </span>
  );
}

interface VersionCardProps {
  version: Version;
  /** 版本序号（从 1 开始） */
  no: number;
  expanded: boolean;
  awaitingApproval: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
}

/** 版本卡片：标题 + 状态标签 + 可折叠执行日志 + 操作按钮（mock） */
export default function VersionCard({
  version,
  no,
  expanded,
  awaitingApproval,
  onToggle,
  onApprove,
  onReject,
}: VersionCardProps) {
  const pill = STATUS_PILLS[version.status];
  const doneSteps = version.stages.filter((s) => s.status === "done").length;
  const showSpecCard =
    version.status === "awaiting" && awaitingApproval && version.spec;

  return (
    <div className="rounded-xl border border-[#e5e5e5] bg-white shadow-sm transition-shadow hover:shadow-md dark:border-neutral-700 dark:bg-neutral-900">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold">版本 {no}</span>
        {version.parentVersionNo != null && (
          <span
            className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
            title={`本版本基于版本 ${version.parentVersionNo} 的代码修改`}
          >
            基于 v{version.parentVersionNo}
          </span>
        )}
        <span className="truncate text-sm text-[#525252] dark:text-neutral-400">
          {version.scenarioTitle}
        </span>
        {version.status === "done" && version.quality && (
          <QualityBadge score={version.quality.score} />
        )}
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs ${pill.className}`}
        >
          {pill.label}
        </span>
        <span className="shrink-0 text-xs text-[#a3a3a3]">
          已处理 {doneSteps} 步
        </span>
        <span className="shrink-0 text-xs text-[#a3a3a3]">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {/* 运行中：显示实时代码摘要（异步摘要器推送，覆盖式更新）+ 已耗时 */}
      {version.status === "running" && (
        <div className="flex items-center gap-1.5 px-4 pb-2 text-xs text-blue-600 dark:text-blue-400">
          <span className="animate-pulse">●</span>
          <RunningElapsed />
          {version.note && (
            <span className="truncate text-neutral-400 dark:text-neutral-500">
              · {version.note}
            </span>
          )}
        </div>
      )}

      {/* 断流失败：常驻提示（note 只在展开时可见，断流需要一眼看到） */}
      {version.status === "failed" && version.note?.includes("连接已断开") && (
        <div className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">
          连接已断开，请重试或刷新页面
        </div>
      )}

      {expanded && (
        <div className="border-t border-[#e5e5e5] px-4 py-3 dark:border-neutral-700">
          <PipelineTimeline stages={version.stages} />

          {showSpecCard && (
            <div className="mt-3">
              <SpecCard
                spec={version.spec!}
                onApprove={onApprove}
                onReject={onReject}
              />
            </div>
          )}

          {/* 软着陆引导：澄清不足时列出模型想确认的问题，引导用户补充而非判负 */}
          {version.status === "need_input" &&
            version.questions &&
            version.questions.length > 0 && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  请补充以下信息，然后在下方输入框继续：
                </p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-amber-700 dark:text-amber-400">
                  {version.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ol>
              </div>
            )}

          {version.note && (
            <p
              className={`mt-3 text-xs ${
                version.status === "failed"
                  ? "text-red-600 dark:text-red-400"
                  : "text-[#525252] dark:text-neutral-400"
              }`}
            >
              {version.note}
            </p>
          )}

          {/* TODO: 继续执行 / 升级为 mock 操作，接入真实 LLM 后实现 */}
          <div className="mt-3 flex gap-2">
            {["继续执行", "升级"].map((label) => (
              <button
                key={label}
                type="button"
                disabled
                title="演示模式暂未开放"
                className="rounded-lg border border-[#e5e5e5] px-3 py-1 text-xs opacity-40 dark:border-neutral-700"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
