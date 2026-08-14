/**
 * approve 确认门的跨请求挂起/恢复机制（DB 持久化版）。
 *
 * 双写设计：
 * - DB（gates 表）：刷新/重启后前端可从 /api/gates/pending 重建"等待确认"UI；
 * - 内存 resolver：同进程内唤醒挂起的流水线 Promise。
 *
 * 页面刷新后用户重新确认时：
 * - resolver 仍在（同进程）→ 原流水线继续执行（返回 "live"）；
 * - resolver 已丢（服务重启/多实例）→ 仅 DB 记录决策（返回 "recorded"），
 *   前端据此提示用户重新发起，不假装能续跑。
 *
 * 注意：内存 resolver 依赖单进程，多实例 serverless 需换外部存储 + 执行上下文重建。
 */

import {
  createGate,
  expireGate,
  resolveGate,
  type GatePayload,
} from "@/lib/db/gates";
import { INSTANCE_ID } from "@/lib/observability";

interface PendingApproval {
  userId: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const store: Map<string, PendingApproval> =
  ((globalThis as Record<string, unknown>).__pipelineApprovals as Map<
    string,
    PendingApproval
  >) ??
  (((globalThis as Record<string, unknown>).__pipelineApprovals = new Map<
    string,
    PendingApproval
  >()) as Map<string, PendingApproval>);

/** 挂起超时时长：内存 resolver 与 gates 表 expires_at 保持一致 */
export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 挂起等待用户确认：先落库（UI 可恢复），再挂起内存 resolver。
 * 超时按拒绝处理并标记 DB expired，避免流永久悬挂。
 * DB 写入失败仅降级为内存态（刷新后不可恢复），不阻断流水线。
 */
export async function waitForApproval(
  sessionId: string,
  userId: string,
  gate: {
    projectId: string | null;
    payload: GatePayload;
  },
): Promise<boolean> {
  console.log("[Gate] 创建确认门:", {
    sessionId,
    instance: INSTANCE_ID,
    projectId: gate.projectId,
  });
  try {
    await createGate(
      sessionId,
      gate.projectId,
      userId,
      "approve",
      gate.payload,
      APPROVAL_TIMEOUT_MS,
    );
    console.log("[Gate] 挂起门落库成功:", { sessionId });
  } catch (err) {
    console.error("[Gate] 挂起门落库失败（降级为内存态）:", err);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log("[Gate] 确认门 30min 超时，按拒绝处理:", { sessionId });
      store.delete(sessionId);
      void expireGate(sessionId).catch((err) =>
        console.error("[Gate] 超时标记 expired 失败:", err),
      );
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    store.set(sessionId, { userId, resolve, timer });
    console.log("[Gate] 内存 resolver 已挂起，等待 confirm:", {
      sessionId,
      instance: INSTANCE_ID,
      storeSize: store.size,
    });
  });
}

export type ResolveResult =
  /** DB 已更新且唤醒了存活的流水线 */
  | "live"
  /** DB 已更新，但无存活流水线（服务重启/其他实例），仅记录决策 */
  | "recorded"
  /** 会话不存在、已解决或不属于该用户 */
  | "not_found";

/** 恢复挂起的审批：先更新 DB（持久事实），再触发内存 resolver（如果还活着） */
export async function resolveApproval(
  sessionId: string,
  userId: string,
  approved: boolean,
): Promise<ResolveResult> {
  console.log("[Gate] 收到确认决策:", {
    sessionId,
    instance: INSTANCE_ID,
    approved,
    hasLocalResolver: store.has(sessionId),
    storeSize: store.size,
  });
  let updated: boolean;
  try {
    updated = await resolveGate(
      sessionId,
      userId,
      approved ? "approved" : "rejected",
    );
    console.log("[Gate] DB 决策落库结果:", { sessionId, updated });
  } catch (err) {
    // DB 不可用时不阻塞内存路径（gates 表未建等场景），但归属仍须校验
    console.error("[Gate] 更新挂起门失败:", err);
    updated = store.get(sessionId)?.userId === userId;
  }
  if (!updated) {
    // DB 无此行：可能是挂起时 createGate 瞬时失败（降级内存态），
    // 流水线仍存活——回退内存路径，与"降级不阻断流水线"的声明一致
    const pending = store.get(sessionId);
    if (!pending || pending.userId !== userId) {
      console.log("[Gate] 决议结果: not_found（DB 无记录且内存无 resolver）", {
        sessionId,
        instance: INSTANCE_ID,
      });
      return "not_found";
    }
    clearTimeout(pending.timer);
    store.delete(sessionId);
    pending.resolve(approved);
    console.log("[Gate] 决议结果: live（内存回退路径唤醒）", { sessionId });
    return "live";
  }

  const pending = store.get(sessionId);
  if (!pending || pending.userId !== userId) {
    // 典型事故形态：confirm 落在另一实例（跨实例）或原函数已被
    // 平台 300s 强杀（resolver 随实例销毁）——决策已落库但无人唤醒
    console.log(
      "[Gate] 决议结果: recorded（无存活 resolver，流水线不会续跑）",
      {
        sessionId,
        instance: INSTANCE_ID,
        hasLocalResolver: store.has(sessionId),
      },
    );
    return "recorded";
  }
  clearTimeout(pending.timer);
  store.delete(sessionId);
  pending.resolve(approved);
  console.log("[Gate] 决议结果: live（同实例唤醒，流水线续跑）", {
    sessionId,
    instance: INSTANCE_ID,
  });
  return "live";
}
