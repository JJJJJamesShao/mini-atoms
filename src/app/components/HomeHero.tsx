"use client";

import { useState } from "react";
import { cannedScenarios } from "@/lib/mock/canned";
import { MOCK_BUILD_MODES, MOCK_THEMES, MOCK_USER } from "../mock";

interface HomeHeroProps {
  /** 返回 false 表示未命中罐头场景，由本组件给出提示 */
  onSubmit: (text: string) => boolean;
}

/** 首页：居中大输入区（Atoms 风格），无项目时展示 */
export default function HomeHero({ onSubmit }: HomeHeroProps) {
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const ok = onSubmit(text);
    if (ok) {
      setDraft("");
      setHint(null);
    } else {
      setHint("演示模式暂未接入真实 LLM，试试「待办清单 / 贪吃蛇 / 计时器」");
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
      {/* TODO: 接入 Supabase Auth 后替换为真实头像与用户名 */}
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          {MOCK_USER.initials}
        </span>
        <span className="text-sm text-[#525252] dark:text-neutral-400">
          {MOCK_USER.name}
        </span>
      </div>

      <h1 className="text-3xl font-bold tracking-tight">
        你想创造什么，{MOCK_USER.name}？
      </h1>

      <div className="w-full max-w-xl">
        <div className="rounded-xl border border-[#e5e5e5] bg-white shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-2 focus-within:ring-neutral-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:ring-neutral-700">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法组词期间的 Enter 是确认候选词，不应触发提交
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="描述你的需求，例如：做一个待办清单"
            rows={3}
            className="w-full resize-none rounded-t-xl bg-transparent px-4 pt-3 text-sm outline-none placeholder:text-[#a3a3a3]"
          />
          <div className="flex items-center gap-2 px-3 pb-2">
            {/* TODO: + 附件与 @提及 为 mock，接入真实 LLM/资源系统后实现 */}
            <button
              type="button"
              disabled
              title="演示模式暂未开放"
              className="rounded-lg border border-[#e5e5e5] px-2 py-1 text-sm opacity-40 dark:border-neutral-700"
            >
              +
            </button>
            <button
              type="button"
              disabled
              title="演示模式暂未开放"
              className="rounded-lg border border-[#e5e5e5] px-2 py-1 text-xs opacity-40 dark:border-neutral-700"
            >
              主题：{MOCK_THEMES[0]} ▾
            </button>
            <button
              type="button"
              disabled
              title="演示模式暂未开放"
              className="rounded-lg border border-[#e5e5e5] px-2 py-1 text-xs opacity-40 dark:border-neutral-700"
            >
              构建：{MOCK_BUILD_MODES[0]} ▾
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="ml-auto rounded-lg bg-neutral-900 px-4 py-1.5 text-sm text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              发送
            </button>
          </div>
        </div>
        {hint && (
          <p className="mt-2 text-center text-xs text-amber-600">{hint}</p>
        )}

        <div className="mt-4 flex justify-center gap-2">
          {cannedScenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSubmit(s.input)}
              className="rounded-full border border-[#e5e5e5] px-3 py-1 text-xs text-[#525252] transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              {s.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
