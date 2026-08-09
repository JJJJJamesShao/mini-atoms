/**
 * SOP 路由 — 根据用户输入选择执行流程
 *
 * 关键词匹配（Mock-First 阶段的简易路由）：
 * - 游戏类 → game（精简流程，跳过 approve）
 * - 工具类 → tool（复用 web-app 完整流程）
 * - 其他 → web-app（默认完整流程）
 *
 * TODO: 接入真实 LLM 意图分类后可替换为 classify 节点（MODEL_ROUTING.classify）
 */

import { SOP_REGISTRY, type SOPConfig } from "./sop";

const GAME_PATTERN = /游戏|game|贪吃蛇|数独|坦克|snake|sudoku/i;
const TOOL_PATTERN = /工具|计算器|计时器|待办|tool|calculator|timer|todo/i;

/** 选择 SOP id */
export function selectSOPId(input: string): string {
  if (GAME_PATTERN.test(input)) return "game";
  if (TOOL_PATTERN.test(input)) return "tool";
  return "web-app";
}

/** 选择 SOP 配置（保证注册表中存在） */
export function selectSOP(input: string): SOPConfig {
  const id = selectSOPId(input);
  const sop = SOP_REGISTRY.get(id);
  if (!sop) throw new Error(`SOP 注册表中不存在: ${id}`);
  return sop;
}
