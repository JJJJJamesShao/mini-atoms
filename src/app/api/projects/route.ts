import { NextRequest } from "next/server";
import { getProjectsForUser } from "@/lib/db/projects";
import { createAuthClient } from "@/lib/supabase/auth-server";

/** 强制 Node.js runtime */
export const runtime = "nodejs";

const json = (payload: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** GET /api/projects — 返回当前登录用户的项目列表 */
export async function GET(_req: NextRequest) {
  try {
    const auth = await createAuthClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const projects = await getProjectsForUser(user.id);
    return json({ projects });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[GET /api/projects]", msg);
    return json(
      { error: msg, hint: "检查 SUPABASE_URL / SUPABASE_SECRET_KEY 环境变量" },
      500,
    );
  }
}
