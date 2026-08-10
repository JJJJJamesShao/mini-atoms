import { NextRequest } from "next/server";
import { createAuthClient } from "@/lib/supabase/auth-server";
import { getPendingGates } from "@/lib/db/gates";

/** 强制 Node.js runtime */
export const runtime = "nodejs";

/**
 * GET /api/gates/pending?projectId=xxx
 * 查询当前用户的挂起门（惰性过期），供页面刷新后重建"等待确认"UI。
 * projectId 提供时只返回该项目的挂起门。
 */
export async function GET(req: NextRequest) {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;

  try {
    const gates = await getPendingGates(user.id, projectId);
    return Response.json({ gates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
