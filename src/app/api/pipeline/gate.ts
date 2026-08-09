/**
 * approve 确认门的跨请求挂起/恢复机制。
 * /api/pipeline 在 approve 阶段挂起流水线，把 resolver 存入模块级 Map；
 * 前端用户点击「确认/修改」后由 /api/pipeline/confirm 恢复。
 * 注意：依赖单进程内存状态（dev/单实例部署可用），多实例 serverless 需换外部存储。
 */

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

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 挂起等待用户确认；超时按拒绝处理，避免流永久悬挂 */
export function waitForApproval(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      store.delete(sessionId);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    store.set(sessionId, { userId, resolve, timer });
  });
}

/** 恢复挂起的审批；会话不存在或归属其他用户时返回 false */
export function resolveApproval(
  sessionId: string,
  userId: string,
  approved: boolean,
): boolean {
  const pending = store.get(sessionId);
  if (!pending || pending.userId !== userId) return false;
  clearTimeout(pending.timer);
  store.delete(sessionId);
  pending.resolve(approved);
  return true;
}
