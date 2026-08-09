/**
 * Agent 角色基类 — MetaGPT 简化版
 *
 * 每个角色封装：名称、目标、约束、模型配置。
 * SOP 步骤通过 role id 引用角色，引擎执行时用角色元数据 emit 事件。
 */

export interface RoleConfig {
  /** 角色显示名（出现在 Agent 执行日志中） */
  name: string;
  /** 角色目标 */
  goal: string;
  /** 行为约束 */
  constraints: string[];
  /** 使用的模型；"none" 表示零模型（确定性逻辑） */
  model: string;
  maxTokens?: number;
}

export class Role {
  constructor(public readonly config: RoleConfig) {}

  /** 是否调用 LLM */
  get usesLLM(): boolean {
    return this.config.model !== "none";
  }

  systemPrompt(): string {
    return `你是${this.config.name}。${this.config.goal}
约束：${this.config.constraints.join("\n")}`;
  }
}

/** 预设角色 */
export const ROLES = {
  /** 产品经理：需求澄清（clarify 节点，快模型） */
  pm: new Role({
    name: "产品经理",
    goal: "理解用户需求，判断是否需要澄清",
    constraints: ["简单需求直接通过", "最多提3个问题"],
    model: "qwen3.6-flash",
    maxTokens: 2048,
  }),
  /** 架构师：规格生成（spec 节点，快模型结构化输出） */
  architect: new Role({
    name: "架构师",
    goal: "将需求拆解为技术规格",
    constraints: ["严格JSON输出", "包含约束条件"],
    model: "qwen3.6-flash",
    maxTokens: 4096,
  }),
  /** 前端工程师：代码生成（generate 节点，强代码模型） */
  engineer: new Role({
    name: "前端工程师",
    goal: "生成完整可运行的单文件HTML",
    constraints: ["无外部依赖", "原生JS", "内联样式"],
    model: "glm-5.2",
    maxTokens: 4096,
  }),
  /** 代码审查员：产物校验（verify 节点，零模型确定性检查） */
  reviewer: new Role({
    name: "代码审查员",
    goal: "检查代码语法和结构",
    constraints: ["确定性检查", "零模型调用"],
    model: "none",
  }),
} as const;

export type RoleId = keyof typeof ROLES;
