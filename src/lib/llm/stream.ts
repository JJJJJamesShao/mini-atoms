/**
 * 带超时保护的 LLM 流式收集器。
 *
 * 背景：非流式 chat() 曾被 provider 代理挂起 15 分钟才由 SDK 默认超时掐死
 * （follow-up 卡住事故）。流式 + 主动超时可观测、可干预：
 * - idle 超时：单个 chunk 等待超过上限 → provider 挂起，主动断开
 * - 总时长硬上限：防止慢速 dribble 无限拖延
 * 任一超时都会 abort 底层连接并抛 StreamTimeoutError，由上层收敛为失败。
 */

import type OpenAI from "openai";

/** SDK Stream 对象携带 controller（openai ^7），用于超时时主动断开底层连接 */
type ChatStream = AsyncIterable<OpenAI.Chat.ChatCompletionChunk> & {
  controller?: AbortController;
};

export interface StreamTimeoutOptions {
  /** 单 chunk 空闲上限（毫秒）：超过判定 provider 挂起 */
  idleTimeoutMs: number;
  /** 总时长硬上限（毫秒） */
  totalTimeoutMs: number;
}

/** 流式收集超时（区分于网络错误，上层可据此给出准确文案） */
export class StreamTimeoutError extends Error {
  constructor(
    message: string,
    readonly kind: "idle" | "total",
  ) {
    super(message);
    this.name = "StreamTimeoutError";
  }
}

/**
 * 按字符增量节流的回调工厂：每新累积 intervalChars 才触发一次 fn。
 * 用于流式进度事件，避免逐 chunk 刷新事件总线。
 */
export function throttleByChars(
  intervalChars: number,
  fn: (accumulated: string) => void,
): (accumulated: string, delta?: string) => void {
  let last = 0;
  return (accumulated) => {
    if (accumulated.length - last >= intervalChars) {
      last = accumulated.length;
      fn(accumulated);
    }
  };
}

/**
 * 逐 chunk 收集 content 文本，带 idle/total 双重超时保护。
 *
 * @param stream - OpenAI 流式响应
 * @param opts - 超时配置
 * @param onText - 每个有效 chunk 回调（累计文本、增量文本），用于进度事件
 * @returns 完整文本
 */
export async function collectStreamText(
  stream: ChatStream,
  opts: StreamTimeoutOptions,
  onText?: (accumulated: string, delta: string) => void,
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + opts.totalTimeoutMs;
  let content = "";

  const abort = () => {
    try {
      stream.controller?.abort();
    } catch {
      // 已断开
    }
    try {
      void iterator.return?.();
    } catch {
      // 已结束
    }
  };

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      abort();
      throw new StreamTimeoutError(
        `LLM 流式响应总时长超限（${Math.round(opts.totalTimeoutMs / 1000)}s）`,
        "total",
      );
    }

    // 本 chunk 的等待上限 = min(idle 上限, 剩余总时长)
    const waitMs = Math.min(opts.idleTimeoutMs, remaining);
    const isIdleLimit = waitMs === opts.idleTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new StreamTimeoutError(
            isIdleLimit
              ? `LLM 流式响应空闲超时（${Math.round(opts.idleTimeoutMs / 1000)}s 无数据）`
              : `LLM 流式响应总时长超限（${Math.round(opts.totalTimeoutMs / 1000)}s）`,
            isIdleLimit ? "idle" : "total",
          ),
        );
      }, waitMs);
    });

    try {
      const { done, value } = await Promise.race([iterator.next(), timeout]);
      if (done) return content;
      // GLM：只收集 content，忽略 reasoning_content（思考过程不进入产物）
      const delta = value.choices[0]?.delta?.content ?? "";
      if (delta) {
        content += delta;
        onText?.(content, delta);
      }
    } catch (err) {
      if (err instanceof StreamTimeoutError) abort();
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
