import { useId, useMemo } from "react";
import { NavLink, useMatch } from "react-router-dom";
import type { Project } from "../lib/types";
import { areaLabel } from "../lib/areas";
import { useAreaCollapsed } from "../lib/areaCollapsed";
import { TagPill } from "./TagPill";
import { ProjectChip } from "./ProjectChip";
import { ChevronRightIcon } from "./icons";

/** Per-workspace sidebar counts (#161): unread replies + in-flight turns. */
export interface ProjectBadge {
  unread: number;
  inflight: number;
}

/**
 * The sidebar's project list, grouped by area in the landing page's order.
 * Headings only appear when more than one area is in play, and each heading
 * folds its group — the same fold the `/projects` grid's section header
 * toggles, since both read `lib/areaCollapsed.ts`.
 */
export function SidebarProjectList({
  sections,
  badges,
  chipColors,
}: {
  sections: ReadonlyArray<readonly [string, Project[]]>;
  badges: ReadonlyMap<string, ProjectBadge>;
  chipColors: ReadonlyMap<string, string>;
}) {
  // The project the current route is inside, if any. A folded group still shows
  // this one row, so collapsing never hides where you are.
  const activeSlug = useMatch("/projects/:slug/*")?.params.slug;
  const showHeadings = sections.length > 1;
  return (
    <>
      {sections.map(([slug, ps]) => (
        <SidebarGroup
          key={slug || "unsorted"}
          slug={slug}
          projects={ps}
          badges={badges}
          chipColors={chipColors}
          activeSlug={activeSlug}
          showHeading={showHeadings}
        />
      ))}
    </>
  );
}

function SidebarGroup({
  slug,
  projects,
  badges,
  chipColors,
  activeSlug,
  showHeading,
}: {
  slug: string;
  projects: Project[];
  badges: ReadonlyMap<string, ProjectBadge>;
  chipColors: ReadonlyMap<string, string>;
  activeSlug?: string;
  showHeading: boolean;
}) {
  const [collapsed, toggle] = useAreaCollapsed(slug);
  const listId = useId();
  // With no heading there is nothing to unfold it with, so a fold persisted
  // from the grid (or from when there were more areas) must not hide anything.
  const folded = showHeading && collapsed;
  const visible = folded ? projects.filter((p) => p.slug === activeSlug) : projects;

  // What a folded heading reports: the badges of the rows it HIDES. The active
  // row stays visible with its own badge, so counting it here too would show
  // the same reply twice and read as a second one somewhere in the group.
  const rollup = useMemo(() => {
    const sum: ProjectBadge = { unread: 0, inflight: 0 };
    if (!folded) return sum;
    for (const p of projects) {
      if (p.slug === activeSlug) continue;
      const b = badges.get(p.slug);
      sum.unread += b?.unread ?? 0;
      sum.inflight += b?.inflight ?? 0;
    }
    return sum;
  }, [folded, projects, activeSlug, badges]);

  return (
    <div className="mb-2">
      {showHeading && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={listId}
          title={collapsed ? "Expand group" : "Collapse group"}
          className="flex w-full items-center gap-1 rounded-md px-2.5 pb-1 pt-2 text-left text-3xs font-semibold uppercase tracking-wider text-fg-subtle hover:text-fg-muted focus-visible:focus-ring"
        >
          <ChevronRightIcon
            width={10}
            height={10}
            aria-hidden="true"
            className={`-ml-0.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="min-w-0 truncate">{areaLabel(slug)}</span>
          {/* Reset the heading's caps/tracking so the pill reads exactly like a row's. */}
          <ProjectBadges
            badge={rollup}
            className="ml-auto font-normal normal-case tracking-normal"
          />
        </button>
      )}
      <div id={listId}>
        {visible.map((p) => (
          <ProjectNavLink
            key={p.slug}
            project={p}
            badge={badges.get(p.slug)}
            chipColor={chipColors.get(p.slug)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A single project entry in the sidebar nav (name + chat-count badges + up to
 * two tags). Per #161 the per-row project StatusPill is gone (status stays
 * editable in Settings); its space now shows two subtle, glanceable counts:
 * unread replies (primary) and in-flight turns (secondary), each only when > 0.
 */
function ProjectNavLink({
  project: p,
  badge,
  chipColor,
}: {
  project: Project;
  badge?: ProjectBadge;
  chipColor?: string;
}) {
  return (
    <NavLink
      to={`/projects/${p.slug}`}
      className={({ isActive }) =>
        `group mb-0.5 flex flex-col gap-1 rounded-lg px-2.5 py-2 text-sm transition-colors ${
          isActive ? "bg-surface-selected" : "hover:bg-surface-hover"
        }`
      }
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {/* The project's chip (#958): its initial on a colour hashed from the
              slug, the same derivation the favicon uses. 16px sits inside the
              20px `text-sm` line box, so the row is no taller than it was. */}
          <ProjectChip slug={p.slug} name={p.name} color={chipColor} />
          <span className="truncate font-medium">{p.name}</span>
        </span>
        <ProjectBadges badge={badge} />
      </span>
      {p.domain.length > 0 && (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden pl-[22px]">
          {p.domain.slice(0, 2).map((d) => (
            <TagPill key={d} tag={d} className="max-w-[7rem] truncate" />
          ))}
          {p.domain.length > 2 && (
            <span className="shrink-0 text-2xs text-fg-subtle">+{p.domain.length - 2}</span>
          )}
        </span>
      )}
    </NavLink>
  );
}

/**
 * The two subtle per-workspace counts shown where the StatusPill used to live
 * (#161): a filled accent pill for UNREAD replies (primary) and a hollow
 * spinner + count for IN-FLIGHT turns (secondary). Each renders only when > 0;
 * nothing renders when the workspace is quiet, keeping the row calm.
 *
 * Shared verbatim by the project rows, the ROOT workspace's Home link (#553)
 * and a folded group heading's roll-up — `className` exists only so Home and
 * the heading can push it right with `ml-auto`. The "nothing at all when
 * quiet" rule lives HERE, which is what keeps a zero-chat root (or a quiet
 * folded group) from rendering an empty wrapper or a `0` pill.
 */
export function ProjectBadges({ badge, className = "" }: { badge?: ProjectBadge; className?: string }) {
  const unread = badge?.unread ?? 0;
  const inflight = badge?.inflight ?? 0;
  if (unread === 0 && inflight === 0) return null;
  return (
    <span className={`flex shrink-0 items-center gap-1.5 ${className}`}>
      {inflight > 0 && (
        <span
          className="flex items-center gap-1 text-2xs tabular text-fg-muted"
          title={`${inflight} chat${inflight === 1 ? "" : "s"} in flight`}
          aria-label={`${inflight} chat${inflight === 1 ? "" : "s"} in flight`}
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 spin-eco rounded-full border-[1.5px] border-edge-strong border-t-transparent"
          />
          {inflight}
        </span>
      )}
      {unread > 0 && (
        <span
          className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-accent-solid px-1.5 py-0.5 text-2xs font-semibold leading-none tabular text-accent-fg"
          title={`${unread} unread ${unread === 1 ? "reply" : "replies"}`}
          aria-label={`${unread} unread ${unread === 1 ? "reply" : "replies"}`}
        >
          {unread}
        </span>
      )}
    </span>
  );
}
