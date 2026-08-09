/**
 * Agent 事件总线 — 内存级发布订阅
 * 
 * 解决核心问题：单线程流水线中 generate 节点阻塞 30-60s，
 * 前端收不到任何进度事件，以为系统卡死。
 * 
 * 通过 EventBus，每个 Agent 节点在执行期间可以 emit 中间事件，
 * 前端实时收到并展示"正在生成代码..."等反馈。
 */

export interface AgentEvent {
  /** 事件类型 */
  type: "agent:start" | "agent:thinking" | "agent:progress" | "agent:complete" | "agent:error";
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

/**
 * 内存级 Agent 事件总线
 * 
 * 注意：基于单进程内存，适用于 dev/单实例部署。
 * 多实例 serverless 环境需替换为 Redis / 数据库队列。
 */
export class AgentEventBus {
  /** 按 Agent 名称分组的订阅者 */
  private listeners = new Map<string, Set<AgentEventHandler>>();
  /** 全局订阅者（接收所有 Agent 事件） */
  private globalListeners = new Set<AgentEventHandler>();

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
   * 发布事件
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
  }

  /**
   * 获取当前活跃订阅统计（调试用）
   */
  stats(): { global: number; agents: Record<string, number> } {
    const agents: Record<string, number> = {};
    this.listeners.forEach((set, name) => {
      agents[name] = set.size;
    });
    return {
      global: this.globalListeners.size,
      agents,
    };
  }
}

/** 全局默认总线实例 */
export const defaultBus = new AgentEventBus();
