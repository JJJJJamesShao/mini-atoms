/**
 * SOP 路由 — 根据用户输入选择执行流程
 *
 * 关键词匹配（Mock-First 阶段的简易路由）：
 * - 有现有代码（对话迭代）→ modify（增量修改小循环，优先级最高）
 * - 游戏类 → game（精简流程，跳过 approve）
 * - 工具类 → tool（复用 web-app 完整流程）
 * - 其他 → web-app（默认完整流程）
 *
 * TODO: 接入真实 LLM 意图分类后可替换为 classify 节点（MODEL_ROUTING.classify）
 */

import { SOP_REGISTRY, type SOPConfig } from "./sop";

const FULLSTACK_PATTERN =
  /博客|管理系统|数据库|登录|注册|后台|crud|增删改查|blog|admin|dashboard/i;
const GAME_PATTERN = /游戏|game|贪吃蛇|数独|坦克|snake|sudoku/i;
const TOOL_PATTERN = /工具|计算器|计时器|待办|tool|calculator|timer|todo/i;

/** 选择 SOP id：有现有代码时优先走 modify 增量修改小循环 */
export function selectSOPId(
  input: string,
  opts?: { hasCurrentCode?: boolean },
): string {
  if (opts?.hasCurrentCode) return "modify";
  if (FULLSTACK_PATTERN.test(input)) return "fullstack-app";
  if (GAME_PATTERN.test(input)) return "game";
  if (TOOL_PATTERN.test(input)) return "tool";
  return "web-app";
}

/** 选择 SOP 配置（保证注册表中存在） */
export function selectSOP(
  input: string,
  opts?: { hasCurrentCode?: boolean },
): SOPConfig {
  const id = selectSOPId(input, opts);
  const sop = SOP_REGISTRY.get(id);
  if (!sop) throw new Error(`SOP 注册表中不存在: ${id}`);
  return sop;
}
