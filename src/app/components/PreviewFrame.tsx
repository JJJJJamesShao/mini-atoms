"use client";

import { useState } from "react";

export interface PreviewData {
  title: string;
  html: string;
}

interface PreviewFrameProps {
  preview: PreviewData | null;
}

// TODO: 预览区底部 Tab 为 mock，接入设计/总览视图后替换
const PREVIEW_TABS = ["总览", "设计", "预览"] as const;

/** 沙箱预览：顶部标题栏（项目名 + 操作）+ iframe + 底部 Tab 栏 */
export default function PreviewFrame({ preview }: PreviewFrameProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<(typeof PREVIEW_TABS)[number]>("预览");

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-[#e5e5e5] px-4 py-2 dark:border-neutral-700">
        <span className="flex-1 truncate text-sm font-medium">
          {preview ? preview.title : "预览"}
        </span>
        <button
          type="button"
          disabled={!preview}
          onClick={() => setReloadKey((k) => k + 1)}
          title="刷新预览"
          className="rounded-lg border border-[#e5e5e5] px-2 py-1 text-xs transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          ⟳ 刷新
        </button>
        {/* TODO: 分享 / 发布 / 控制台为 mock 操作，后续接入真实功能 */}
        {["分享", "发布", "控制台"].map((label) => (
          <button
            key={label}
            type="button"
            disabled
            title="演示模式暂未开放"
            className="rounded-lg border border-[#e5e5e5] px-2 py-1 text-xs opacity-40 dark:border-neutral-700"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 bg-white">
        {preview ? (
          <iframe
            key={`${preview.title}-${reloadKey}`}
            srcDoc={preview.html}
            sandbox="allow-scripts"
            title={preview.title}
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[#a3a3a3]">
            生成的应用将在这里预览
          </div>
        )}
      </div>

      <div className="flex justify-center gap-1 border-t border-[#e5e5e5] p-1.5 dark:border-neutral-700">
        {PREVIEW_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            disabled={t !== "预览"}
            title={t !== "预览" ? "演示模式暂未开放" : undefined}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              tab === t
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-[#525252] opacity-40 dark:text-neutral-400"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
