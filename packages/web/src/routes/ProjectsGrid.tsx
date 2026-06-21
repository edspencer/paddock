import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useProjects } from "../lib/projects-context";
import type { Chat, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { NewProjectModal } from "../components/NewProjectModal";
import { EditProjectModal } from "../components/EditProjectModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ProjectMenu } from "../components/ProjectMenu";
import { ChatIcon, ClockIcon, PlusIcon, SparkIcon } from "../components/icons";
import { relativeTime } from "../lib/format";

export function ProjectsGrid() {
  const { projects, loading, error, upsert, remove } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const navigate = useNavigate();

  // Per-project session counts (best-effort, populated lazily).
  const [counts, setCounts] = useState<Record<string, Chat[]>>({});
  const slugs = useMemo(() => projects.map((p) => p.slug).join(","), [projects]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      projects.map(async (p) => [p.slug, await api.listProjectChats(p.slug).catch(() => [])] as const),
    ).then((entries) => {
      if (!cancelled) setCounts(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [slugs]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreated = (p: Project) => {
    upsert(p);
    setModalOpen(false);
    navigate(`/projects/${p.slug}`);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-10">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight">Projects</h1>
            <p className="mt-1.5 max-w-xl text-sm text-paddock-500">
              Each project is a directory with its own keeper agent and persistent,
              resumable Claude Code sessions — your work, organized and always running.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={() => navigate("/chat")}>
              <ChatIcon width={16} height={16} />
              New chat
            </button>
            <button className="btn-primary" onClick={() => setModalOpen(true)}>
              <PlusIcon width={16} height={16} />
              New Project
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-6 rounded-lg border border-rose-300/60 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}

        {loading && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-2xl border border-paddock-200 bg-white/60 dark:border-paddock-800 dark:bg-paddock-900/50"
              />
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && !error && (
          <EmptyState onCreate={() => setModalOpen(true)} onChat={() => navigate("/chat")} />
        )}

        {!loading && projects.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard
                key={p.slug}
                project={p}
                sessionCount={counts[p.slug]?.length}
                onEdit={() => setEditing(p)}
                onDelete={() => setDeleting(p)}
              />
            ))}
          </div>
        )}
      </div>

      <NewProjectModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={onCreated} />
      {editing && (
        <EditProjectModal
          open
          project={editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            upsert(p);
            setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete project?"
        message={
          <>
            <span className="font-medium text-ink dark:text-ink-dark">{deleting?.name}</span> and
            all its chats and files will be permanently removed. This cannot be undone.
          </>
        }
        confirmLabel="Delete project"
        onConfirm={async () => {
          if (!deleting) return;
          const slug = deleting.slug;
          await api.deleteProject(slug);
          remove(slug);
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function ProjectCard({
  project,
  sessionCount,
  onEdit,
  onDelete,
}: {
  project: Project;
  sessionCount?: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Link to={`/projects/${project.slug}`} className="card group/card relative flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 line-clamp-2 font-semibold leading-snug">{project.name}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <StatusPill status={project.status} />
          <ProjectMenu
            onEdit={onEdit}
            onDelete={onDelete}
            label={`Actions for ${project.name}`}
          />
        </div>
      </div>
      {project.summary && (
        <p className="line-clamp-3 text-sm text-paddock-600 dark:text-paddock-400">
          {project.summary}
        </p>
      )}
      {project.domain.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {project.domain.slice(0, 4).map((d) => (
            <span key={d} className="tag max-w-[10rem] truncate">
              {d}
            </span>
          ))}
          {project.domain.length > 4 && (
            <span className="tag">+{project.domain.length - 4}</span>
          )}
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-paddock-200/70 pt-3 text-[11px] text-paddock-400 dark:border-paddock-800">
        <span className="inline-flex items-center gap-1">
          <ChatIcon width={12} height={12} />
          {sessionCount == null
            ? "…"
            : `${sessionCount} ${sessionCount === 1 ? "chat" : "chats"}`}
        </span>
        <span className="inline-flex items-center gap-1">
          <ClockIcon width={12} height={12} />
          {relativeTime(project.updated)}
        </span>
      </div>
    </Link>
  );
}

function EmptyState({ onCreate, onChat }: { onCreate: () => void; onChat: () => void }) {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-dashed border-paddock-300 bg-white/50 px-8 py-12 text-center dark:border-paddock-700 dark:bg-paddock-900/40">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <SparkIcon width={26} height={26} />
      </div>
      <h2 className="text-lg font-semibold">Create your first project</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-paddock-500">
        A project gives your work a home — a directory, a dedicated keeper agent, and
        chat sessions that persist and resume. Start one, then chat your way through it.
      </p>
      <div className="mt-6 flex items-center justify-center gap-2">
        <button className="btn-primary" onClick={onCreate}>
          <PlusIcon width={16} height={16} />
          New Project
        </button>
        <button className="btn-ghost" onClick={onChat}>
          <ChatIcon width={16} height={16} />
          Just chat once
        </button>
      </div>
    </div>
  );
}
