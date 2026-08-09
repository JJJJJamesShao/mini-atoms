/**
 * Agent 记忆 — 每个 Role 持有独立实例，实现记忆隔离。
 *
 * 记忆来源：
 * 1. prepareContext：执行前从 EventBus 拉取订阅 Topic 的历史消息
 * 2. 执行器执行时：把节点输入/输出写入对应 Role 的 Memory
 *
 * 容量有限（默认 50 条），超出后裁剪最旧条目，防内存泄漏。
 */

import { MessageTopic } from "./message";

export interface MemoryEntry {
  id: string;
  topic: MessageTopic;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export class AgentMemory {
  private entries: MemoryEntry[] = [];
  private readonly maxEntries: number;

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? 50;
  }

  add(entry: Omit<MemoryEntry, "id" | "timestamp">): void {
    this.entries.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...entry,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /** 查询某 Topic 的记忆（按时间升序） */
  query(topic: MessageTopic, limit?: number): MemoryEntry[] {
    const matched = this.entries.filter((e) => e.topic === topic);
    return limit ? matched.slice(-limit) : matched;
  }

  /** 全部记忆（按时间升序） */
  all(): MemoryEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * 组装 LLM 上下文：system prompt + 记忆条目（作为历史上下文消息）。
   * 用于执行器把记忆注入 prompt。
   */
  buildContext(systemPrompt: string): Array<{ role: string; content: string }> {
    return [
      { role: "system", content: systemPrompt },
      ...this.entries.map((e) => ({
        role: "user",
        content: `[${e.topic}] ${e.content}`,
      })),
    ];
  }

  clear(): void {
    this.entries = [];
  }
}
