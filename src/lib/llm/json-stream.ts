/**
 * JSON 输出的流式收集 + 多级解析兜底 + 解析失败重试。
 *
 * 背景：clarify/spec/locate 等快模型节点偶发输出非法 JSON（截断、首尾废话、
 * 字符串内 raw 控制字符），此前 extractJson 两级兜底失败即抛错，异常直接
 * 杀死整条流水线（web-app 运行死在 spec 步骤的事故），且错误信息内嵌
 * raw JSON 前 200 字符，直接糊到用户界面。
 *
 * 设计：
 * - extractJson：多级候选兜底（原文 → 去 fence → 截取花括号范围 → 字符串内
 *   控制字符转义），全部失败才抛错；错误信息不内嵌原始输出（调试信息走
 *   服务端日志，不进用户界面）；
 * - callJsonLlm：流式收集 + 解析失败重试（默认首次 + 2 次重试），重试时把
 *   坏输出作为 assistant 消息回喂并要求重新输出；重试事件经 bus 推送。
 */

import type OpenAI from "openai";
import { streamChat } from "./client";
import type { ModelConfig } from "./models";
import { collectStreamText, throttleByChars } from "./stream";
import type { AgentEventBus } from "../agent/bus";

/** clarify/spec/locate 等 KB 级 JSON 输出的流式超时档位（快模型，120s 足够） */
const FAST_JSON_STREAM_TIMEOUTS = {
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 120_000,
};

/** JSON 解析失败的重试次数（不含首次）；快模型成本低，2 次足够覆盖间歇失败 */
const MAX_JSON_RETRIES = 2;

/**
 * JSON 字符串内不允许 raw 控制字符，模型偶发违反（尤其长字符串里的换行）。
 * 状态机逐字符转义字符串内的 \n \r \t 及其余控制字符，字符串外原样保留。
 */
function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch < " ") {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      // 其余控制字符直接丢弃
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 从 LLM 输出中提取 JSON（多级兜底）：
 * 1. 原文直接 parse（理想路径）
 * 2. 剥离 markdown fence 后 parse
 * 3. 截取首个 { 到末个 } 后 parse（容忍首尾废话/截断残留）
 * 4. 以上候选各自再做"字符串内控制字符转义"后 parse
 * 全部失败抛错——错误信息不内嵌原始输出（raw JSON 不进用户界面），
 * 调用方 callJsonLlm 据此重试并在服务端日志记录调试信息。
 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  // 每个候选先试原文，再试控制字符转义版
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      const sanitized = escapeControlCharsInStrings(candidate);
      if (sanitized !== candidate) {
        try {
          return JSON.parse(sanitized) as T;
        } catch {
          // 继续下一个候选
        }
      }
    }
  }
  throw new Error("LLM 输出不是合法 JSON（多级兜底解析均失败）");
}

export interface JsonCallOptions {
  config: ModelConfig;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  bus?: AgentEventBus;
  /** 阶段名（事件标识，与前端阶段卡片对齐） */
  agent: string;
  /** 角色显示名（事件与错误文案使用） */
  role: string;
  /** 流式进度文案前缀 */
  progressLabel: string;
  /** 最大尝试次数（含首次），默认 1 + MAX_JSON_RETRIES */
  maxAttempts?: number;
  /** 测试注入：替换底层流式调用（生产代码不传） */
  chatFn?: typeof streamChat;
}

/**
 * 流式调用快模型并解析 JSON 输出，解析失败时自动重试：
 * 把坏输出作为 assistant 消息回喂，要求模型只输出合法 JSON。
 * 重试耗尽后抛出的错误信息为用户可读文案（不含 raw JSON）。
 */
export async function callJsonLlm<T>(opts: JsonCallOptions): Promise<T> {
  const chat = opts.chatFn ?? streamChat;
  const maxAttempts = opts.maxAttempts ?? 1 + MAX_JSON_RETRIES;
  let messages = opts.messages;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stream = await chat(opts.config, messages);
    const text = await collectStreamText(
      stream,
      FAST_JSON_STREAM_TIMEOUTS,
      throttleByChars(500, (acc) => {
        opts.bus?.emit({
          type: "agent:progress",
          agent: opts.agent,
          role: opts.role,
          message: `${opts.progressLabel}：已接收 ${acc.length} 字符...`,
        });
      }),
    );
    try {
      return extractJson<T>(text);
    } catch (err) {
      // 调试信息留服务端日志：长度 + 前缀足够定位问题，不进用户界面
      console.warn(
        `[callJsonLlm] ${opts.agent} 第 ${attempt}/${maxAttempts} 次输出非法 JSON（${text.length} 字符），前缀:`,
        text.slice(0, 200),
      );
      if (attempt >= maxAttempts) {
        throw new Error(
          `${opts.role}多次输出非法 JSON（已自动重试 ${maxAttempts - 1} 次仍失败），请重新发起`,
          { cause: err },
        );
      }
      opts.bus?.emit({
        type: "agent:thinking",
        agent: opts.agent,
        role: opts.role,
        message: `输出格式异常，自动重试（第 ${attempt + 1} 次）...`,
      });
      messages = [
        ...messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content:
            "你上次的输出不是合法 JSON，无法解析。请重新输出：只输出一个完整、合法的 JSON 对象，不要任何额外文字或 markdown 标记。",
        },
      ];
    }
  }
  // 不可达（循环内必然 return 或 throw），仅为通过 TS 检查
  throw new Error("unreachable");
}
