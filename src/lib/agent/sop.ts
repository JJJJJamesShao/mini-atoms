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
  | "merge"
  | "locate"
  | "patch"
  | "apply"
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
          {
            field: "status",
            operator: "eq",
            value: "need_clarification",
            then: "fail",
          },
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
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix" },
        ],
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
          {
            field: "status",
            operator: "eq",
            value: "need_clarification",
            then: "fail",
          },
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
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix" },
        ],
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

/**
 * 全栈应用：多阶段分层生成（schema → shell → pages → 确定性 merge）。
 *
 * 设计要点：
 * - 每个 generate-X / verify-X 步骤名携带阶段标识，引擎据此路由阶段 prompt
 *   与阶段级校验，并把产物存入 ctx.stageOutputs 供后续阶段引用；
 * - fix-X 跳回对应的 generate-X（不是 verify-X——verify 不改变产物，
 *   直接跳回会拿同一份坏产物死循环）；
 * - merge 是 system 动作（零 LLM 字符串组装），不走 generate 执行器；
 * - 最终 verify 失败回 generate-pages 重修（页面代码是结构破坏的最常见来源）；
 * - fixAttempts 全局共享（MAX_FIX_ATTEMPTS=5 跨 4 个校验点），v1 已知限制。
 */
export const FULLSTACK_SOP: SOPConfig = {
  id: "fullstack-app",
  name: "全栈应用",
  description: "带数据层的复杂应用，分阶段生成后确定性合并",
  steps: [
    {
      name: "clarify",
      role: "pm",
      action: "clarify",
      next: {
        default: "spec",
        conditions: [
          {
            field: "status",
            operator: "eq",
            value: "need_clarification",
            then: "fail",
          },
        ],
      },
    },
    { name: "spec", role: "architect", action: "spec", next: "approve" },
    {
      name: "approve",
      role: "pm",
      action: "approve",
      next: {
        default: "generate-schema",
        conditions: [
          { field: "approved", operator: "eq", value: "false", then: "fail" },
        ],
      },
    },
    {
      name: "generate-schema",
      role: "engineer",
      action: "generate",
      next: "verify-schema",
    },
    {
      name: "verify-schema",
      role: "reviewer",
      action: "verify",
      next: {
        default: "generate-shell",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix-schema" },
        ],
      },
    },
    {
      name: "fix-schema",
      role: "engineer",
      action: "fix",
      next: {
        default: "generate-schema",
        conditions: [
          { field: "exhausted", operator: "eq", value: "true", then: "fail" },
        ],
      },
    },
    {
      name: "generate-shell",
      role: "engineer",
      action: "generate",
      next: "verify-shell",
    },
    {
      name: "verify-shell",
      role: "reviewer",
      action: "verify",
      next: {
        default: "generate-pages",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix-shell" },
        ],
      },
    },
    {
      name: "fix-shell",
      role: "engineer",
      action: "fix",
      next: {
        default: "generate-shell",
        conditions: [
          { field: "exhausted", operator: "eq", value: "true", then: "fail" },
        ],
      },
    },
    {
      name: "generate-pages",
      role: "engineer",
      action: "generate",
      next: "verify-pages",
    },
    {
      name: "verify-pages",
      role: "reviewer",
      action: "verify",
      next: {
        default: "merge",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix-pages" },
        ],
      },
    },
    {
      name: "fix-pages",
      role: "engineer",
      action: "fix",
      next: {
        default: "generate-pages",
        conditions: [
          { field: "exhausted", operator: "eq", value: "true", then: "fail" },
        ],
      },
    },
    // 确定性合并：零 LLM 字符串组装（system 动作，不调用任何模型）。
    // 缺页（missingPages 非空）→ fix-pages 重修，不得以缺页状态进最终 verify
    {
      name: "merge",
      role: "system",
      action: "merge",
      next: {
        default: "verify",
        conditions: [
          {
            field: "missingPages",
            operator: "ne",
            value: "",
            then: "fix-pages",
          },
        ],
      },
    },
    {
      name: "verify",
      role: "reviewer",
      action: "verify",
      next: {
        default: "done",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix" },
        ],
      },
    },
    {
      name: "fix",
      role: "engineer",
      action: "fix",
      next: {
        default: "generate-pages",
        conditions: [
          { field: "exhausted", operator: "eq", value: "true", then: "fail" },
        ],
      },
    },
    { name: "done", role: "system", action: "done", next: "" },
    { name: "fail", role: "system", action: "fail", next: "" },
  ],
};

/**
 * 代码修改：基于现有代码的增量修改小循环（用户主动修改专用）。
 *
 * 设计要点：
 * - 只有 locate/patch 两步调 LLM；apply/verify 是确定性护栏（零 LLM）；
 * - locate 把"在哪里改"从补丁生成里拆出来，降低 SEARCH 块不匹配率；
 * - apply 失败（块不匹配/多候选/无实际改动）→ fix-patch 带反馈回 patch 重试；
 *   verify 失败同样回 patch（补丁重写，而非基于坏产物继续打补丁）；
 * - 每次重试都基于原始代码重新生成补丁并应用（不在半成品上叠加）；
 * - 无 approve 门：修改是对既有规格的增量，不需要重新确认；
 * - 重试次数用尽 → fail 保留旧版本（v1 砍掉自动回退完整重写——最贵且曾
 *   引发 300s 超时误杀的路径），用户可重新发起修改。
 */
export const MODIFY_SOP: SOPConfig = {
  id: "modify",
  name: "代码修改",
  description: "基于现有代码的增量修改小循环（locate→patch→apply→verify）",
  steps: [
    { name: "locate", role: "architect", action: "locate", next: "patch" },
    { name: "patch", role: "engineer", action: "patch", next: "apply" },
    {
      name: "apply",
      role: "system",
      action: "apply",
      next: {
        default: "verify",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix-patch" },
        ],
      },
    },
    {
      name: "verify",
      role: "reviewer",
      action: "verify",
      next: {
        default: "done",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix-patch" },
        ],
      },
    },
    {
      name: "fix-patch",
      role: "engineer",
      action: "fix",
      next: {
        default: "patch",
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
  ["fullstack-app", FULLSTACK_SOP],
  ["modify", MODIFY_SOP],
]);
