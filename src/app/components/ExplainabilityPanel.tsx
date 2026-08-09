"use client";

import { useState } from "react";

interface AgentThought {
  agent: string;
  role: string;
  timestamp: string;
  type: "thinking" | "decision" | "action" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

interface AgentMemorySnapshot {
  agent: string;
  memory: Array<{
    topic: string;
    messages: Array<{ role: string; content: string }>;
  }>;
}

interface ExplainabilityPanelProps {
  thoughts: AgentThought[];
  memories?: AgentMemorySnapshot[];
}

/** AI 可解释性面板：展示 Agent 决策过程与记忆状态 */
export default function ExplainabilityPanel({
  thoughts,
  memories,
}: ExplainabilityPanelProps) {
  const [activeTab, setActiveTab] = useState<"thoughts" | "memory">("thoughts");
  const [expandedThought, setExpandedThought] = useState<number | null>(null);

  const getTypeColor = (type: AgentThought["type"]) => {
    switch (type) {
      case "thinking":
        return "text-blue-600 bg-blue-50";
      case "decision":
        return "text-green-600 bg-green-50";
      case "action":
        return "text-purple-600 bg-purple-50";
      case "error":
        return "text-red-600 bg-red-50";
    }
  };

  return (
    <div className="flex h-full flex-col border-l border-[#e5e5e5] bg-white dark:border-neutral-700 dark:bg-neutral-900">
      {/* Tab 切换 */}
      <div className="flex border-b border-[#e5e5e5] dark:border-neutral-700">
        <button
          type="button"
          onClick={() => setActiveTab("thoughts")}
          className={`flex-1 px-3 py-2 text-xs font-medium ${
            activeTab === "thoughts"
              ? "border-b-2 border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
              : "text-[#a3a3a3]"
          }`}
        >
          🤖 AI 思考过程 ({thoughts.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("memory")}
          className={`flex-1 px-3 py-2 text-xs font-medium ${
            activeTab === "memory"
              ? "border-b-2 border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
              : "text-[#a3a3a3]"
          }`}
        >
          🧠 记忆状态
        </button>
      </div>

      {/* 思考过程 */}
      {activeTab === "thoughts" && (
        <div className="flex-1 overflow-y-auto p-3">
          {thoughts.length === 0 && (
            <div className="text-center text-xs text-[#a3a3a3]">
              等待 AI 开始思考...
            </div>
          )}
          {thoughts.map((thought, i) => (
            <div
              key={i}
              className="mb-2 cursor-pointer rounded-lg border border-[#e5e5e5] p-2 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              onClick={() =>
                setExpandedThought(expandedThought === i ? null : i)
              }
            >
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${getTypeColor(thought.type)}`}
                >
                  {thought.type === "thinking" && "💭"}
                  {thought.type === "decision" && "✅"}
                  {thought.type === "action" && "⚡"}
                  {thought.type === "error" && "❌"}
                </span>
                <span className="text-xs font-medium">{thought.agent}</span>
                <span className="ml-auto text-[10px] text-[#a3a3a3]">
                  {thought.timestamp}
                </span>
              </div>
              <p className="mt-1 text-xs text-[#525252] dark:text-neutral-300">
                {thought.message}
              </p>
              {expandedThought === i && thought.metadata && (
                <div className="mt-2 rounded bg-neutral-100 p-2 dark:bg-neutral-800">
                  <pre className="max-h-32 overflow-auto text-[10px] text-[#525252] dark:text-neutral-300">
                    {JSON.stringify(thought.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 记忆状态 */}
      {activeTab === "memory" && memories && (
        <div className="flex-1 overflow-y-auto p-3">
          {memories.map((mem) => (
            <div
              key={mem.agent}
              className="mb-3 rounded-lg border border-[#e5e5e5] p-2 dark:border-neutral-700"
            >
              <div className="text-xs font-medium">{mem.agent}</div>
              {mem.memory.map((topic, ti) => (
                <div key={ti} className="mt-1">
                  <div className="text-[10px] text-[#a3a3a3]">
                    Topic: {topic.topic}
                  </div>
                  <div className="mt-1 space-y-1">
                    {topic.messages.slice(-3).map((msg, mi) => (
                      <div
                        key={mi}
                        className={`rounded px-2 py-1 text-[10px] ${
                          msg.role === "user"
                            ? "bg-blue-50 text-blue-700"
                            : "bg-neutral-100 text-neutral-600"
                        }`}
                      >
                        <span className="font-medium">{msg.role}:</span>{" "}
                        {msg.content.slice(0, 100)}
                        {msg.content.length > 100 && "..."}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
