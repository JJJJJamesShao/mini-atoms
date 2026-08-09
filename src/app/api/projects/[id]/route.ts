import { NextRequest } from "next/server";
import { deleteProject, getProject, togglePinProject } from "@/lib/db/projects";
import { getVersions } from "@/lib/db/versions";
import { createAuthClient } from "@/lib/supabase/auth-server";

const json = (payload: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** GET /api/projects/:id — 返回项目详情 + 版本列表 + 最新版本 HTML */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { id } = await params;

  try {
    const project = await getProject(id);
    // 归属校验
    if (project.user_id && project.user_id !== user.id) {
      return json({ error: "forbidden" }, 403);
    }

    const versions = await getVersions(id);
    const latest = versions[versions.length - 1];
    const html =
      latest?.files.find((f) => f.path === "index.html")?.content ??
      latest?.files[0]?.content ??
      null;

    return json({
      project,
      versions: versions.map((v) => ({
        id: v.id,
        version_no: v.version_no,
        created_at: v.created_at,
      })),
      latestHtml: html,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}

/** DELETE /api/projects/:id — 删除项目 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { id } = await params;

  try {
    await deleteProject(id, user.id);
    return json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}

/** PATCH /api/projects/:id/pin — 切换 pin 状态 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const pinned = body.pinned === true;

  try {
    await togglePinProject(id, user.id, pinned);
    return json({ success: true, pinned });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}
