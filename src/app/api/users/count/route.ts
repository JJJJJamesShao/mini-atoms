import { getSupabase } from "@/lib/supabase/server";

/** 强制 Node.js runtime */
export const runtime = "nodejs";

/** GET /api/users/count — 公开接口：返回当前注册用户总数 */
export async function GET() {
  try {
    const { count, error } = await getSupabase()
      .from("profiles")
      .select("*", { count: "exact", head: true });
    if (error) throw error;
    return new Response(JSON.stringify({ count: count ?? 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ count: 0, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
