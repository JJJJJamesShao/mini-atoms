import { NextRequest } from "next/server";
import { getProjectsForUser } from "@/lib/db/projects";
import { createAuthClient } from "@/lib/supabase/auth-server";

const json = (payload: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** GET /api/projects — 返回当前登录用户的项目列表（含 user_id 为 null 的演示数据） */
export async function GET(_req: NextRequest) {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  try {
    const projects = await getProjectsForUser(user.id);
    return json({ projects });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}
