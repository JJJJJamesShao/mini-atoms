"use client";

import { useState } from "react";
import HomeHero from "./components/HomeHero";
import PreviewFrame from "./components/PreviewFrame";
import ProjectWorkspace from "./components/ProjectWorkspace";
import Sidebar from "./components/Sidebar";
import { useWorkspace } from "./hooks/useWorkspace";

export default function Home() {
  const [view, setView] = useState<"home" | "workspace">("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const {
    project,
    selectedVersionId,
    awaitingApproval,
    running,
    executionLogs,
    startProject,
    sendFollowUp,
    openScenario,
    selectVersion,
    approve,
    reject,
  } = useWorkspace();

  const handleHeroSubmit = (text: string): boolean => {
    const ok = startProject(text);
    if (ok) setView("workspace");
    return ok;
  };

  const handleOpenProject = (scenarioId: string) => {
    openScenario(scenarioId);
    setView("workspace");
    setSidebarOpen(false);
  };

  const selectedVersion =
    project?.versions.find((v) => v.id === selectedVersionId) ?? null;
  const selectedNo = selectedVersion
    ? project!.versions.indexOf(selectedVersion) + 1
    : 0;
  const preview =
    project && selectedVersion?.html
      ? {
          title: `${project.title} · 版本 ${selectedNo}`,
          html: selectedVersion.html,
        }
      : null;

  return (
    <main className="flex h-screen overflow-hidden">
      {/* 移动端汉堡按钮 */}
      <button
        type="button"
        aria-label="打开导航"
        onClick={() => setSidebarOpen(true)}
        className="fixed top-3 left-3 z-40 rounded-lg border border-[#e5e5e5] bg-white px-2 py-1 text-sm shadow-sm lg:hidden dark:border-neutral-700 dark:bg-neutral-900"
      >
        ☰
      </button>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-30 transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          onHome={() => {
            setView("home");
            setSidebarOpen(false);
          }}
          onOpenProject={handleOpenProject}
        />
      </div>

      {view === "home" || !project ? (
        <HomeHero onSubmit={handleHeroSubmit} />
      ) : (
        <>
          <section className="min-w-0 flex-1">
            <ProjectWorkspace
              project={project}
              selectedVersionId={selectedVersionId}
              awaitingApproval={awaitingApproval}
              running={running}
              executionLogs={executionLogs}
              onSelectVersion={selectVersion}
              onApprove={approve}
              onReject={reject}
              onSend={sendFollowUp}
            />
          </section>
          <section className="hidden w-[45%] shrink-0 border-l border-[#e5e5e5] lg:block dark:border-neutral-700">
            <PreviewFrame preview={preview} />
          </section>
        </>
      )}
    </main>
  );
}
