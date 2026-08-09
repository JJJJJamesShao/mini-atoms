// UI 层的 Mock 数据集中地——真实数据源接入后逐项替换。

// TODO: 接入 Supabase 后替换为真实项目列表（scenarioId 字段一并移除）
export const MOCK_RECENT_PROJECTS: {
  id: string;
  title: string;
  updatedAt: string;
  scenarioId: string;
}[] = [
  { id: "1", title: "待办清单", updatedAt: "2026-08-09", scenarioId: "todo" },
  { id: "2", title: "贪吃蛇", updatedAt: "2026-08-08", scenarioId: "snake" },
  { id: "3", title: "计时器", updatedAt: "2026-08-07", scenarioId: "timer" },
  {
    id: "4",
    title: "预算与身材管理APP",
    updatedAt: "2026-08-06",
    // TODO: 无对应罐头场景，暂映射到待办清单演示
    scenarioId: "todo",
  },
];

// TODO: 接入主题系统后替换（当前仅展示，不生效）
export const MOCK_THEMES = ["默认", "深色", "浅色"];

// TODO: 接入构建模式（模型路由档位）后替换（当前仅展示，不生效）
export const MOCK_BUILD_MODES = ["极速", "精细"];
