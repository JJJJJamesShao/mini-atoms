/**
 * Agent 间通信的类型化消息定义 — Topic-based Pub/Sub
 *
 * 每个消息属于一个 Topic，Agent 按 Topic 订阅/发布：
 * - PM 发布 PRD，架构师订阅 PRD
 * - 架构师发布 ARCH_SPEC，工程师订阅 ARCH_SPEC
 * - 工程师发布 CODE，审查员订阅 CODE
 * - 审查员发布 REVIEW，工程师订阅 REVIEW
 */

export enum MessageTopic {
  /** 产品需求（产品经理 → 架构师） */
  PRD = "PRD",
  /** 架构规格（架构师 → 前端工程师） */
  ARCH_SPEC = "ARCH_SPEC",
  /** 代码产物（前端工程师 → 代码审查员） */
  CODE = "CODE",
  /** 审查意见（代码审查员 → 前端工程师/产品经理） */
  REVIEW = "REVIEW",
  /** 系统事件（start/complete/error 等，由旧 emit 兼容映射） */
  SYSTEM = "SYSTEM",
}

export interface TypedMessage {
  id: string;
  topic: MessageTopic;
  /** 发布者（Agent 角色名或系统） */
  from: string;
  /** 目标 Agent（可选，广播时省略） */
  to?: string;
  payload: unknown;
  timestamp: number;
  /** 流水线会话 id，用于按会话隔离历史 */
  sessionId: string;
}
