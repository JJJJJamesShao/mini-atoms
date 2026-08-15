import { createAuthClient } from "@/lib/supabase/auth-server";
import { getRun } from "../runs";

export const runtime = "nodejs";

/**
 * POST /api/pipeline/abort — 中止当前用户正在执行的 Pipeline。
 *
 * 取消该用户在本文档实例上注册的 AbortController，进行中的 LLM 流式调用
 * 随即抛出中止异常并走 route.ts 的中止收尾（落库"用户手动停止"+ SSE aborted）。
 *
 * serverless 多实例下请求可能落在没有该运行的实例 → 404（见 runs.ts 注释），
 * 前端对 404 按"仅本地断流"降级处理，不视为错误。
 */
export async function POST() {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return Response.json(
      { error: "unauthorized", message: "请先登录" },
      { status: 401 },
    );
  }

  const controller = getRun(user.id);
  if (!controller) {
    return Response.json(
      { error: "NO_ACTIVE_RUN", message: "当前没有正在执行的 Pipeline" },
      { status: 404 },
    );
  }

  controller.abort();
  return Response.json({ success: true, message: "Pipeline 已中止" });
}
