import Link from "next/link";
import AuthGuard from "@/app/components/AuthGuard";
import PreviewFrame from "@/app/components/PreviewFrame";
import { getProject } from "@/lib/db/projects";
import { getVersions } from "@/lib/db/versions";

export const dynamic = "force-dynamic";

export default function ProjectPage(props: {
  params: Promise<{ id: string }>;
}) {
  return (
    <AuthGuard>
      <ProjectDetail {...props} />
    </AuthGuard>
  );
}

/** 项目详情：版本列表 + 最新版本预览（简化版，只读） */
async function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let project;
  let versions;
  try {
    project = await getProject(id);
    versions = await getVersions(id);
  } catch (err) {
    return (
      <main className="p-8">
        <p className="text-sm text-red-600">
          项目加载失败：{err instanceof Error ? err.message : String(err)}
        </p>
        <Link href="/projects" className="text-sm text-blue-600 underline">
          返回项目列表
        </Link>
      </main>
    );
  }

  const latest = versions[versions.length - 1];
  const html =
    latest?.files.find((f) => f.path === "index.html")?.content ??
    latest?.files[0]?.content ??
    null;

  return (
    <main className="flex h-screen flex-col">
      <div className="flex items-center gap-3 border-b border-[#e5e5e5] px-6 py-3 dark:border-neutral-700">
        <Link
          href="/projects"
          className="text-sm text-[#525252] hover:underline"
        >
          ← 我的项目
        </Link>
        <h1 className="text-lg font-semibold">{project.title}</h1>
        <span className="text-xs text-[#a3a3a3]">{versions.length} 个版本</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-[#e5e5e5] p-3 dark:border-neutral-700">
          <div className="mb-2 text-xs font-medium text-[#a3a3a3]">版本</div>
          <ol className="space-y-1">
            {versions.map((v) => (
              <li
                key={v.id}
                className="rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm dark:border-neutral-700"
              >
                <div className="font-medium">版本 {v.version_no}</div>
                <div className="truncate text-xs text-[#a3a3a3]">
                  {new Date(v.created_at).toLocaleString()}
                </div>
              </li>
            ))}
          </ol>
        </aside>
        <section className="min-w-0 flex-1">
          <PreviewFrame
            preview={
              html ? { title: `${project.title} · 最新版本`, html } : null
            }
          />
        </section>
      </div>
    </main>
  );
}
