import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useProjects } from "../lib/projects-context";
import type { Chat, Project } from "../lib/types";
import { StatusPill, statusRail } from "../components/StatusPill";
import { TagPill } from "../components/TagPill";
import { NewProjectModal } from "../components/NewProjectModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ProjectMenu } from "../components/ProjectMenu";
import {
  BranchIcon,
  ChatIcon,
  ChevronRightIcon,
  ClockIcon,
  PlusIcon,
  SparkIcon,
  XIcon,
} from "../components/icons";
import { relativeTime } from "../lib/format";
import { areaBlurb, areaLabel, orderAreaSlugs } from "../lib/areas";
import { gridUrl } from "./ProjectView/urls";

/**
 * The projects grid — the root workspace's CHILDREN. Two modes:
 *
 *  - **Full landing** (no `filterTag`): projects are grouped into collapsible
 *    sections by their `group` (area) — Homelab / House / Side Projects / …,
 *    Unsorted last. Collapse state per section persists in localStorage.
 *  - **Tag filter** (`/tags/:tag`): a flat grid of just the projects carrying
 *    that domain tag, with a clearable filter chip. (No area sections here —
 *    the filter already narrows the set.)
 *
 * There used to be a third, `embedded` mode that rendered this list as the first
 * section of the root workspace's Home. #599 replaced that section with Home's
 * running/unread feeds, so the mode is gone and the New Project button it hosted
 * moved to the sidebar's Projects header — which is now the app's canonical
 * entry point for creating a project.
 */
export function ProjectsGrid({ filterTag }: { filterTag?: string } = {}) {
  const { projects: allProjects, loading, error, upsert, remove } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const navigate = useNavigate();
  // Where "back to the grid" points — root Home, which is where the unfiltered
  // list lives now that it is a section of that pane rather than a tab.
  const grid = gridUrl();
  // "Edit" now deep-links to the project's Settings tab (issue #122) rather than
  // opening a modal — the tab is the single source of truth for project settings.
  const editProject = useCallback(
    (p: Project) => navigate(`/projects/${p.slug}/settings`),
    [navigate],
  );

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

  const onCreated = (p: Project) => {
    upsert(p);
    setModalOpen(false);
    // A brand-new project has an empty Home, so start the user in a new chat.
    // (Re-opening an existing project lands on Home — see ProjectRedirect.)
    navigate(`/projects/${p.slug}/chat`);
  };

  const showEmpty =
    !loading && !error && !filterTag && allProjects.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-3 py-5 sm:px-8 sm:py-10">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {filterTag ? (
                <>
                  Projects tagged <span className="text-accent">{filterTag}</span>
                </>
              ) : (
                "Projects"
              )}
            </h1>
            {filterTag ? (
              <p className="mt-1.5 max-w-xl text-sm text-fg-muted">
                {!loading &&
                  `${projects.length} ${projects.length === 1 ? "project" : "projects"} tagged “${filterTag}”.`}{" "}
                <Link to={grid} className="text-accent underline-offset-2 hover:underline">
                  View all projects
                </Link>
              </p>
            ) : (
              <p className="mt-1.5 max-w-xl text-sm text-fg-muted">
                Each project is a directory with persistent, resumable Claude Code
                sessions — your work, organized and always running.
              </p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
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
        {filterTag && <FilterChip tag={filterTag} onClear={() => navigate(grid)} />}

        {error && (
          <div className="mb-6 rounded-lg border border-danger-edge bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {loading && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-2xl border border-edge bg-surface-raised"
              />
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && !error && filterTag && (
          <NoTagMatchState tag={filterTag} onClear={() => navigate(grid)} />
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
                onEdit={() => editProject(p)}
                onDelete={() => setDeleting(p)}
              />
            ))}
          </div>
        )}

        {/* Full landing: collapsible area sections. */}
        {!loading && !filterTag && !showEmpty && (
          <div className="space-y-2">
            {sections.map(([slug, ps]) => (
              <AreaSection
                key={slug || "unsorted"}
                slug={slug}
                projects={ps}
                counts={counts}
                onEdit={editProject}
                onDelete={setDeleting}
              />
            ))}
          </div>
        )}
      </div>

      <NewProjectModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={onCreated} />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete project?"
        message={
          <>
            <span className="font-medium text-fg">{deleting?.name}</span> and
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

/** A collapsible section header for an area section. */
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
      className="group/area flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left hover:bg-surface-hover"
      aria-expanded={open}
    >
      <ChevronRightIcon
        width={16}
        height={16}
        className={`shrink-0 text-fg-subtle transition-transform ${open ? "rotate-90" : ""}`}
      />
      <h2 className="text-md font-semibold tracking-tight">{label}</h2>
      <span className="rounded-full bg-surface-active px-2 py-0.5 text-2xs font-medium text-fg-muted">
        {count}
      </span>
      {blurb && (
        <span className="hidden min-w-0 truncate text-xs text-fg-subtle md:inline">
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
    // `phosphor`: the card wears the same status RAIL as every other record in
    // the app, so a wall of six reads as a fleet you can scan by colour rather
    // than six identical boxes you have to read. The slug — the identifier the
    // URL and the filesystem actually use — is machine truth, so it sits under
    // the name in the mono; the name and the summary are language.
    <Link
      to={`/projects/${project.slug}`}
      className={`card group/card relative flex flex-col gap-3 border-l-2 ${statusRail(project.status)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="min-w-0 line-clamp-2 font-semibold leading-snug">{project.name}</h2>
          <p className="truncate font-mono text-3xs text-fg-subtle">{project.slug}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {project.dirty ? (
            <span
              title={`${project.dirty} uncommitted change${project.dirty === 1 ? "" : "s"} — open the Changes tab`}
              className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-1.5 py-0.5 text-3xs font-semibold text-warn"
            >
              <BranchIcon width={10} height={10} />
              {project.dirty}
            </span>
          ) : null}
          <StatusPill status={project.status} />
          <ProjectMenu
            onEdit={onEdit}
            onDelete={onDelete}
            label={`Actions for ${project.name}`}
          />
        </div>
      </div>
      {project.summary && (
        <p className="line-clamp-3 text-sm text-fg-muted">
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
      {/* Counts and times are compared card-to-card, so they are mono + tabular. */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-edge pt-3 font-mono text-2xs text-fg-subtle tabular">
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
    <div className="mb-6 flex items-center gap-2 text-sm text-fg-muted">
      <span>Filtered by</span>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-active px-2.5 py-1 text-xs font-medium text-fg">
        <span aria-hidden>🏷</span>
        <span className="max-w-[14rem] truncate">{tag}</span>
        <button
          type="button"
          aria-label={`Clear ${tag} filter`}
          title="Clear filter"
          onClick={onClear}
          className="-mr-0.5 ml-0.5 flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-surface-selected"
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
    <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-dashed border-edge bg-surface-raised px-8 py-12 text-center">
      <h2 className="text-lg font-semibold">No projects tagged</h2>
      <p className="mx-auto mt-3 flex items-center justify-center gap-1.5 text-sm text-fg-muted">
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
    <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-dashed border-edge bg-surface-raised px-8 py-12 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <SparkIcon width={26} height={26} />
      </div>
      <h2 className="text-lg font-semibold">Create your first project</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-fg-muted">
        A project gives your work a home — a directory and chat sessions that persist
        and resume. Start one, then chat your way through it.
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
