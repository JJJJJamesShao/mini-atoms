"use client";

import { useEffect, useRef, useState } from "react";

interface ProjectItem {
  id: string;
  title: string;
  updatedAt: string;
  pinned: boolean;
}

interface SidebarProps {
  onHome: () => void;
  onOpenProject: (projectId: string, isReal: boolean) => void;
}

const NAV_ITEMS = [
  { icon: "🏠", label: "首页", key: "home" },
  { icon: "📦", label: "资源", key: "resources" },
] as const;

/** 加载骨架屏 */
function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-1 px-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-lg px-3 py-2 animate-pulse">
          <div className="h-4 w-3/4 rounded bg-neutral-200 dark:bg-neutral-800" />
          <div className="mt-1.5 h-3 w-1/2 rounded bg-neutral-200 dark:bg-neutral-800" />
        </div>
      ))}
    </div>
  );
}

/** 左侧导航边栏 */
export default function Sidebar({ onHome, onOpenProject }: SidebarProps) {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 全局菜单状态：提升到 Sidebar，菜单作为独立层渲染
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 加载项目列表（数据获取不是 setState，在 effect 中是合法模式）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/projects")
      .then((res) => {
        if (res.status === 401) return { projects: [] };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setProjects(
          (data.projects ?? []).map(
            (p: {
              id: string;
              title: string;
              created_at: string;
              pinned?: boolean;
            }) => ({
              id: p.id,
              title: p.title,
              updatedAt: new Date(p.created_at).toLocaleDateString(),
              pinned: !!p.pinned,
            }),
          ),
        );
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openMenu = (projectId: string, btnEl: HTMLButtonElement) => {
    const rect = btnEl.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuProjectId(projectId);
  };

  const handlePin = async (id: string, pinned: boolean) => {
    try {
      const res = await fetch(`/api/projects/${id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      });
      if (res.ok) {
        setProjects((prev) =>
          prev
            .map((p) => (p.id === id ? { ...p, pinned } : p))
            .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
        );
      }
    } catch (err) {
      console.error("[pin]", err);
    }
    setMenuProjectId(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除这个项目吗？此操作不可恢复。")) return;
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== id));
      }
    } catch (err) {
      console.error("[delete]", err);
    }
    setMenuProjectId(null);
  };

  const currentMenuProject = projects.find((p) => p.id === menuProjectId);

  const cannedScenarios = [
    { id: "todo", title: "待办清单" },
    { id: "snake", title: "贪吃蛇" },
    { id: "timer", title: "计时器" },
  ];

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

      {/* 真实项目 */}
      <div className="px-4 pb-1 text-xs font-medium text-[#a3a3a3]">
        最近项目
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2">
        {loading && <LoadingSkeleton />}
        {!loading && projects.length === 0 && (
          <div className="px-3 py-2 text-xs text-[#a3a3a3]">暂无项目</div>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            className="group flex items-center gap-1 rounded-lg px-3 py-2 transition-colors hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
          >
            <button
              type="button"
              onClick={() => onOpenProject(p.id, true)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="flex items-center gap-1">
                {p.pinned && <span className="text-xs">📌</span>}
                <span className="truncate text-sm">{p.title}</span>
              </div>
              <div className="text-xs text-[#a3a3a3]">{p.updatedAt}</div>
            </button>
            <button
              data-menu-btn
              type="button"
              onClick={(e) => openMenu(p.id, e.currentTarget)}
              className="rounded px-1 text-[#a3a3a3] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-neutral-200/60 hover:text-neutral-700 dark:hover:bg-neutral-800"
            >
              ⋮
            </button>
          </div>
        ))}
      </div>
      {error && <div className="px-4 py-2 text-xs text-red-500">{error}</div>}

      <hr className="mx-4 my-3 border-[#e5e5e5] dark:border-neutral-800" />

      {/* 示例项目 */}
      <div className="px-4 pb-1 text-xs font-medium text-[#a3a3a3]">示例</div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2">
        {cannedScenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpenProject(s.id, false)}
            className="rounded-lg px-3 py-2 text-left transition-colors hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
          >
            <div className="truncate text-sm">{s.title}</div>
            <div className="text-xs text-[#a3a3a3]">演示</div>
          </button>
        ))}
      </div>

      {/* 底部 */}
      <div className="mt-auto flex flex-col gap-1 border-t border-[#e5e5e5] p-2 dark:border-neutral-800">
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

      {/* 全局菜单层：fixed 定位，脱离所有父容器限制 */}
      {currentMenuProject && (
        <div
          data-project-menu
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            zIndex: 9999,
          }}
          className="w-[140px] rounded-lg border border-[#e5e5e5] bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <button
            type="button"
            onClick={() =>
              handlePin(currentMenuProject.id, !currentMenuProject.pinned)
            }
            className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <span>{currentMenuProject.pinned ? "📌" : "📍"}</span>
            {currentMenuProject.pinned ? "取消置顶" : "置顶"}
          </button>
          <div className="mx-2 my-1 border-t border-[#e5e5e5] dark:border-neutral-700" />
          <button
            type="button"
            onClick={() => handleDelete(currentMenuProject.id)}
            className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            <span>🗑️</span>
            删除
          </button>
        </div>
      )}
    </aside>
  );
}
