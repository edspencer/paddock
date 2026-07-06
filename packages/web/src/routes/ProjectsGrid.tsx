import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useProjects } from "../lib/projects-context";
import type { Chat, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { TagPill } from "../components/TagPill";
import { ContextRing } from "../components/ContextRing";
import { NewProjectModal } from "../components/NewProjectModal";
import { EditProjectModal } from "../components/EditProjectModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ProjectMenu } from "../components/ProjectMenu";
import {
  ChatIcon,
  ChevronRightIcon,
  ClockIcon,
  PlusIcon,
  SparkIcon,
  XIcon,
} from "../components/icons";
import { relativeTime } from "../lib/format";
import { areaBlurb, areaLabel, INBOX, orderAreaSlugs } from "../lib/areas";

/**
 * The projects grid. Two modes:
 *
 *  - **Full landing** (no `filterTag`): projects are grouped into collapsible
 *    sections by their `group` (area) — Homelab / House / Side Projects / …,
 *    Unsorted last — followed by an **Inbox** section listing one-off chats so
 *    they're findable. Collapse state per section persists in localStorage.
 *  - **Tag filter** (`/tags/:tag`): a flat grid of just the projects carrying
 *    that domain tag, with a clearable filter chip. (No area sections here —
 *    the filter already narrows the set.)
 */
export function ProjectsGrid({ filterTag }: { filterTag?: string } = {}) {
  const { projects: allProjects, loading, error, upsert, remove } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const navigate = useNavigate();

  // When filtering by tag, narrow to projects carrying that domain tag. The
  // full unfiltered list still drives the lazy session-count fetch below.
  const projects = useMemo(
    () => (filterTag ? allProjects.filter((p) => p.domain.includes(filterTag)) : allProjects),
    [allProjects, filterTag],
  );

  // Group the full list into ordered [areaSlug, projects[]] sections.
  const sections = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const p of allProjects) {
      const g = p.group ?? "";
      const bucket = map.get(g);
      if (bucket) bucket.push(p);
      else map.set(g, [p]);
    }
    return orderAreaSlugs(map.keys()).map((slug) => [slug, map.get(slug) ?? []] as const);
  }, [allProjects]);

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

  // One-off chats (the Inbox section). Only on the full landing.
  const [inbox, setInbox] = useState<Chat[]>([]);
  useEffect(() => {
    if (filterTag) return;
    let cancelled = false;
    void api
      .listScratchChats()
      .then((chats) => {
        if (!cancelled) setInbox(chats);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [filterTag]);

  const onCreated = (p: Project) => {
    upsert(p);
    setModalOpen(false);
    navigate(`/projects/${p.slug}`);
  };

  const showEmpty =
    !loading && !error && !filterTag && allProjects.length === 0 && inbox.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-10">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight">
              {filterTag ? (
                <>
                  Projects tagged <span className="text-accent">{filterTag}</span>
                </>
              ) : (
                "Projects"
              )}
            </h1>
            {filterTag ? (
              <p className="mt-1.5 max-w-xl text-sm text-paddock-500">
                {!loading &&
                  `${projects.length} ${projects.length === 1 ? "project" : "projects"} tagged “${filterTag}”.`}{" "}
                <Link to="/" className="text-accent underline-offset-2 hover:underline">
                  View all projects
                </Link>
              </p>
            ) : (
              <p className="mt-1.5 max-w-xl text-sm text-paddock-500">
                Each project is a directory with its own keeper agent and persistent,
                resumable Claude Code sessions — your work, organized and always running.
              </p>
            )}
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

        {/* Active-filter chip — only on /tags/:tag. The "×" clears the filter. */}
        {filterTag && <FilterChip tag={filterTag} onClear={() => navigate("/")} />}

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

        {!loading && projects.length === 0 && !error && filterTag && (
          <NoTagMatchState tag={filterTag} onClear={() => navigate("/")} />
        )}

        {showEmpty && (
          <EmptyState onCreate={() => setModalOpen(true)} onChat={() => navigate("/chat")} />
        )}

        {/* Tag-filtered: a flat grid of matches. */}
        {!loading && filterTag && projects.length > 0 && (
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

        {/* Full landing: collapsible area sections + the Inbox. */}
        {!loading && !filterTag && !showEmpty && (
          <div className="space-y-2">
            {sections.map(([slug, ps]) => (
              <AreaSection
                key={slug || "unsorted"}
                slug={slug}
                projects={ps}
                counts={counts}
                onEdit={setEditing}
                onDelete={setDeleting}
              />
            ))}
            <InboxSection chats={inbox} />
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

/**
 * Read/persist a section's collapsed state in localStorage. Default expanded.
 * Keyed per area slug so each section remembers independently across reloads.
 */
function useCollapsed(key: string): [boolean, () => void] {
  const storageKey = `paddock:area-collapsed:${key}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  return [collapsed, toggle];
}

/** A collapsible section header (shared by area + Inbox sections). */
function SectionHeader({
  open,
  label,
  count,
  blurb,
  onToggle,
}: {
  open: boolean;
  label: string;
  count: number;
  blurb?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group/area flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left hover:bg-paddock-100/60 dark:hover:bg-paddock-800/40"
      aria-expanded={open}
    >
      <ChevronRightIcon
        width={16}
        height={16}
        className={`shrink-0 text-paddock-400 transition-transform ${open ? "rotate-90" : ""}`}
      />
      <h2 className="text-[15px] font-semibold tracking-tight">{label}</h2>
      <span className="rounded-full bg-paddock-200/70 px-2 py-0.5 text-[11px] font-medium text-paddock-500 dark:bg-paddock-800 dark:text-paddock-400">
        {count}
      </span>
      {blurb && (
        <span className="hidden min-w-0 truncate text-xs text-paddock-400 md:inline">
          · {blurb}
        </span>
      )}
    </button>
  );
}

/** One area section: a collapsible header + a grid of that area's project cards. */
function AreaSection({
  slug,
  projects,
  counts,
  onEdit,
  onDelete,
}: {
  slug: string;
  projects: Project[];
  counts: Record<string, Chat[]>;
  onEdit: (p: Project) => void;
  onDelete: (p: Project) => void;
}) {
  const [collapsed, toggle] = useCollapsed(slug || "unsorted");
  const open = !collapsed;
  return (
    <section className="mb-4">
      <SectionHeader
        open={open}
        label={areaLabel(slug)}
        count={projects.length}
        blurb={areaBlurb(slug)}
        onToggle={toggle}
      />
      {open && (
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.slug}
              project={p}
              sessionCount={counts[p.slug]?.length}
              onEdit={() => onEdit(p)}
              onDelete={() => onDelete(p)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The Inbox section: collapsible header + a grid of one-off chat cards. */
function InboxSection({ chats }: { chats: Chat[] }) {
  const [collapsed, toggle] = useCollapsed(INBOX.slug);
  const open = !collapsed;
  if (chats.length === 0) return null;
  return (
    <section className="mb-4">
      <SectionHeader
        open={open}
        label={INBOX.label}
        count={chats.length}
        blurb={INBOX.blurb}
        onToggle={toggle}
      />
      {open && (
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {chats.map((c) => (
            <InboxChatCard key={c.sessionId} chat={c} />
          ))}
        </div>
      )}
    </section>
  );
}

/** A compact card for a one-off chat in the Inbox — links to the chat. */
function InboxChatCard({ chat }: { chat: Chat }) {
  return (
    <Link
      to={`/chat/${encodeURIComponent(chat.sessionId)}`}
      className="card group/card flex flex-col gap-2 !p-4"
    >
      <div className="flex items-center gap-2">
        <ChatIcon width={14} height={14} className="shrink-0 text-paddock-400" />
        <ContextRing tokens={chat.contextTokens} limit={chat.contextLimit} />
        <span className="truncate text-sm font-medium">{chat.name}</span>
      </div>
      {chat.preview && (
        <p className="line-clamp-2 text-xs text-paddock-500 dark:text-paddock-400">
          {chat.preview}
        </p>
      )}
      <div className="mt-auto flex items-center gap-1 text-[11px] text-paddock-400">
        <ClockIcon width={12} height={12} />
        {relativeTime(chat.updatedAt)}
      </div>
    </Link>
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
            <TagPill key={d} tag={d} className="max-w-[10rem] truncate" />
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

/** The active-filter chip shown above the grid on /tags/:tag. The "×" clears
 *  the filter (back to the full grid). */
function FilterChip({ tag, onClear }: { tag: string; onClear: () => void }) {
  return (
    <div className="mb-6 flex items-center gap-2 text-sm text-paddock-500">
      <span>Filtered by</span>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-paddock-200/70 px-2.5 py-1 text-xs font-medium text-paddock-700 dark:bg-paddock-800 dark:text-paddock-200">
        <span aria-hidden>🏷</span>
        <span className="max-w-[14rem] truncate">{tag}</span>
        <button
          type="button"
          aria-label={`Clear ${tag} filter`}
          title="Clear filter"
          onClick={onClear}
          className="-mr-0.5 ml-0.5 flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-black/10 dark:hover:bg-white/10"
        >
          <XIcon width={11} height={11} />
        </button>
      </span>
    </div>
  );
}

/** Empty state for /tags/:tag when no project carries the tag. */
function NoTagMatchState({ tag, onClear }: { tag: string; onClear: () => void }) {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-dashed border-paddock-300 bg-white/50 px-8 py-12 text-center dark:border-paddock-700 dark:bg-paddock-900/40">
      <h2 className="text-lg font-semibold">No projects tagged</h2>
      <p className="mx-auto mt-3 flex items-center justify-center gap-1.5 text-sm text-paddock-500">
        Nothing matches <span className="tag">{tag}</span> right now.
      </p>
      <div className="mt-6 flex items-center justify-center">
        <button className="btn-ghost" onClick={onClear}>
          <XIcon width={16} height={16} />
          Clear filter
        </button>
      </div>
    </div>
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
