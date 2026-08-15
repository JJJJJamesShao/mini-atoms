/**
 * Pipeline 活跃运行注册表：userId → AbortController。
 *
 * 支撑"停止生成"：POST /api/pipeline 注册运行，POST /api/pipeline/abort 按用户
 * 取消正在进行的 LLM 调用。
 *
 * ⚠️ 部署约束（与 route.ts 的 AUTO_APPROVE 注释同源）：Map 是单实例内存态，
 * Vercel serverless 多实例下 abort 请求可能落在另一 lambda，返回 404——
 * 前端此时仅本地断流（LLM 费用跑到该实例函数超时为止）。单实例/自托管部署
 * 下完全可靠。globalThis 缓存仅为 Next dev 热更新间保住表内容。
 */

interface ActiveRun {
  controller: AbortController;
  startTime: number;
}

const globalForRuns = globalThis as unknown as {
  __pipelineActiveRuns?: Map<string, ActiveRun>;
};

const activeRuns = (globalForRuns.__pipelineActiveRuns ??= new Map());

/** 注册一次运行；同一用户已有活跃运行时先取消旧的（防重复提交并发跑两条） */
export function registerRun(userId: string): AbortController {
  const existing = activeRuns.get(userId);
  if (existing) {
    existing.controller.abort();
    activeRuns.delete(userId);
  }
  const controller = new AbortController();
  activeRuns.set(userId, { controller, startTime: Date.now() });
  return controller;
}

export function getRun(userId: string): AbortController | undefined {
  return activeRuns.get(userId)?.controller;
}

export function unregisterRun(
  userId: string,
  controller: AbortController,
): void {
  // 仅当表内仍是本次运行的 controller 时删除，避免误删后注册的新运行
  if (activeRuns.get(userId)?.controller === controller) {
    activeRuns.delete(userId);
  }
}
