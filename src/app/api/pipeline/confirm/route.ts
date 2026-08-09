import { NextRequest } from "next/server";
import { createAuthClient } from "@/lib/supabase/auth-server";
import { resolveApproval } from "../gate";

const jsonError = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * POST /api/pipeline/confirm
 * approve 确认门的用户决策入口：{ sessionId, approved }
 * 仅允许恢复属于当前登录用户的挂起会话。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (
    !body?.sessionId ||
    typeof body.sessionId !== "string" ||
    typeof body.approved !== "boolean"
  ) {
    return jsonError(400, { error: "缺少 sessionId 或 approved 字段" });
  }

  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return jsonError(401, { error: "unauthorized", message: "请先登录" });
  }

  const ok = resolveApproval(body.sessionId, user.id, body.approved);
  if (!ok) {
    return jsonError(404, {
      error: "session_not_found",
      message: "审批会话不存在或已过期",
    });
  }
  return Response.json({ ok: true });
}
