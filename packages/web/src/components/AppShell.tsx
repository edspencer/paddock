import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { Project } from "../lib/types";
import { StatusPill } from "./StatusPill";
import { NewProjectModal } from "./NewProjectModal";

export function AppShell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    setProjects(await api.listProjects());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreated = (p: Project) => {
    setProjects((prev) => [p, ...prev.filter((x) => x.slug !== p.slug)]);
    navigate(`/projects/${p.slug}`);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-paddock-200 bg-paddock-100/60 dark:border-paddock-800 dark:bg-paddock-900/60">
        <div className="flex items-center gap-2 px-4 py-4">
          <NavLink to="/" className="text-lg font-semibold tracking-tight">
            🐎 Paddock
          </NavLink>
        </div>

        <div className="space-y-2 px-3">
          <button className="btn-primary w-full" onClick={() => setModalOpen(true)}>
            + New Project
          </button>
          <button className="btn-ghost w-full" onClick={() => navigate("/chat/new")}>
            New Chat
          </button>
        </div>

        <div className="mt-5 px-4 text-xs font-semibold uppercase tracking-wide text-paddock-500">
          Projects
        </div>
        <nav className="mt-1 flex-1 overflow-y-auto px-2 pb-4">
          {loading && <p className="px-2 py-2 text-sm text-paddock-500">Loading…</p>}
          {!loading && projects.length === 0 && (
            <p className="px-2 py-2 text-sm text-paddock-500">No projects yet.</p>
          )}
          {projects.map((p) => (
            <NavLink
              key={p.slug}
              to={`/projects/${p.slug}`}
              className={({ isActive }) =>
                `flex flex-col gap-1 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-paddock-200 dark:bg-paddock-800"
                    : "hover:bg-paddock-200/60 dark:hover:bg-paddock-800/60"
                }`
              }
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{p.name}</span>
                <StatusPill status={p.status} />
              </span>
              {p.domain.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {p.domain.slice(0, 3).map((d) => (
                    <span key={d} className="tag">
                      {d}
                    </span>
                  ))}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main pane */}
      <main className="flex-1 overflow-y-auto">
        <Outlet context={{ refresh }} />
      </main>

      <NewProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={onCreated}
      />
    </div>
  );
}
