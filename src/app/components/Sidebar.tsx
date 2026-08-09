"use client";

import { MOCK_RECENT_PROJECTS } from "../mock";

interface SidebarProps {
  onHome: () => void;
  onOpenProject: (scenarioId: string) => void;
}

const NAV_ITEMS = [
  { icon: "🏠", label: "首页", key: "home" },
  // TODO: 接入资源系统后替换（当前仅占位）
  { icon: "📦", label: "资源", key: "resources" },
  // TODO: 接入 Supabase 后替换为真实项目页（当前仅占位）
  { icon: "📁", label: "我的项目", key: "projects" },
] as const;

/** 左侧导航边栏：Logo + 导航 + 最近项目（mock）+ 底部操作区（占位） */
export default function Sidebar({ onHome, onOpenProject }: SidebarProps) {
  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-[#e5e5e5] bg-[#f5f5f5] dark:border-neutral-800 dark:bg-neutral-950">
      <div className="px-4 pt-4 pb-3 text-base font-bold">mini-atoms</div>

      <nav className="flex flex-col gap-1 px-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.key === "home" ? onHome : undefined}
            disabled={item.key !== "home"}
            title={item.key !== "home" ? "演示模式暂未开放" : undefined}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-neutral-200/60 disabled:opacity-40 dark:hover:bg-neutral-800"
          >
            <span>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <hr className="mx-4 my-3 border-[#e5e5e5] dark:border-neutral-800" />

      <div className="px-4 pb-1 text-xs font-medium text-[#a3a3a3]">最近</div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {MOCK_RECENT_PROJECTS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpenProject(p.scenarioId)}
            className="rounded-lg px-3 py-2 text-left transition-colors hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
          >
            <div className="truncate text-sm">{p.title}</div>
            <div className="text-xs text-[#a3a3a3]">{p.updatedAt}</div>
          </button>
        ))}
      </div>

      {/* TODO: 底部操作区为纯占位，接入真实功能后替换 */}
      <div className="flex flex-col gap-1 border-t border-[#e5e5e5] p-2 dark:border-neutral-800">
        {["加入社区", "获取积分"].map((label) => (
          <button
            key={label}
            type="button"
            disabled
            title="演示模式暂未开放"
            className="rounded-lg px-3 py-2 text-left text-sm text-[#525252] opacity-40 dark:text-neutral-400"
          >
            {label}
          </button>
        ))}
      </div>
    </aside>
  );
}
