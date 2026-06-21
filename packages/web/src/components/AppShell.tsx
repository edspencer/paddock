import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useProjects } from "../lib/projects-context";
import type { Project } from "../lib/types";
import { StatusPill } from "./StatusPill";
import { NewProjectModal } from "./NewProjectModal";
import { ChatIcon, FolderIcon, PlusIcon } from "./icons";

export function AppShell() {
  const { projects, loading, upsert } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();

  const onCreated = (p: Project) => {
    upsert(p);
    setModalOpen(false);
    navigate(`/projects/${p.slug}`);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-canvas dark:bg-canvas-dark">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-paddock-200 bg-white/50 dark:border-paddock-800 dark:bg-paddock-900/30">
        <div className="flex items-center gap-2 px-5 py-4">
          <NavLink to="/" className="group flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-base text-white shadow-sm">
              🐎
            </span>
            <span className="text-[17px] font-semibold tracking-tight">Paddock</span>
          </NavLink>
        </div>

        <div className="space-y-1.5 px-3 pb-1">
          <button className="btn-primary w-full" onClick={() => setModalOpen(true)}>
            <PlusIcon width={16} height={16} />
            New Project
          </button>
          <button className="btn-subtle w-full justify-start" onClick={() => navigate("/chat")}>
            <ChatIcon width={16} height={16} />
            New one-off chat
          </button>
        </div>

        <div className="mt-5 mb-1 flex items-center justify-between pr-4">
          <span className="section-label">Projects</span>
          {projects.length > 0 && (
            <span className="text-[11px] text-paddock-400">{projects.length}</span>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {loading && (
            <div className="space-y-2 px-2 py-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-lg bg-paddock-200/60 dark:bg-paddock-800/50"
                />
              ))}
            </div>
          )}
          {!loading && projects.length === 0 && (
            <p className="px-3 py-2 text-sm text-paddock-500">No projects yet.</p>
          )}
          {projects.map((p) => (
            <NavLink
              key={p.slug}
              to={`/projects/${p.slug}`}
              className={({ isActive }) =>
                `group mb-0.5 flex flex-col gap-1 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-paddock-200/80 dark:bg-paddock-800"
                    : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
                }`
              }
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderIcon
                    width={13}
                    height={13}
                    className="shrink-0 text-paddock-400 group-hover:text-paddock-500"
                  />
                  <span className="truncate font-medium">{p.name}</span>
                </span>
                <StatusPill status={p.status} />
              </span>
              {p.domain.length > 0 && (
                <span className="flex min-w-0 items-center gap-1 overflow-hidden pl-[18px]">
                  {p.domain.slice(0, 2).map((d) => (
                    <span key={d} className="tag max-w-[7rem] truncate">
                      {d}
                    </span>
                  ))}
                  {p.domain.length > 2 && (
                    <span className="shrink-0 text-[11px] text-paddock-400">
                      +{p.domain.length - 2}
                    </span>
                  )}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-paddock-200 px-5 py-3 text-[11px] text-paddock-400 dark:border-paddock-800">
          Project-first Claude Code, hosted.
        </div>
      </aside>

      {/* Main pane */}
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>

      <NewProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={onCreated}
      />
    </div>
  );
}
