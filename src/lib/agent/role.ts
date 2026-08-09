/**
 * Agent 角色基类 — MetaGPT 简化版
 *
 * 每个角色封装：名称、目标、约束、模型配置 + 独立 Memory（记忆隔离）。
 * SOP 步骤通过 role id 引用角色，引擎执行时用角色元数据 emit 事件。
 *
 * 注意：ROLES 预设是共享的配置模板（只读使用）；每次流水线运行应通过
 * createRoles() 创建新实例，避免跨会话记忆串扰。
 */

import { AgentMemory } from "./memory";
import type { AgentEventBus } from "./bus";
import { MessageTopic } from "./message";

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
  /** 记忆容量上限（默认 50） */
  memoryLimit?: number;
}

export class Role {
  /** 角色独立记忆（Memory 隔离） */
  readonly memory: AgentMemory;

  constructor(public readonly config: RoleConfig) {
    this.memory = new AgentMemory({ maxEntries: config.memoryLimit ?? 50 });
  }

  /** 是否调用 LLM */
  get usesLLM(): boolean {
    return this.config.model !== "none";
  }

  systemPrompt(): string {
    return `你是${this.config.name}。${this.config.goal}
约束：${this.config.constraints.join("\n")}`;
  }

  /**
   * 执行前准备上下文：从 Bus 拉取本角色订阅 Topic 的历史消息，写入 Memory。
   * 这就是 Agent 间通信的消费端——架构师能拿到产品经理发布的 PRD。
   */
  prepareContext(bus: AgentEventBus, sessionId: string): void {
    for (const topic of this.getSubscribedTopics()) {
      const messages = bus.queryHistory(topic, sessionId);
      for (const msg of messages) {
        this.memory.add({
          topic,
          content: JSON.stringify(msg.payload),
          metadata: { from: msg.from },
        });
      }
    }
  }

  /** 每个角色订阅的 Topic（消息路由声明） */
  private getSubscribedTopics(): MessageTopic[] {
    const map: Record<string, MessageTopic[]> = {
      产品经理: [MessageTopic.SYSTEM],
      架构师: [MessageTopic.PRD],
      前端工程师: [MessageTopic.ARCH_SPEC, MessageTopic.REVIEW],
      代码审查员: [MessageTopic.CODE],
    };
    return map[this.config.name] ?? [];
  }
}

/** 预设角色配置（共享模板，勿直接用于运行——用 createRoles()） */
export const ROLES = {
  /** 产品经理：需求澄清（clarify 节点，快模型） */
  pm: new Role({
    name: "产品经理",
    goal: "理解用户需求，判断是否需要澄清",
    constraints: ["简单需求直接通过", "最多提3个问题"],
    model: "qwen3.6-flash",
    maxTokens: 65536,
  }),
  /** 架构师：规格生成（spec 节点，快模型结构化输出） */
  architect: new Role({
    name: "架构师",
    goal: "将需求拆解为技术规格",
    constraints: ["严格JSON输出", "包含约束条件"],
    model: "qwen3.8-max",
    maxTokens: 131072,
  }),
  /** 前端工程师：代码生成（generate 节点，强代码模型） */
  engineer: new Role({
    name: "前端工程师",
    goal: "生成完整可运行的单文件HTML",
    constraints: ["无外部依赖", "原生JS", "内联样式"],
    model: "glm-5.2",
    maxTokens: 131072,
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

/** 为一次流水线运行创建全新的角色实例（记忆互相隔离、跨会话隔离） */
export function createRoles(): Record<RoleId, Role> {
  const entries = (Object.keys(ROLES) as RoleId[]).map(
    (id) => [id, new Role(ROLES[id].config)] as const,
  );
  return Object.fromEntries(entries) as Record<RoleId, Role>;
}
