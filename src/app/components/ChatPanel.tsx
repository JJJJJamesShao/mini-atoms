"use client";

import { useEffect, useRef, useState } from "react";
import { cannedScenarios } from "@/lib/mock/canned";
import type { ChatMessage } from "../hooks/usePipeline";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled: boolean;
}

const ROLE_STYLES: Record<ChatMessage["role"], string> = {
  user: "self-end bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900",
  assistant:
    "self-start bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100",
  system:
    "self-center bg-transparent text-xs text-neutral-400 dark:text-neutral-500",
};

/** 对话面板：消息列表 + 罐头场景快捷按钮 + 输入框 */
export default function ChatPanel({
  messages,
  onSend,
  disabled,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-neutral-200 dark:border-neutral-700">
      <div className="flex gap-2 px-4 pt-3">
        {cannedScenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled={disabled}
            onClick={() => onSend(s.input)}
            className="rounded-full border border-neutral-300 px-3 py-1 text-xs transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            {s.title}
          </button>
        ))}
      </div>

      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3"
      >
        {messages.length === 0 && (
          <p className="self-center text-xs text-neutral-400">
            点击上方快捷按钮，或输入需求开始生成
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap ${ROLE_STYLES[m.role]}`}
          >
            {m.content}
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-t border-neutral-200 p-3 dark:border-neutral-700">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法组词期间的 Enter 是确认候选词，不应触发发送
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          }}
          disabled={disabled}
          placeholder="输入需求..."
          className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-neutral-500 disabled:opacity-40 dark:border-neutral-600"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !draft.trim()}
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          发送
        </button>
      </div>
    </div>
  );
}
