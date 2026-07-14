import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useProjects } from "../lib/projects-context";
import { useTheme } from "../lib/theme";
import type { Project } from "../lib/types";
import { getBrand, logoIsImage } from "../lib/brand";
import { areaLabel, orderAreaSlugs } from "../lib/areas";
import { chatClient } from "../lib/ws";
import { LAST_SEEN_EVENT, readLastSeen, setServerLastSeen } from "../lib/lastSeen";
import { TagPill } from "./TagPill";
import { NewProjectModal } from "./NewProjectModal";
import { ChatIcon, FolderIcon, MenuIcon, MoonIcon, PlusIcon, SunIcon, XIcon } from "./icons";

/** Per-project sidebar counts (#161): unread replies + in-flight turns. */
interface ProjectBadge {
  unread: number;
  inflight: number;
}

/**
 * Compute per-project unread + in-flight counts for the sidebar (#161), with no
 * new fetch or polling:
 *  - UNREAD rides the projects payload's `chatTurns` (`{ sessionId,
 *    lastTurnCompletedAt, lastSeen }`, folded in server-side) compared against
 *    the server-backed `lastSeen` read-state (#160/#189), mirrored locally for
 *    optimistic same-tab clears. Live turn-completions seen over the WS bump it
 *    too, so a reply landing counts without a reload.
 *  - IN-FLIGHT rides the existing WS `chat:active` set (now carrying
 *    `projectSlug`), grouped by project — near-real-time, zero polling.
 * Recomputes on projects refresh, WS active changes, and `lastSeen` writes.
 */
function useProjectBadges(projects: Project[]): Map<string, ProjectBadge> {
  // sessionId -> projectSlug for every currently-running turn (from the WS set).
  const [active, setActive] = useState<ReadonlyMap<string, string>>(new Map());
  // sessionId -> { slug, at(ms) } completion signals: seeded from the server
  // payload and augmented live when a turn stops. Kept in a ref (not state) so
  // it accumulates across refetches; `version` forces the memo to recompute.
  const completionsRef = useRef(new Map<string, { slug: string; at: number }>());
  const [version, setVersion] = useState(0);

  // Fold the server's per-chat completed-turn timestamps in whenever the list
  // changes (keeping the newest per session).
  useEffect(() => {
    const m = completionsRef.current;
    for (const p of projects) {
      for (const t of p.chatTurns ?? []) {
        // Fold the server-backed read-state (#189) into the shared cache so the
        // unread count reads from the cross-device source of truth.
        setServerLastSeen(t.sessionId, t.lastSeen);
        const at = Date.parse(t.lastTurnCompletedAt);
        if (!Number.isFinite(at)) continue;
        const prev = m.get(t.sessionId);
        if (!prev || at > prev.at) m.set(t.sessionId, { slug: p.slug, at });
      }
    }
    setVersion((v) => v + 1);
  }, [projects]);

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
  // unread) — same-tab custom event + cross-tab `storage`.
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(LAST_SEEN_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(LAST_SEEN_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
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
    for (const [sid, { slug, at }] of completionsRef.current) {
      // A currently-running turn hasn't "landed" a reply yet — count it only as
      // in-flight below, never as unread.
      if (!active.has(sid) && at > readLastSeen(sid)) ensure(slug).unread += 1;
    }
    for (const slug of active.values()) ensure(slug).inflight += 1;
    return badges;
    // `version` is the recompute trigger (completionsRef mutates in place).
  }, [active, version]);
}

export function AppShell() {
  const { projects, loading, upsert } = useProjects();
  const { dark, toggle: toggleTheme } = useTheme();
  const [modalOpen, setModalOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const brand = getBrand();

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

  const badges = useProjectBadges(projects);

  const onCreated = (p: Project) => {
    upsert(p);
    setModalOpen(false);
    // A brand-new project has an empty Home (no chats/files/changelog yet), so
    // drop the user straight into a new chat to start working. (Re-opening an
    // existing project via the sidebar/grid lands on Home — see ProjectRedirect.)
    navigate(`/projects/${p.slug}/chat`);
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas dark:bg-canvas-dark lg:flex-row">
      {/* Mobile top bar — hidden on lg+, where the sidebar is always present. */}
      <header className="pt-safe flex items-center gap-2 border-b border-paddock-200 px-3 pb-2 dark:border-paddock-800 lg:hidden">
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
          <span className="text-[15px] font-semibold tracking-tight">{brand.name}</span>
        </NavLink>
      </header>

      {/* Drawer backdrop (mobile only, when open). */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* Sidebar — a static column on lg+, an off-canvas drawer on mobile. */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 flex-col border-r border-paddock-200 bg-canvas shadow-2xl transition-transform duration-200 ease-out dark:border-paddock-800 dark:bg-paddock-900 lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-white/50 lg:shadow-none dark:lg:bg-paddock-900/30 ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 px-5 py-4">
          <NavLink to="/" className="group flex items-center gap-2">
            <BrandLogo brand={brand} className="h-8 w-8 text-base" />
            <span className="text-[17px] font-semibold tracking-tight">{brand.name}</span>
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

        <div className="space-y-1.5 px-3 pb-1">
          <button
            className="btn-primary w-full"
            onClick={() => {
              setNavOpen(false);
              setModalOpen(true);
            }}
          >
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
          {!loading &&
            projects.length > 0 &&
            sections.map(([slug, ps]) => (
              <div key={slug || "unsorted"} className="mb-2">
                {sections.length > 1 && (
                  <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-paddock-400">
                    {areaLabel(slug)}
                  </div>
                )}
                {ps.map((p) => (
                  <ProjectNavLink key={p.slug} project={p} badge={badges.get(p.slug)} />
                ))}
              </div>
            ))}
        </nav>

        <div className="border-t border-paddock-200 px-3 py-3 dark:border-paddock-800">
          <button
            type="button"
            onClick={toggleTheme}
            className="btn-subtle w-full justify-start"
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            title="Toggle light / dark theme"
          >
            {dark ? <SunIcon width={15} height={15} /> : <MoonIcon width={15} height={15} />}
            {dark ? "Light mode" : "Dark mode"}
          </button>
          <p className="mt-2 px-2 text-[11px] text-paddock-400">v{__APP_VERSION__}</p>
        </div>
      </aside>

      {/* Main pane. The Suspense boundary covers the lazily-loaded route chunks
          (issue #11) — a brief, unobtrusive fallback while a route's JS loads. */}
      <main className="min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </main>

      <NewProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={onCreated}
      />
    </div>
  );
}

/**
 * The instance logo chip (issue #34). Renders the configured logo as an <img>
 * when it's a URL/path, otherwise as an inline glyph/emoji. The accent-colored
 * chip background comes from the runtime `--accent` CSS variable via `bg-accent`.
 */
function BrandLogo({ brand, className = "" }: { brand: ReturnType<typeof getBrand>; className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent text-white shadow-sm ${className}`}
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
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-paddock-300 border-t-accent dark:border-paddock-700 dark:border-t-accent" />
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
        <ProjectBadges badge={badge} />
      </span>
      {p.domain.length > 0 && (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden pl-[18px]">
          {p.domain.slice(0, 2).map((d) => (
            <TagPill key={d} tag={d} className="max-w-[7rem] truncate" />
          ))}
          {p.domain.length > 2 && (
            <span className="shrink-0 text-[11px] text-paddock-400">+{p.domain.length - 2}</span>
          )}
        </span>
      )}
    </NavLink>
  );
}

/**
 * The two subtle per-project counts shown where the StatusPill used to live
 * (#161): a filled accent pill for UNREAD replies (primary) and a hollow
 * spinner + count for IN-FLIGHT turns (secondary). Each renders only when > 0;
 * nothing renders when the project is quiet, keeping the row calm.
 */
function ProjectBadges({ badge }: { badge?: ProjectBadge }) {
  const unread = badge?.unread ?? 0;
  const inflight = badge?.inflight ?? 0;
  if (unread === 0 && inflight === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {inflight > 0 && (
        <span
          className="flex items-center gap-1 text-[11px] tabular-nums text-paddock-500 dark:text-paddock-400"
          title={`${inflight} chat${inflight === 1 ? "" : "s"} in flight`}
          aria-label={`${inflight} chat${inflight === 1 ? "" : "s"} in flight`}
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-paddock-400 border-t-transparent dark:border-paddock-500 dark:border-t-transparent"
          />
          {inflight}
        </span>
      )}
      {unread > 0 && (
        <span
          className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums text-white"
          title={`${unread} unread ${unread === 1 ? "reply" : "replies"}`}
          aria-label={`${unread} unread ${unread === 1 ? "reply" : "replies"}`}
        >
          {unread}
        </span>
      )}
    </span>
  );
}
