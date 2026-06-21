import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";

export function ProjectsGrid() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setProjects(await api.listProjects());
      setLoading(false);
    })();
  }, []);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-paddock-500">
          Every project is a directory with its own keeper agent and persistent Claude Code sessions.
        </p>
      </header>

      {loading && <p className="text-sm text-paddock-500">Loading…</p>}

      {!loading && projects.length === 0 && (
        <div className="card text-center text-sm text-paddock-500">
          No projects yet. Use “+ New Project” in the sidebar to create one.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <Link key={p.slug} to={`/projects/${p.slug}`} className="card flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold leading-tight">{p.name}</h2>
              <StatusPill status={p.status} />
            </div>
            {p.summary && (
              <p className="line-clamp-3 text-sm text-paddock-600 dark:text-paddock-400">
                {p.summary}
              </p>
            )}
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
              <div className="flex flex-wrap gap-1">
                {p.domain.map((d) => (
                  <span key={d} className="tag">
                    {d}
                  </span>
                ))}
              </div>
              <span className="text-xs text-paddock-400">updated {p.updated}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
