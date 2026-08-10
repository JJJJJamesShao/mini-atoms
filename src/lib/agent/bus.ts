/**
 * Agent 事件总线 — 内存级发布订阅（Topic-based Pub/Sub）
 *
 * 两层机制：
 * 1. AgentEvent 广播（emit/subscribe/subscribeAll）：节点进度事件，
 *    供 SSE 实时推送前端。旧代码（llm-executors 等）的 emit() 不变。
 * 2. TypedMessage Topic 路由（publish/subscribe/queryHistory）：
 *    Agent 间按 Topic 传递产物（PRD/ARCH_SPEC/CODE/REVIEW），
 *    消息进入会话级历史，供 Agent 执行前 prepareContext 恢复上下文。
 *
 * 注意：基于单进程内存，适用于 dev/单实例部署。
 * 多实例 serverless 环境需替换为 Redis / 数据库队列。
 */

import { MessageTopic, type TypedMessage } from "./message";

export interface AgentEvent {
  /** 事件类型 */
  type:
    | "agent:start"
    | "agent:thinking"
    | "agent:progress"
    | "agent:summary"
    | "agent:complete"
    | "agent:error"
    | "file:generated";
  /** Agent 名称（clarify/spec/generate/verify/fix） */
  agent: string;
  /** Agent 角色描述 */
  role?: string;
  /** 输入/上下文 */
  input?: unknown;
  /** 输出结果 */
  output?: unknown;
  /** 中间消息（如"正在分析需求..."） */
  message?: string;
  /** 进度百分比（0-100，可选） */
  percent?: number;
  /** 错误信息 */
  error?: string;
  /** 时间戳 */
  timestamp: number;
}

export type AgentEventHandler = (event: AgentEvent) => void;
export type TypedMessageHandler = (msg: TypedMessage) => void;

/** Topic 消息历史上限，防内存泄漏 */
const MAX_HISTORY = 100;

export class AgentEventBus {
  /** 按 Agent 名称分组的订阅者（AgentEvent 广播层） */
  private listeners = new Map<string, Set<AgentEventHandler>>();
  /** 全局订阅者（接收所有 Agent 事件） */
  private globalListeners = new Set<AgentEventHandler>();

  /** 按 Topic 分组的订阅者（TypedMessage 路由层） */
  private topicSubscribers = new Map<MessageTopic, Set<TypedMessageHandler>>();
  /** 会话级消息历史（供 queryHistory 恢复上下文） */
  private history: TypedMessage[] = [];

  // ---------- AgentEvent 广播层（旧 API，保持不变） ----------

  /**
   * 订阅特定 Agent 的事件
   * @returns 取消订阅函数
   */
  subscribe(agent: string, handler: AgentEventHandler): () => void {
    if (!this.listeners.has(agent)) {
      this.listeners.set(agent, new Set());
    }
    this.listeners.get(agent)!.add(handler);
    return () => {
      this.listeners.get(agent)?.delete(handler);
    };
  }

  /**
   * 订阅所有 Agent 的事件（全局监听）
   * @returns 取消订阅函数
   */
  subscribeAll(handler: AgentEventHandler): () => void {
    this.globalListeners.add(handler);
    return () => {
      this.globalListeners.delete(handler);
    };
  }

  /**
   * 发布 Agent 进度事件（广播层）。
   * 同时映射为 SYSTEM Topic 的 TypedMessage 进入历史（兼容层）。
   */
  emit(event: Omit<AgentEvent, "timestamp">): void {
    const fullEvent: AgentEvent = {
      ...event,
      timestamp: Date.now(),
    };

    // 先通知全局订阅者
    this.globalListeners.forEach((handler) => {
      try {
        handler(fullEvent);
      } catch (err) {
        console.error(`[EventBus] 全局处理器错误:`, err);
      }
    });

    // 再通知特定 Agent 的订阅者
    this.listeners.get(event.agent)?.forEach((handler) => {
      try {
        handler(fullEvent);
      } catch (err) {
        console.error(`[EventBus] Agent ${event.agent} 处理器错误:`, err);
      }
    });

    // 兼容映射：进度事件同时进入 SYSTEM Topic 历史
    this.publish(MessageTopic.SYSTEM, {
      from: event.role ?? event.agent,
      payload: fullEvent,
      sessionId: SYSTEM_SESSION,
    });
  }

  // ---------- TypedMessage Topic 路由层（新 API） ----------

  /**
   * 按 Topic 订阅类型化消息
   * @returns 取消订阅函数
   */
  subscribeTopic(
    topic: MessageTopic,
    handler: TypedMessageHandler,
  ): () => void {
    if (!this.topicSubscribers.has(topic)) {
      this.topicSubscribers.set(topic, new Set());
    }
    this.topicSubscribers.get(topic)!.add(handler);
    return () => {
      this.topicSubscribers.get(topic)?.delete(handler);
    };
  }

  /** 按 Topic 发布类型化消息（进入历史并路由给订阅者） */
  publish(
    topic: MessageTopic,
    msg: Omit<TypedMessage, "id" | "timestamp" | "topic">,
  ): void {
    const full: TypedMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...msg,
      topic,
    };

    this.history.push(full);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }

    this.topicSubscribers.get(topic)?.forEach((handler) => {
      try {
        handler(full);
      } catch (err) {
        console.error(`[EventBus] Topic ${topic} 处理器错误:`, err);
      }
    });
  }

  /** 查询某 Topic 的会话历史（Agent 执行前恢复上下文用） */
  queryHistory(topic: MessageTopic, sessionId: string): TypedMessage[] {
    return this.history.filter(
      (m) => m.topic === topic && m.sessionId === sessionId,
    );
  }

  /**
   * 获取当前活跃订阅统计（调试用）
   */
  stats(): {
    global: number;
    agents: Record<string, number>;
    topics: Record<string, number>;
    historySize: number;
  } {
    const agents: Record<string, number> = {};
    this.listeners.forEach((set, name) => {
      agents[name] = set.size;
    });
    const topics: Record<string, number> = {};
    this.topicSubscribers.forEach((set, topic) => {
      topics[topic] = set.size;
    });
    return {
      global: this.globalListeners.size,
      agents,
      topics,
      historySize: this.history.length,
    };
  }
}

/** emit 兼容映射使用的固定会话 id（进度事件不属于任何流水线会话） */
const SYSTEM_SESSION = "__system__";

/** 全局默认总线实例 */
export const defaultBus = new AgentEventBus();
