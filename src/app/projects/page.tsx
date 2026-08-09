import Link from "next/link";
import { redirect } from "next/navigation";
import { getProjectsForUser } from "@/lib/db/projects";
import { getVersions } from "@/lib/db/versions";
import { createAuthClient } from "@/lib/supabase/auth-server";

export const dynamic = "force-dynamic";

/** 项目列表：服务端先校验登录态（未登录 redirect），再按当前用户取数 */
export default async function ProjectsPage() {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/auth/login");

  let rows: { id: string; title: string; created_at: string; count: number }[];
  try {
    const projects = await getProjectsForUser(user.id);
    rows = await Promise.all(
      projects.map(async (p) => ({
        id: p.id,
        title: p.title,
        created_at: p.created_at,
        count: (await getVersions(p.id)).length,
      })),
    );
  } catch (err) {
    return (
      <main className="p-8">
        <h1 className="mb-6 text-2xl font-bold">我的项目</h1>
        <p className="text-sm text-red-600">
          项目加载失败：{err instanceof Error ? err.message : String(err)}
        </p>
      </main>
    );
  }

  return (
    <main className="p-8">
      <h1 className="mb-6 text-2xl font-bold">我的项目</h1>
      <div className="grid gap-4">
        {rows.length === 0 && (
          <p className="text-sm text-neutral-500">暂无项目</p>
        )}
        {rows.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="block rounded-xl border border-[#e5e5e5] bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-neutral-700 dark:bg-neutral-900"
          >
            <h2 className="font-medium">{p.title}</h2>
            <p className="text-sm text-neutral-500">
              {p.count} 个版本 · {new Date(p.created_at).toLocaleString()}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
