import Link from "next/link";
import AuthGuard from "@/app/components/AuthGuard";
import { getProjects } from "@/lib/db/projects";
import { getVersions } from "@/lib/db/versions";

export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return (
    <AuthGuard>
      <ProjectsList />
    </AuthGuard>
  );
}

/** 项目列表：服务端直读 Supabase（TODO: 接入 Auth 后按 user_id 过滤） */
async function ProjectsList() {
  let rows: { id: string; title: string; created_at: string; count: number }[];
  try {
    const projects = await getProjects();
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
