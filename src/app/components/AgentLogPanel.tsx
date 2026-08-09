"use client";

import type { ExecutionLog } from "../hooks/useWorkspace";

const AGENT_LABELS: Record<string, { name: string; color: string }> = {
  clarify: { name: "产品经理", color: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300" },
  spec: { name: "架构师", color: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
  generate: { name: "前端工程师", color: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" },
  verify: { name: "代码审查员", color: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300" },
  approve: { name: "确认门", color: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  done: { name: "完成", color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
};

interface AgentLogPanelProps {
  logs: ExecutionLog[];
}

/** 
 * Agent 执行日志面板：按阶段分组展示，去重显示
 * 
 * 设计原则：
 * - 每个阶段只显示一次（最新状态），避免"产品经理正在执行"+"产品经理已完成"的重复感
 * - generate 阶段展示文件级产出（index.html, game.js 等）
 * - 其他阶段展示状态流转
 */
export default function AgentLogPanel({ logs }: AgentLogPanelProps) {
  if (logs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-400 dark:border-neutral-700">
        等待流水线启动...
      </div>
    );
  }

  // 按阶段分组，每组只保留最新的一条
  const latestByStage = new Map<string, ExecutionLog>();
  for (const log of logs) {
    latestByStage.set(log.stage, log);
  }

  // 按时间排序
  const groupedLogs = Array.from(latestByStage.values()).sort(
    (a, b) => a.timestamp - b.timestamp
  );

  return (
    <div className="space-y-1.5 max-h-64 overflow-y-auto">
      {groupedLogs.map((log) => {
        const label = AGENT_LABELS[log.stage];
        const time = new Date(log.timestamp).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        // 判断状态图标
        let statusIcon = "○";
        let statusClass = "text-neutral-400";
        if (log.phase === "start") {
          statusIcon = "▶";
          statusClass = "text-blue-500 animate-pulse";
        } else if (log.phase === "end") {
          statusIcon = "✓";
          statusClass = "text-green-500";
        } else if (log.phase === "progress") {
          statusIcon = "⟳";
          statusClass = "text-blue-400";
        }

        return (
          <div
            key={log.stage}
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-all hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
          >
            <span className="shrink-0 text-neutral-400 font-mono text-[10px]">{time}</span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${
                label?.color ?? "bg-neutral-100 text-neutral-600"
              }`}
            >
              {label?.name ?? log.stage}
            </span>
            <span className={`${statusClass} font-bold`}>{statusIcon}</span>
            {log.detail && (
              <span className="truncate text-neutral-500">{log.detail}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
