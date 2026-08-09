"use client";

import { useState } from "react";
import type { PreviewData } from "../hooks/usePipeline";

interface PreviewFrameProps {
  preview: PreviewData | null;
}

/** 沙箱预览：iframe srcDoc 渲染生成的单文件应用 */
export default function PreviewFrame({ preview }: PreviewFrameProps) {
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-700">
        <span className="flex-1 truncate text-sm font-medium">
          {preview ? preview.title : "预览"}
        </span>
        <button
          type="button"
          disabled={!preview}
          onClick={() => setReloadKey((k) => k + 1)}
          title="刷新预览"
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          ⟳ 刷新
        </button>
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
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            生成的应用将在这里预览
          </div>
        )}
      </div>
    </div>
  );
}
