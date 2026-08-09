import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useProjects } from "../lib/projects-context";
import { useTheme } from "../lib/theme";
import type { Project } from "../lib/types";
import { getBrand, getOpenApi, logoIsImage } from "../lib/brand";
import { areaLabel, orderAreaSlugs } from "../lib/areas";
import { chatClient } from "../lib/ws";
import {
  CHATS_GONE_EVENT,
  LAST_SEEN_EVENT,
  readLastSeen,
  setServerLastSeen,
} from "../lib/lastSeen";
import { TagPill } from "./TagPill";
import { FleetReadout } from "./FleetReadout";
import { CogIcon, FolderIcon, HomeIcon, LinkIcon, MenuIcon, MoonIcon, PlusIcon, SunIcon, XIcon } from "./icons";
import { NewProjectModal } from "./NewProjectModal";
import { PaneResizer, usePaneWidth } from "./PaneResizer";
import { SIDENAV_PANE } from "../lib/paneWidth";
import { gridUrl, ROOT_KEY } from "../routes/ProjectView/urls";

/**
 * Context handed down to route elements via <Outlet> (#372). A route that hosts
 * its own top bar on mobile (e.g. ProjectView) uses `openNav` to drive the
 * global project-nav drawer from a hamburger it renders inline — so the shell's
 * separate mobile brand row can be dropped and the two rows collapse into one.
 */
export interface ShellOutletContext {
  openNav: () => void;
}

/** Per-workspace sidebar counts (#161): unread replies + in-flight turns. */
interface ProjectBadge {
  unread: number;
  inflight: number;
}

/**
 * Compute per-workspace unread + in-flight counts for the sidebar (#161), with no
 * new fetch or polling:
 *  - UNREAD rides the projects payload's `chatTurns` (`{ sessionId,
 *    lastTurnCompletedAt, lastSeen }`, folded in server-side) compared against
 *    the server-backed `lastSeen` read-state (#160/#189), mirrored locally for
 *    optimistic same-tab clears. Live turn-completions seen over the WS bump it
 *    too, so a reply landing counts without a reload.
 *  - IN-FLIGHT rides the existing WS `chat:active` set (now carrying
 *    `projectSlug`), grouped by workspace — near-real-time, zero polling.
 * Recomputes on projects refresh, WS active changes, and `lastSeen` writes.
 *
 * The argument is a list of WORKSPACES, not projects: the caller appends the
 * ROOT workspace so Home gets the identical badge (#553). Every key in the
 * returned map is a workspace key, and the root's is `""` — so callers must
 * look it up with `badges.get(ROOT_KEY)` and never guard on its truthiness.
 * Nothing in here branches on the key at all, which is the point.
 */
function useProjectBadges(workspaces: Project[]): Map<string, ProjectBadge> {
  // sessionId -> workspace key for every currently-running turn (from the WS set).
  const [active, setActive] = useState<ReadonlyMap<string, string>>(new Map());
  // sessionId -> { slug, at(ms) } completion signals: seeded from the server
  // payload and augmented live when a turn stops. Kept in a ref (not state) so
  // it accumulates across refetches; `version` forces the memo to recompute.
  const completionsRef = useRef(
    new Map<string, { slug: string; at: number; unread?: boolean }>(),
  );
  const [version, setVersion] = useState(0);

  // Fold the server's per-chat completed-turn timestamps in whenever the list
  // changes (keeping the newest per session).
  useEffect(() => {
    const m = completionsRef.current;
    for (const p of workspaces) {
      for (const t of p.chatTurns ?? []) {
        // Fold the server-backed read-state (#189) into the shared cache so the
        // unread count reads from the cross-device source of truth.
        setServerLastSeen(t.sessionId, t.lastSeen);
        const at = Date.parse(t.lastTurnCompletedAt);
        if (!Number.isFinite(at)) continue;
        const prev = m.get(t.sessionId);
        // Refresh the manual unread flag (#458) from the latest payload even when
        // `at` is unchanged — toggling unread doesn't move the completed-turn time.
        if (!prev || at > prev.at) m.set(t.sessionId, { slug: p.slug, at, unread: t.unread });
        else prev.unread = t.unread;
      }
    }
    // #734 — a whole WORKSPACE can go away too. A completion whose slug is no
    // longer in the list belongs to a deleted project: it counts toward a badge
    // the user cannot reach, and it would attach to a NEW project that reuses
    // the slug. Skipped while the list is empty, which is what a not-yet-loaded
    // (or failed) fetch looks like — an unknown list must not zero the badges.
    if (workspaces.length > 0) {
      const known = new Set(workspaces.map((p) => p.slug));
      for (const [sid, c] of m) if (!known.has(c.slug)) m.delete(sid);
    }
    setVersion((v) => v + 1);
  }, [workspaces]);

  // #732: forget a chat's completion the moment it is deleted. Without this the
  // badge keeps counting a chat there is nothing left to open to clear — the
  // server payload no longer carries it, but this cache is a ref that only ever
  // grew, and under the default `session` drive mode its entries come from live
  // WS completions that no server payload can retract.
  useEffect(() => {
    const forget = (e: Event) => {
      const ids = (e as CustomEvent<{ sessionIds?: string[] }>).detail?.sessionIds ?? [];
      let changed = false;
      for (const id of ids) changed = completionsRef.current.delete(id) || changed;
      if (changed) setVersion((v) => v + 1);
    };
    window.addEventListener(CHATS_GONE_EVENT, forget);
    return () => window.removeEventListener(CHATS_GONE_EVENT, forget);
  }, []);

  // Live in-flight set + a completion signal each time a turn stops running.
  useEffect(() => {
    const prev = new Map<string, string>();
    return chatClient.onActiveInfos((infos) => {
      for (const [sid, slug] of prev) {
        if (!infos.has(sid)) completionsRef.current.set(sid, { slug, at: Date.now() });
      }
      prev.clear();
      for (const [sid, slug] of infos) prev.set(sid, slug);
      setActive(new Map(infos));
      setVersion((v) => v + 1);
    });
  }, []);

  // Recompute when a `lastSeen` marker changes (opening a chat clears its
  // unread). Same-tab custom event only: read-state is server-authoritative
  // (#488), so there's no localStorage to raise a cross-tab `storage` event —
  // another tab's mark-seen arrives with the next refetch.
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(LAST_SEEN_EVENT, bump);
    return () => window.removeEventListener(LAST_SEEN_EVENT, bump);
  }, []);

  return useMemo(() => {
    const badges = new Map<string, ProjectBadge>();
    const ensure = (slug: string): ProjectBadge => {
      let b = badges.get(slug);
      if (!b) {
        b = { unread: 0, inflight: 0 };
        badges.set(slug, b);
      }
      return b;
    };
    for (const [sid, { slug, at, unread }] of completionsRef.current) {
      // A currently-running turn hasn't "landed" a reply yet — count it only as
      // in-flight below, never as unread. Otherwise it's unread if the user
      // manually flagged it (#458) or a reply landed since they last saw it.
      if (!active.has(sid) && (unread || at > readLastSeen(sid))) ensure(slug).unread += 1;
    }
    for (const slug of active.values()) ensure(slug).inflight += 1;
    return badges;
    // `version` is the recompute trigger (completionsRef mutates in place).
  }, [active, version]);
}

export function AppShell() {
  const { projects, rootWorkspace, loading, upsert } = useProjects();
  const { dark, toggle: toggleTheme } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  // The New Project modal now hangs off the sidebar (#599). It used to live in
  // the projects grid on root Home, which was the app's ONLY way to make a
  // project; deleting that section without moving this would have removed the
  // ability entirely.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const brand = getBrand();
  const openapi = getOpenApi();
  // Desktop-only draggable width for the side-nav (#374), persisted per-browser.
  const sidenav = usePaneWidth(SIDENAV_PANE);

  // Project routes render their own single-row mobile header (with an inline
  // hamburger fed by the Outlet context below), so the shell's separate brand
  // row is dropped there to avoid stacking two rows of chrome (#372). Other
  // routes (grid, tags) keep the shell's mobile brand bar.
  // The root workspace's flat top-level routes (#516) mount the SAME ProjectView,
  // so they host their own header too. `/projects` is listed even though it only
  // ever redirects to `/`: it still renders one frame on the way, and dropping
  // it would flash the shell's mobile brand row before the redirect lands.
  const rootRoute =
    location.pathname === "/" ||
    location.pathname === "/projects" ||
    location.pathname.startsWith("/chat");
  const routeOwnsMobileHeader = location.pathname.startsWith("/projects/") || rootRoute;

  // The mobile nav is an off-canvas drawer; close it on any navigation so a
  // project/chat tap doesn't leave it covering the content.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Keep the document title in sync with the brand name (covers dev, where the
  // server doesn't inject the <title>; production already ships it injected).
  useEffect(() => {
    document.title = brand.name;
  }, [brand.name]);

  // Group the sidebar list by area, in the same order as the landing page.
  // Subheaders only appear when there's more than one area in play.
  const sections = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const p of projects) {
      const g = p.group ?? "";
      const bucket = map.get(g);
      if (bucket) bucket.push(p);
      else map.set(g, [p]);
    }
    return orderAreaSlugs(map.keys()).map((slug) => [slug, map.get(slug) ?? []] as const);
  }, [projects]);

  // Badges are computed over EVERY badge-bearing sidebar row — the project list
  // plus Home — so the root is appended to the same array the hook already
  // folded (#553). It stays out of `projects`/`sections`, which drive the list
  // itself. Memoized: the hook's fold effect is keyed on this array's identity,
  // so a fresh one per render would loop.
  const badgeWorkspaces = useMemo(
    () => (rootWorkspace ? [...projects, rootWorkspace] : projects),
    [projects, rootWorkspace],
  );
  const badges = useProjectBadges(badgeWorkspaces);
  // `""` is the ROOT workspace's key — a real key, and the reason this reads
  // `ROOT_KEY` rather than a falsy-guarded lookup.
  const rootBadge = badges.get(ROOT_KEY);
  // The fleet's unread total, for the readout above the outlet (#784). Summed
  // from the SAME badges the sidebar rows show rather than fetched: two numbers
  // for one fact drift apart, and the strip sits inches from the badges it would
  // be contradicting. It is also why the readout costs nothing while idle — this
  // fold is over a payload the app already has.
  const fleetUnread = useMemo(() => {
    let n = 0;
    for (const b of badges.values()) n += b.unread;
    return n;
  }, [badges]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-surface lg:flex-row">
      {/* Mobile top bar — hidden on lg+, where the sidebar is always present.
          Also dropped on project routes, which host their own single-row header
          (with an inline hamburger) so the two rows collapse into one (#372). */}
      {!routeOwnsMobileHeader && (
        <header className="pt-safe flex items-center gap-2 border-b border-edge px-3 pb-2 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="btn-subtle -ml-1 px-2 py-2"
          >
            <MenuIcon width={20} height={20} />
          </button>
          <NavLink to="/" className="flex items-center gap-2">
            <BrandLogo brand={brand} className="h-7 w-7 text-sm" />
            <span className="text-md font-semibold tracking-tight">{brand.name}</span>
          </NavLink>
        </header>
      )}

      {/* Drawer backdrop (mobile only, when open). */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-overlay backdrop-blur-sm lg:hidden"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* Sidebar — a static column on lg+, an off-canvas drawer on mobile. */}
      <aside
        style={sidenav.style}
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 flex-col border-r border-edge bg-surface shadow-2xl transition-transform duration-200 ease-out lg:relative lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-surface-raised/50 lg:shadow-none ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {sidenav.isDesktop && (
          <PaneResizer
            spec={sidenav.spec}
            width={sidenav.width}
            onPreview={sidenav.preview}
            onCommit={sidenav.commit}
            onReset={sidenav.reset}
            label="Resize sidebar"
          />
        )}
        <div className="flex items-center gap-2 px-5 py-4">
          <NavLink to="/" className="group flex items-center gap-2">
            <BrandLogo brand={brand} className="h-8 w-8 text-base" />
            <span className="text-lg font-semibold tracking-tight">{brand.name}</span>
          </NavLink>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
            className="btn-subtle ml-auto px-2 py-2 lg:hidden"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>

        {/* One nav item, not two CTAs. "New Project" and "New root chat" both
            lived here and both duplicated something the destination already
            offers: root Home now carries the projects list (with its own New
            Project action) and the New chat button. So the sidebar's job is to
            get you to Home; Home's job is to start things.

            Home is the ROOT workspace's row, so it carries the same unread /
            in-flight counts a project row does — same component, same data,
            same thresholds (#553). `ml-auto` is the only difference: a project
            row is a `justify-between` flex, this one is a `justify-start`
            button. */}
        <div className="px-3 pb-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `btn-subtle w-full justify-start ${isActive ? "bg-surface-selected" : ""}`
            }
            title="The root workspace — every project, and the instance's own chats"
          >
            <HomeIcon width={16} height={16} />
            Home
            <ProjectBadges badge={rootBadge} className="ml-auto" />
          </NavLink>
        </div>

        <div className="mt-5 mb-1 flex items-center justify-between pr-3">
          {/* Points at the grid page, which `gridUrl()` moved back to
              `/projects` when #599 took the grid off root Home. The sidebar
              list below is the fast path; the grid is the one that shows
              summaries, tags and per-area grouping. */}
          <NavLink to={gridUrl()} className="section-label hover:text-accent">
            Projects
          </NavLink>
          {/* Where the project COUNT used to sit (#599). The count answered a
              question nobody asks — the list is right underneath — while the
              one genuinely useful action here had no home at all: New Project
              lived only inside root Home's projects grid, which #599 deleted.
              Same `+` affordance as the chat sidebar's New chat, in the same
              place relative to its list. */}
          <button
            type="button"
            onClick={() => setNewProjectOpen(true)}
            aria-label="New Project"
            title="New Project"
            className="btn-subtle -mr-1 px-1.5 py-1 text-fg-subtle hover:text-accent"
          >
            <PlusIcon width={14} height={14} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {loading && (
            <div className="space-y-2 px-2 py-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-lg bg-surface-active"
                />
              ))}
            </div>
          )}
          {!loading && projects.length === 0 && (
            <p className="px-3 py-2 text-sm text-fg-muted">No projects yet.</p>
          )}
          {!loading &&
            projects.length > 0 &&
            sections.map(([slug, ps]) => (
              <div key={slug || "unsorted"} className="mb-2">
                {sections.length > 1 && (
                  <div className="px-2.5 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-fg-subtle">
                    {areaLabel(slug)}
                  </div>
                )}
                {ps.map((p) => (
                  <ProjectNavLink key={p.slug} project={p} badge={badges.get(p.slug)} />
                ))}
              </div>
            ))}
        </nav>

        <div className="border-t border-edge px-3 py-3">
          {/* INSTANCE config, not workspace settings — it writes
              `paddock.config.yaml` (branding, capabilities, limits) and every
              save is restart-required. A workspace's own settings are its
              Settings TAB, at `/settings` for the root. The two were one screen
              until they were split; naming this after the file it writes is what
              keeps them apart. */}
          <NavLink
            to="/config"
            className={({ isActive }) =>
              `btn-subtle w-full justify-start ${isActive ? "bg-surface-selected" : ""}`
            }
            title="Instance config — paddock.config.yaml (restart required)"
          >
            <CogIcon width={15} height={15} />
            Config
          </NavLink>
          {openapi.enabled && (
            <a
              href={openapi.path}
              target="_blank"
              rel="noreferrer"
              className="btn-subtle mt-1 w-full justify-start"
              title="OpenAPI / Swagger reference (opens in a new tab)"
            >
              <LinkIcon width={15} height={15} />
              Swagger API
            </a>
          )}
          <button
            type="button"
            onClick={toggleTheme}
            className="btn-subtle mt-1 w-full justify-start"
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            title="Toggle light / dark theme"
          >
            {dark ? <SunIcon width={15} height={15} /> : <MoonIcon width={15} height={15} />}
            {dark ? "Light mode" : "Dark mode"}
          </button>
          <p className="mt-2 px-2 text-2xs text-fg-subtle">v{__APP_VERSION__}</p>
        </div>
      </aside>

      {/* Main pane. The Suspense boundary covers the lazily-loaded route chunks
          (issue #11) — a brief, unobtrusive fallback while a route's JS loads.

          The fleet readout sits ABOVE the outlet rather than in the sidebar: it
          has to be visible on every route including a maximised chat, and the
          sidebar is an off-canvas drawer below `lg`. It is a fixed-height,
          non-shrinking row, so the route below keeps its own `100dvh`-minus-chrome
          scroll behaviour unchanged. */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <FleetReadout unreadCount={fleetUnread} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<RouteFallback />}>
            <Outlet context={{ openNav: () => setNavOpen(true) } satisfies ShellOutletContext} />
          </Suspense>
        </div>
      </main>

      {/* Mounted at the SHELL, not in a route, because the sidebar that opens it
          outlives every route. `onCreated` mirrors what the projects grid did:
          fold the new project into the shared context so the sidebar shows it
          immediately, then land the user in a chat — a brand-new project's Home
          has nothing running and nothing unread, so there is nothing to look at
          there yet. */}
      <NewProjectModal
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(p: Project) => {
          upsert(p);
          setNewProjectOpen(false);
          navigate(`/projects/${p.slug}/chat`);
        }}
      />
    </div>
  );
}

/**
 * The instance logo chip (issue #34). Renders the configured logo as an <img>
 * when it's a URL/path, otherwise as an inline glyph/emoji. The accent-colored
 * chip background comes from the runtime `--accent` CSS variable via `bg-accent-solid`.
 */
function BrandLogo({ brand, className = "" }: { brand: ReturnType<typeof getBrand>; className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent-solid text-accent-fg shadow-sm ${className}`}
    >
      {logoIsImage(brand.logo) ? (
        <img src={brand.logo} alt="" className="h-full w-full object-cover" />
      ) : (
        brand.logo
      )}
    </span>
  );
}

/** Placeholder shown while a lazily-loaded route chunk is fetching (issue #11). */
function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true" aria-live="polite">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-edge-strong border-t-accent" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/**
 * A single project entry in the sidebar nav (name + chat-count badges + up to
 * two tags). Per #161 the per-row project StatusPill is gone (status stays
 * editable in Settings); its space now shows two subtle, glanceable counts:
 * unread replies (primary) and in-flight turns (secondary), each only when > 0.
 */
function ProjectNavLink({ project: p, badge }: { project: Project; badge?: ProjectBadge }) {
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
          <FolderIcon
            width={13}
            height={13}
            className="shrink-0 text-fg-subtle group-hover:text-fg-muted"
          />
          <span className="truncate font-medium">{p.name}</span>
        </span>
        <ProjectBadges badge={badge} />
      </span>
      {p.domain.length > 0 && (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden pl-[18px]">
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
 * Shared verbatim by the project rows and the ROOT workspace's Home link
 * (#553) — `className` exists only so Home can push it right with `ml-auto`
 * (its row is a `justify-start` button, not a `justify-between` flex). The
 * "nothing at all when quiet" rule lives HERE, which is what keeps a zero-chat
 * root from rendering an empty wrapper or a `0` pill.
 */
function ProjectBadges({ badge, className = "" }: { badge?: ProjectBadge; className?: string }) {
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
