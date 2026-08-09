"use client";

import { useEffect, useRef, useState } from "react";

export interface PreviewData {
  title: string;
  html: string;
}

interface PreviewFrameProps {
  preview: PreviewData | null;
}

// TODO: 预览区底部 Tab 为 mock，接入设计/总览视图后替换
const PREVIEW_TABS = ["总览", "设计", "预览"] as const;

/** Loading 动画 */
function LoadingSpinner() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-[#a3a3a3]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#e5e5e5] border-t-neutral-900 dark:border-neutral-700 dark:border-t-neutral-100" />
      <span className="text-sm">正在加载…</span>
    </div>
  );
}

/** 沙箱预览：顶部标题栏 + iframe + 底部 Tab 栏 */
export default function PreviewFrame({ preview }: PreviewFrameProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<(typeof PREVIEW_TABS)[number]>("预览");
  const [iframeError, setIframeError] = useState<string | null>(null);
  const [iframeLoading, setIframeLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // html 内容变化时自动刷新 iframe
  useEffect(() => {
    if (preview?.html) {
      setReloadKey((k) => k + 1);
      setIframeError(null);
      setIframeLoading(true);
    }
  }, [preview?.html]);

  // 诊断：检查 iframe 加载状态
  useEffect(() => {
    if (!iframeRef.current || !preview?.html) return;
    const iframe = iframeRef.current;
    const timer = setTimeout(() => {
      try {
        const doc = iframe.contentDocument;
        const bodyHtml = doc?.body?.innerHTML;
        if (!bodyHtml || bodyHtml.trim().length === 0) {
          setIframeError(
            "iframe body 为空，可能是 HTML 内容无效或 sandbox 限制",
          );
        }
      } catch (e) {
        setIframeError(
          `无法访问 iframe 内容: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      setIframeLoading(false);
    }, 800);
    return () => clearTimeout(timer);
  }, [reloadKey, preview?.html]);

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-[#e5e5e5] px-4 py-2 dark:border-neutral-700">
        <span className="flex-1 truncate text-sm font-medium">
          {preview ? preview.title : "预览"}
        </span>
        <button
          type="button"
          disabled={!preview}
          onClick={() => {
            setReloadKey((k) => k + 1);
            setIframeLoading(true);
          }}
          title="刷新预览"
          className="rounded-lg border border-[#e5e5e5] px-2 py-1 text-xs transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          ⟳ 刷新
        </button>
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

      <div className="relative min-h-0 flex-1 bg-white">
        {preview ? (
          <>
            {/* Loading 遮罩 */}
            {iframeLoading && (
              <div className="absolute inset-0 z-10 bg-white/90 dark:bg-neutral-900/90">
                <LoadingSpinner />
              </div>
            )}

            {/* 诊断面板 */}
            {iframeError && !iframeLoading && (
              <div className="absolute top-2 left-2 right-2 z-20 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700 shadow-sm">
                <div className="font-semibold">渲染诊断</div>
                <div>{iframeError}</div>
                <div className="mt-1 text-[10px] text-red-500">
                  HTML 长度: {preview.html.length} | DOCTYPE:{" "}
                  {preview.html.includes("<!DOCTYPE") ? "✓" : "✗"} | html:{" "}
                  {preview.html.includes("<html") ? "✓" : "✗"} | body:{" "}
                  {preview.html.includes("<body") ? "✓" : "✗"} | script:{" "}
                  {preview.html.includes("<script") ? "✓" : "✗"}
                </div>
              </div>
            )}

            <iframe
              ref={iframeRef}
              key={`${preview.title}-${reloadKey}`}
              srcDoc={preview.html}
              sandbox="allow-scripts allow-same-origin"
              title={preview.title}
              onLoad={() => setIframeLoading(false)}
              className="h-full w-full border-0"
            />
          </>
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
