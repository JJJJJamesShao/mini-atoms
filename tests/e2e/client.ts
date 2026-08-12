/**
 * E2E 黑箱客户端：以真实 HTTP + SSE 与被测系统交互，不触碰任何内部函数。
 *
 * SSESession 模拟"一个盯着页面看的用户"：
 * - start() 发起流水线，后台持续读取事件流；
 * - waitFor() 等待特定事件出现（如 approve_needed），带超时——
 *   对应真实用户"等不到下一步"的感知，超时即视为卡住；
 * - 事件全量留档（events），供任务结束后做序列断言。
 */

/** SSE 事件（服务端 JSON 载荷，字段按 type 窄化） */
export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

interface Waiter {
  pred: (e: SSEEvent) => boolean;
  description: string;
  resolve: (e: SSEEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SSESession {
  readonly events: SSEEvent[] = [];
  private waiters: Waiter[] = [];
  private finished = false;
  private streamError: Error | null = null;
  /** 流结束时 resolve（读取异常则 reject） */
  readonly completion: Promise<void>;
  private complete!: () => void;
  private fail!: (err: Error) => void;

  constructor(
    private readonly baseUrl: string,
    private readonly cookie: string,
    /** 事件到达时的实时回调（runner 用它打印阶段时间线） */
    private readonly onEvent?: (e: SSEEvent) => void,
  ) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.complete = resolve;
      this.fail = reject;
    });
    // 调用方通过 waitFor/completion 消费，避免未处理拒绝告警
    this.completion.catch(() => {});
  }

  /** 发起流水线 POST /api/pipeline，后台开始收事件 */
  async start(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/pipeline`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        `流水线请求被拒（HTTP ${res.status}）：${data?.message ?? "未知"}`,
      );
    }
    if (!res.body) throw new Error("流水线响应无 body");
    void this.readLoop(res.body);
  }

  private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            this.push(JSON.parse(trimmed.slice(6)) as SSEEvent);
          } catch {
            // 忽略解析失败的行
          }
        }
      }
      this.settled(null);
    } catch (err) {
      this.settled(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private push(event: SSEEvent): void {
    this.events.push(event);
    this.onEvent?.(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.pred(event)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  }

  private settled(err: Error | null): void {
    this.finished = true;
    this.streamError = err;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(
        err ?? new Error("事件流已结束，但未等到预期事件（流水线提前终止）"),
      );
    }
    if (err) this.fail(err);
    else this.complete();
  }

  /**
   * 等待满足条件的事件（先查已到达的事件，再等后续）。
   * 超时/流提前结束都会 reject——黑箱语义上这就是"卡住"。
   */
  async waitFor(
    pred: (e: SSEEvent) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<SSEEvent> {
    const existing = this.events.find(pred);
    if (existing) return existing;
    if (this.finished) {
      throw new Error(
        `等待「${description}」失败：事件流已结束${this.streamError ? `（${this.streamError.message}）` : ""}`,
      );
    }
    return new Promise<SSEEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(
          new Error(
            `等待「${description}」超时（${Math.round(timeoutMs / 1000)}s）`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ pred, description, resolve, reject, timer });
    });
  }

  /** approve 确认门决策：POST /api/pipeline/confirm */
  async confirm(
    sessionId: string,
    approved: boolean,
  ): Promise<{ live: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/pipeline/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify({ sessionId, approved }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        `确认门请求失败（HTTP ${res.status}）：${data?.message ?? "未知"}`,
      );
    }
    const data = (await res.json()) as { live?: boolean };
    return { live: data.live === true };
  }

  /** 已到达事件中按类型查找（最后一个） */
  lastOfType(type: string): SSEEvent | undefined {
    return [...this.events].reverse().find((e) => e.type === type);
  }
}
