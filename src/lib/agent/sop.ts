/**
 * SOP（标准作业流程）配置 DSL — MetaGPT 简化版
 *
 * 每套 SOP 是一组有序步骤，步骤间通过 next 跳转：
 * - 字符串：无条件跳转
 * - { default, conditions }：按上一步执行结果的字段做条件分支
 *
 * 条件求值约定：取执行结果对象的 field，String(值) 与 value 比较。
 * 例如 verify 的结果 { pass: false } 命中 { field: "pass", value: "false" }。
 */

import type { RoleId } from "./role";

/** 步骤动作类型，映射到引擎的具体执行逻辑 */
export type SOPAction =
  | "clarify"
  | "spec"
  | "approve"
  | "generate"
  | "verify"
  | "fix"
  | "done"
  | "fail";

export interface SOPCondition {
  /** 执行结果对象的字段名 */
  field: string;
  operator: "eq" | "ne";
  /** 与 String(字段值) 比较 */
  value: string;
  /** 命中后跳转的步骤名 */
  then: string;
}

export interface SOPStep {
  /** 步骤名（在同一 SOP 内唯一，也是前端阶段卡片的 id） */
  name: string;
  /** 执行角色（ROLES 的 key） */
  role: RoleId | "system";
  action: SOPAction;
  next: string | { default: string; conditions?: SOPCondition[] };
}

export interface SOPConfig {
  id: string;
  /** 显示名（展示在版本卡片中） */
  name: string;
  description: string;
  steps: SOPStep[];
}

/** 完整流程：含 approve 用户确认门 */
export const DEFAULT_SOP: SOPConfig = {
  id: "web-app",
  name: "网页应用",
  description: "通用单文件 HTML 应用生成",
  steps: [
    {
      name: "clarify",
      role: "pm",
      action: "clarify",
      next: {
        default: "spec",
        conditions: [
          { field: "status", operator: "eq", value: "need_clarification", then: "fail" },
        ],
      },
    },
    { name: "spec", role: "architect", action: "spec", next: "approve" },
    {
      name: "approve",
      role: "pm",
      action: "approve",
      next: {
        default: "generate",
        conditions: [
          { field: "approved", operator: "eq", value: "false", then: "fail" },
        ],
      },
    },
    { name: "generate", role: "engineer", action: "generate", next: "verify" },
    {
      name: "verify",
      role: "reviewer",
      action: "verify",
      next: {
        default: "done",
        conditions: [{ field: "pass", operator: "eq", value: "false", then: "fix" }],
      },
    },
    {
      name: "fix",
      role: "engineer",
      action: "fix",
      next: {
        default: "generate",
        conditions: [
          { field: "exhausted", operator: "eq", value: "true", then: "fail" },
        ],
      },
    },
    { name: "done", role: "system", action: "done", next: "" },
    { name: "fail", role: "system", action: "fail", next: "" },
  ],
};

/** 游戏类精简流程：跳过 approve，直接生成 */
export const GAME_SOP: SOPConfig = {
  id: "game",
  name: "小游戏",
  description: "单文件 HTML5 游戏",
  steps: [
    {
      name: "clarify",
      role: "pm",
      action: "clarify",
      next: {
        default: "spec",
        conditions: [
          { field: "status", operator: "eq", value: "need_clarification", then: "fail" },
        ],
      },
    },
    { name: "spec", role: "architect", action: "spec", next: "generate" },
    { name: "generate", role: "engineer", action: "generate", next: "verify" },
    {
      name: "verify",
      role: "reviewer",
      action: "verify",
      next: {
        default: "done",
        conditions: [{ field: "pass", operator: "eq", value: "false", then: "fix" }],
      },
    },
    {
      name: "fix",
      role: "engineer",
      action: "fix",
      next: {
        default: "generate",
        conditions: [
          { field: "exhausted", operator: "eq", value: "true", then: "fail" },
        ],
      },
    },
    { name: "done", role: "system", action: "done", next: "" },
    { name: "fail", role: "system", action: "fail", next: "" },
  ],
};

/** SOP 注册表：tool 复用 web-app 完整流程 */
export const SOP_REGISTRY = new Map<string, SOPConfig>([
  ["web-app", DEFAULT_SOP],
  ["game", GAME_SOP],
  ["tool", DEFAULT_SOP],
]);
