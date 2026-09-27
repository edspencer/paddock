import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { chatClient } from "../lib/ws";
import { useProjects } from "../lib/projects-context";
import type {
  Chat,
  ChatCompleteUsage,
  ChatUsage,
  Project,
} from "../lib/types";
import { ChatPane } from "../components/ChatPane";
import { rotateNewChatInstance } from "../lib/attachmentRefs";
import type { ShellOutletContext } from "../components/AppShell";
import { ChangesPane } from "../components/ChangesPane";
import { HistoryPane } from "../components/HistoryPane";
import { useProjectRuns } from "../lib/useProjectRuns";
import { FilesPane } from "../components/FilesPane";
import { SettingsPane } from "../components/SettingsPane";
import { TriggersPane } from "../components/TriggersPane";
import { usePaneWidth } from "../components/PaneResizer";
import { CHATLIST_PANE } from "../lib/paneWidth";
import { toSubPath, writeLastTab } from "../lib/lastTab";
import { readForkParent } from "../lib/forkLineage";
import { buildChatTree, flatForest, withAncestors } from "../lib/chatTree";
import { readCollapsedChats, writeCollapsedChats } from "../lib/collapsedChats";
import { useChatViewPrefs } from "./ProjectView/useChatViewPrefs";
import type { GitProjectStatus } from "../lib/types";
import {
  ROOT_KEY,
  decodeFilesSubpath,
  deriveView,
  gridUrl,
  parseMessageAnchor,
  viewBase,
} from "./ProjectView/urls";
import { ProjectTabs } from "./ProjectView/ProjectTabs";
import { ProjectHeader } from "./ProjectView/ProjectHeader";
import { useMediaQuery } from "../lib/useMediaQuery";
import { HomePane } from "./ProjectView/HomePane";
import { SessionSidebar } from "./ProjectView/SessionSidebar";
import { useUnreadChats } from "./ProjectView/useUnreadChats";
import { useAttentionChats } from "./ProjectView/useAttentionChats";
import { useChatAdoption } from "./ProjectView/useChatAdoption";
import { useChatActions } from "./ProjectView/useChatActions";
import { ChatDialogs } from "./ProjectView/ChatDialogs";
import { useForkActions } from "./ProjectView/useForkActions";
import { useWorkspaceNav } from "./ProjectView/useWorkspaceNav";

/**
 * The active view ("home" | "chat" | "files") and the selected chat/file are
 * derived from the URL via the route's params, NOT local state. This makes every
 * tab, chat, and file deep-linkable + restorable on reload, and keeps the tab
 * bar highlighting correct on a direct load. Routes that mount this component:
 *   /projects/:slug/home                -> Home tab (project overview)
 *   /projects/:slug/chat[/:sessionId]   -> Chat tab (optionally a saved chat)
 *   /projects/:slug/files[/:name]       -> Files tab / a specific file (or pin)
 *   /projects/:slug/changes[/:file]     -> Changes tab / a specific changed file
 *   /projects/:slug/settings            -> Settings tab (all per-project settings)
 *
 * With `root` (issue #516) the SAME component serves the ROOT workspace — the
 * instance's own directory, which always exists and contains every project.
 * Nothing about it is special-cased: its workspace key is the empty string and
 * it hits the same handlers, mounted at `/api/root` instead of
 * `/api/projects/:slug` (see `apiBase`). It differs only in its browser URLs,
 * which are flat and top-level (`/` is root Home — which also carries its
 * children — and `/chat[/:sessionId]` its chats), and that difference is carried
 * entirely by `base` (see `viewBase`).
 */
export function ProjectView({
  root = false,
  instanceEmpty = false,
  onInstanceRecheck,
}: {
  root?: boolean;
  /**
   * Is the whole INSTANCE empty (#865)? `null` = not known yet. Supplied by
   * `RootHome` for `/` alone and forwarded to Home, which is the only thing that
   * uses it. Not asked here, deliberately: `/chat` and `/projects/:slug` mount
   * this same component and would each pay for an answer they never read.
   */
  instanceEmpty?: boolean | null;
  /** Re-ask that question — adopting on Home is what changes the answer. */
  onInstanceRecheck?: () => void;
} = {}) {
  const params = useParams();
  const slug = root ? ROOT_KEY : (params.slug ?? "");
  // Every in-context URL hangs off this: "" at the root, `/projects/:slug`
  // otherwise. The ~20 navigation sites below are written against it, so both
  // contexts share one implementation (issue #516 Phase 3).
  const base = viewBase(slug);
  const location = useLocation();
  const navigate = useNavigate();
  // Opens the global project-nav drawer (#372). On mobile this view hosts the
  // hamburger inline in its own header, so the shell's brand row can be dropped.
  // Tolerates a missing context (rendered outside the shell, e.g. in tests) by
  // falling back to a no-op.
  const shell = useOutletContext<ShellOutletContext | null>();
  const openNav = shell?.openNav ?? (() => {});
  const { refresh: refreshProjects, upsert } = useProjects();

  // Which sub-route are we on? Derived purely from the URL (see `deriveView`).
  const view = deriveView(location.pathname, base);
  const routeSessionId = view === "chat" ? params.sessionId : undefined;
  // The Files tab nests: the directory or file being viewed is whatever follows
  // `<base>/files/` in the URL (issue #259). We read it straight from the
  // pathname (not a router param) and decode each segment, so real "/"
  // separators survive intact. "" = the project root's file list.
  const filesSubpath = view === "files" ? decodeFilesSubpath(location.pathname, base) : "";
  // The specific changed file deep-linked via /changes/:file (or undefined for
  // the Changes tab with no file selected — the pane defaults to the first one).
  const routeChangeFile =
    view === "changes" && params.file ? decodeURIComponent(params.file) : undefined;

  // Stable ChatPane mount key. The pane should reset when the user switches to a
  // DIFFERENT chat (new chat / a saved chat / after deleting the open one), but
  // NOT when a brand-new chat merely establishes its session id (which we mirror
  // into the URL via `replace` with state.established) — otherwise the live
  // transcript the user is watching would remount and flash. So we keep the same
  // key across the `null -> <newId>` establish transition.
  const paneKeyRef = useRef({ counter: 0, session: routeSessionId ?? null });
  if (paneKeyRef.current.session !== (routeSessionId ?? null)) {
    const established = (location.state as { established?: boolean } | null)?.established;
    if (!established) paneKeyRef.current.counter += 1;
    paneKeyRef.current.session = routeSessionId ?? null;
  }
  // Explicit "New Chat" reset. Route-driven remounting alone is not enough: while
  // a brand-new chat is streaming, its establish navigation (`/chat` -> `/chat/:id`
  // via replace) can still be in flight, so `routeSessionId` is momentarily null.
  // Clicking "New Chat" then navigates to `/chat` — no change to `routeSessionId`,
  // so the pane key wouldn't bump and the still-streaming pane would persist, and
  // the next message would be QUEUED into that live turn (fusing the two chats and
  // creating no second chat). Bumping this nonce on every explicit new-chat action
  // forces a genuinely fresh pane regardless of the establish race.
  const [newChatNonce, setNewChatNonce] = useState(0);
  const chatPaneKey = `${paneKeyRef.current.counter}:${newChatNonce}`;

  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  // Per-chat context-window usage for the sidebar rings (issue #77), keyed by
  // session id. Fetched separately from the chat list (issue #116) so the view
  // renders immediately — the per-session transcript parse this needs is what
  // made switching into a chat-heavy project slow. Kept in its own map (rather
  // than merged into `chats`) so it survives cheap chat-list refreshes that no
  // longer carry usage. A chat with no entry simply renders no ring yet.
  //
  // An entry is either the full disk-computed usage (`ChatUsage`, from
  // `/chats/usage`) OR the live per-turn frame (`ChatCompleteUsage`, seeded on
  // turn-complete — issue #164). The live shape lacks the cumulative
  // `totalTokens`/`costUsd`, which only degrades the cost tooltip until the next
  // `loadUsage()` fills them; the ring itself needs only context tokens/limit.
  const [usageBySession, setUsageBySession] = useState<
    Record<string, ChatUsage | ChatCompleteUsage>
  >({});
  // Live client-side filter for the chat list (issue #96). The whole list is
  // already in memory, so a case-insensitive substring match over name (and the
  // first-message preview, when present) needs no server round-trip. Derived
  // with useMemo so it only recomputes when the query or the list changes.
  const [chatSearch, setChatSearch] = useState("");
  // A brand-new chat that has started streaming but isn't in the server list
  // yet. Rendered as a real, persistent "pending" sidebar entry so the chat is
  // visibly created the moment it starts (issue #36); cleared once the real
  // entry appears in `chats`.
  const [pendingChat, setPendingChat] = useState<string | null>(null);
  // Sessions with a live turn right now (issue #53) — drives the per-chat
  // streaming dot in the sidebar, updated in real time from the shared socket's
  // chat:active broadcasts (works even for chats whose pane isn't mounted).
  const [runningSessions, setRunningSessions] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => chatClient.onActiveSessions(setRunningSessions), []);
  const [changelog, setChangelog] = useState("");
  // Raw OVERVIEW.md, rendered on Home beside the changelog (#599). Rides the
  // same workspace payload, so the two can never render a beat apart.
  const [overview, setOverview] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Git backing store: the project's working-tree status. null = not yet loaded
  // or not a git repo (`status.repo === false`) — either way the Changes tab is
  // hidden. The "Changes" tab is a real route (/changes[/:file]) like the other
  // three, so it's deep-linkable and survives a reload (issue #107).
  const [gitStatus, setGitStatus] = useState<GitProjectStatus | null>(null);
  // Run history (#268): fetched at the project level so the History tab can badge
  // the count of new unattended runs without the tab being open. The HistoryPane
  // shares this state and clears the badge (advances the watermark) on open.
  const runsState = useProjectRuns(slug);
  const newRunCount = runsState.newUnattended;
  // Mobile: the session list is an off-canvas drawer (static column on lg+).
  const [sessionsOpen, setSessionsOpen] = useState(false);

  // The chat awaiting a name in the promote-into-a-project dialog (issue #20).
  // Root-only — see SessionSidebar.setPromotingChat.
  const [promotingChat, setPromotingChat] = useState<Chat | null>(null);
  // Whether the collapsible "Archived" section is expanded (#95). Collapsed by
  // default; auto-expands (once per session) when the open chat is archived.
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Which parents have their children folded away in the chat tree, persisted
  // per-browser. Chats start EXPANDED: nesting re-orders and indents rows that
  // were already in the flat list, so collapsing by default would hide chats the
  // user can see today. Collapse is a tidy-up for a wide fan-out, not the default.
  const [collapsedChats, setCollapsedChats] = useState<ReadonlySet<string>>(() =>
    readCollapsedChats(slug),
  );
  const toggleChatCollapsed = useCallback(
    (sessionId: string) => {
      setCollapsedChats((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        writeCollapsedChats(slug, next);
        return next;
      });
    },
    [slug],
  );
  // How the chat list renders: nested vs flat, and whether it is filtered to the
  // chats running right now. Global browser prefs, not per-project — see
  // `lib/chatViewPrefs.ts`. Owned here because the forest builder below has to
  // know the mode; `SessionSidebar` gets the whole object as one prop.
  const viewPrefs = useChatViewPrefs();
  // Desktop-only draggable width for the chat-list pane (#374), persisted per-browser.
  const chatList = usePaneWidth(CHATLIST_PANE);
  // Tailwind's `lg` — where the tab strip moves up into the header row (#919).
  // Declared up here, not beside its use, because the loading/error early
  // returns below would otherwise make it a conditional hook.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const autoExpandedFor = useRef<string | null>(null);

  // The active chat session is the URL's sessionId (null = a fresh "new chat").
  const activeSession = routeSessionId ?? null;

  // Clear a chat's MANUAL unread override (#458) in local state when it's marked
  // seen. Stable (setChats identity is stable) so it doesn't churn markSeen and
  // re-fire the auto-mark-seen effect.
  const clearManualUnread = useCallback(
    (id: string) =>
      setChats((prev) =>
        prev.map((c) => (c.sessionId === id && c.unread ? { ...c, unread: false } : c)),
      ),
    [],
  );

  // Unread affordance (#160): owns liveUnread/seenVersion, folds server read-state
  // (#189), and derives the unread set + marks the focused chat seen. Takes the
  // WS-owned `runningSessions` (kept owned here so the fleet-wide set doesn't
  // fragment) to flag chats that finish a turn while unfocused. `onSeen` clears
  // the manual unread override (#458) whenever a chat is marked seen.
  /**
   * The reversible bulk form of {@link clearManualUnread} (#508). A subtree
   * "mark read" can fail, and when it does every optimistic change has to come
   * back — including this mirror. Returns the undo rather than letting the hook
   * guess: only this component knows which of those chats were actually flagged.
   */
  const clearManualUnreadMany = useCallback(
    (ids: string[]) => {
      const target = new Set(ids);
      const wasFlagged = chats
        .filter((c) => target.has(c.sessionId) && c.unread)
        .map((c) => c.sessionId);
      if (!wasFlagged.length) return () => {};
      setChats((prev) =>
        prev.map((c) => (target.has(c.sessionId) && c.unread ? { ...c, unread: false } : c)),
      );
      const restore = new Set(wasFlagged);
      return () =>
        setChats((prev) =>
          prev.map((c) => (restore.has(c.sessionId) ? { ...c, unread: true } : c)),
        );
    },
    [chats],
  );

  const { unread, markManySeen } = useUnreadChats({
    slug,
    chats,
    view,
    activeSession,
    runningSessions,
    onSeen: clearManualUnread,
    onManySeen: clearManualUnreadMany,
  });

  // Home's two feeds (#599), server-derived over this workspace's SUBTREE — so
  // the root's Home is fleet-wide and a project's is its own, with no branch
  // here. `runningSessions` is the staleness signal, not the data.
  const attention = useAttentionChats(slug, runningSessions);

  // The chats actually rendered in the sidebar, after applying the search
  // filter (issue #96). Empty query -> the full list unchanged.
  const visibleChats = useMemo(() => {
    // The running-only filter narrows the population BEFORE the search
    // runs, so the two compose: a query inside the filter searches the running
    // chats. The open chat is pinned in regardless — otherwise the chat you are
    // reading disappears from the sidebar the moment its turn finishes, which is
    // the same "don't yank the open chat out of the list" concern the #154
    // fallback row exists for.
    const base = viewPrefs.runningOnly
      ? chats.filter((c) => runningSessions.has(c.sessionId) || c.sessionId === activeSession)
      : chats;
    const q = chatSearch.trim().toLowerCase();
    if (!q) return base;
    const matches = base.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.preview?.toLowerCase().includes(q) ?? false),
    );
    // Keep matched chats' ancestors too, so a hit nested under a non-matching
    // parent still renders in place instead of being reparented to the root.
    // NOT while filtering to running chats: an ancestor is kept as scaffolding
    // for the nesting, and an idle parent dragged back in would defeat the very
    // filter the user just asked for (the view is flat, so there is no nesting
    // to scaffold anyway).
    return viewPrefs.runningOnly ? matches : withAncestors(chats, matches);
  }, [chats, chatSearch, viewPrefs.runningOnly, runningSessions, activeSession]);
  const searching = chatSearch.trim().length > 0;

  // Fetch the project's git status; clears it (hiding the Changes tab) when the
  // projects dir isn't a repo or the request fails. Safe to call freely.
  const refreshGit = useCallback(async () => {
    const next = await api.gitStatus(slug).catch(() => null);
    setGitStatus(next && next.repo ? next : null);
  }, [slug]);

  // Fetch the per-chat usage rings (issue #116) — a separate, non-blocking round
  // trip so the view never waits on the per-session transcript parse. Safe to
  // call freely; a failure just leaves the rings unfilled.
  const loadUsage = useCallback(async () => {
    const usage = await api.chatUsage(slug).catch(() => null);
    // MERGE (don't replace): a brand-new chat whose transcript usage line isn't
    // durably readable yet is omitted from this disk-derived map (the read
    // race). Merging preserves any live turn-complete seed (issue #164) so its
    // ring doesn't vanish when the same-instant disk re-read comes back empty;
    // the disk figures overwrite the seed for sessions it does have. It also
    // means the scoped fetches below compose: each one only ever ADDS rings.
    if (usage) setUsageBySession((prev) => ({ ...prev, ...usage }));
  }, [slug]);

  // The archived half of the rings (issue #537). `loadUsage` above asks for the
  // server's default `active` scope, because the Archived group is collapsed on
  // open and its rings are never rendered — yet computing them meant streaming
  // ~72% of the project's transcript bytes on every project open AND after every
  // completed turn, per open tab. So archived usage is fetched lazily, the first
  // time the group is actually expanded (see the effect below).
  const loadArchivedUsage = useCallback(async () => {
    const usage = await api.chatUsage(slug, "archived").catch(() => null);
    if (usage) setUsageBySession((prev) => ({ ...prev, ...usage }));
  }, [slug]);

  // Whether this project's archived rings have been asked for yet — so a turn
  // completing re-freshes them only for someone who has the group open, rather
  // than quietly reinstating the full-corpus scan for everyone.
  const archivedUsageWanted = useRef(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const detail = await api.getProjectDetail(slug);
      setProject(detail.project);
      setChats(detail.chats);
      setChangelog(detail.changelog);
      setOverview(detail.overview ?? "");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Failed to load project");
    }
    void refreshGit();
    // Rings fill in after the view has rendered (issue #116).
    void loadUsage();
  }, [slug, refreshGit, loadUsage]);

  useEffect(() => {
    setProject(null);
    setGitStatus(null);
    setUsageBySession({});
    archivedUsageWanted.current = false;
    void load();
  }, [slug, load]);

  // Lazy archived rings (issue #537). Keyed on the EXPANDED STATE rather than on
  // the click handler, because three different things open this group: the user
  // toggling it, archiving a chat (`archiveChat`), and deep-linking into an
  // archived chat (the auto-expand effect below). Watching the state covers all
  // of them by construction — hanging the fetch off the disclosure button would
  // leave the rings blank in exactly the cases where a user went looking for an
  // archived chat. `loadArchivedUsage` is slug-scoped, so switching projects with
  // the group left open refetches for the new project.
  useEffect(() => {
    if (!archivedOpen) return;
    archivedUsageWanted.current = true;
    void loadArchivedUsage();
  }, [archivedOpen, loadArchivedUsage]);

  // Sticky last tab: persist the current in-project sub-path for this project
  // whenever the URL (view / session / file) changes, so the bare
  // `/projects/:slug` redirect can restore exactly where the user left off.
  //
  // Deliberately NOT done at the root (issue #516): `/` always renders Home. A
  // sticky root tab would mean `/` — the instance's front door — sometimes lands
  // on Files, which is exactly the weirdness a redirect scheme invites. Sticky
  // tabs stay a project-only affordance.
  useEffect(() => {
    if (root) return;
    const sub =
      view === "home"
        ? toSubPath({ view: "home" })
        : view === "settings"
          ? toSubPath({ view: "settings" })
          : view === "history"
            ? toSubPath({ view: "history" })
            : view === "triggers"
              ? toSubPath({ view: "triggers" })
              : view === "chat"
              ? toSubPath({ view: "chat", sessionId: routeSessionId })
              : view === "changes"
                ? toSubPath({ view: "changes", file: routeChangeFile })
                : toSubPath({ view: "files", path: filesSubpath || undefined });
    writeLastTab(slug, sub);
  }, [root, slug, view, routeSessionId, filesSubpath, routeChangeFile]);

  // Refresh just the chat list (e.g. after a new session is established).
  const refreshChats = useCallback(async () => {
    const list = await api.listProjectChats(slug).catch(() => null);
    if (list) setChats(list);
  }, [slug]);

  // Native CLI chat adoption (#588, #660) — count, dialog, adopt/undo, toast.
  const adoption = useChatAdoption(slug, refreshChats);
  const { adoptableCount, adopting, setAdoptOpen } = adoption;

  // After a turn completes, re-fetch the project (pull model): a fresh sweep may
  // have written OVERVIEW.md / appended to CHANGELOG.
  //
  // It used to re-list the project's FILES here too, for Home's preview. #880
  // dropped that section, and the Files tab does its own listing — so the fetch
  // went with it rather than staying as a request nothing reads.
  const refreshAfterTurn = useCallback(async () => {
    const detail = await api.getProjectDetail(slug).catch(() => null);
    if (detail) {
      setProject(detail.project);
      setChats(detail.chats);
      setChangelog(detail.changelog);
      setOverview(detail.overview ?? "");
    }
    // A completed turn may have authored/changed files — refresh git status so
    // the Changes badge stays accurate without opening the panel.
    void refreshGit();
    // A completed turn changes the chat's context fill — refresh its ring (#116).
    void loadUsage();
    // …and the archived ones too, but only if they are on screen (#537).
    if (archivedUsageWanted.current) void loadArchivedUsage();
  }, [slug, refreshGit, loadUsage, loadArchivedUsage]);

  // Hydration applies the instance's transcript render cap (issue #914): the
  // limit is resolved first (memoised, so only the first chat of a page load
  // actually waits on it) and passed as a query param, so the messages above the
  // cap are never fetched, parsed or mounted. Switching away and back re-runs
  // this, which is what "evicts" a turn's live overflow — no client-side pruning.
  const loadHistory = useCallback(
    async (sessionId: string, limit?: number) => {
      // An explicit `limit` wins, INCLUDING 0 — that is the deep-link fallback
      // asking for the whole transcript, so `??` (not `||`) is load-bearing.
      const cap = limit ?? (await api.uiConfig()).transcriptRenderLimit;
      return api.projectChatMessages(slug, sessionId, cap);
    },
    [slug],
  );

  // Any tab/chat/file navigation closes the mobile session drawer.
  useEffect(() => {
    setSessionsOpen(false);
  }, [view, routeSessionId, filesSubpath, routeChangeFile]);

  // URL-driven navigation — every tab/chat/file click changes the route.
  const {
    goHome,
    goChat,
    goFiles,
    goChanges,
    goHistory,
    goSettings,
    goTriggers,
    openChangeFile,
    openChat,
    openChatIn,
    goToFilesPath,
  } = useWorkspaceNav(base, navigate, location.pathname);
  // Start a brand-new chat. Bump the pane nonce first so the ChatPane is force-
  // remounted into a clean, session-less composer even when the current pane is a
  // still-streaming new chat whose establish navigation hasn't landed yet (which
  // would otherwise leave `routeSessionId` null and make `goChat` a no-op).
  const newChat = useCallback(() => {
    setNewChatNonce((n) => n + 1);
    // This is a DIFFERENT chat, not a return to the one being composed, so the
    // abandoned one's staged attachments must not follow it (#728). Rotating the
    // new-chat instance id is the only place that distinction is made: navigating
    // away and back deliberately keeps the tray (#346).
    rotateNewChatInstance(slug);
    goChat();
  }, [goChat, slug]);
  // Fork (whole chat or from a message), revert, and message deep links.
  const {
    forkRequest,
    setForkRequest,
    commitFork,
    requestFork,
    requestForkFromMessage,
    revertToMessage,
    messageLink,
  } = useForkActions({ slug, base, activeSession, chats, navigate, refreshChats, setLoadErr });
  // The message named by the current fragment, if any. Read through `location` so
  // it tracks in-app navigation rather than freezing at whatever the page loaded with.
  const focusMessageUuid = parseMessageAnchor(location.hash);

  // The chat this one was forked from (for the composer back-link), from local
  // lineage recorded at fork time.
  const forkParent = readForkParent(routeSessionId);
  // True right after forking (router state), so the pane auto-focuses its
  // composer to continue the new fork.
  const justForked = (location.state as { justForked?: boolean } | null)?.justForked === true;

  // A brand-new chat has started streaming and just learned its session id
  // (mid-turn). Surface it as a real, persistent sidebar entry immediately and
  // reflect the id in the URL, so the user can see the chat exists and safely
  // navigate away without waiting for the turn to finish (issue #36).
  const onSessionStarted = useCallback(
    (sessionId: string) => {
      setPendingChat(sessionId);
      void refreshChats();
      void refreshProjects();
      if (!routeSessionId) {
        navigate(`${base}/chat/${encodeURIComponent(sessionId)}`, {
          replace: true,
          state: { established: true },
        });
      }
    },
    [refreshChats, refreshProjects, routeSessionId, navigate, base],
  );

  // When a brand-new chat first establishes its session id, reflect it in the
  // URL (replace) so a reload restores that chat and the sticky tab points at it.
  const onSessionEstablished = useCallback(
    (sessionId: string) => {
      void refreshChats();
      void refreshProjects();
      if (!routeSessionId) {
        navigate(`${base}/chat/${encodeURIComponent(sessionId)}`, {
          replace: true,
          state: { established: true },
        });
      }
    },
    [refreshChats, refreshProjects, routeSessionId, navigate, base],
  );

  // Drop the optimistic pending entry once the real chat lands in the list.
  useEffect(() => {
    if (pendingChat && chats.some((c) => c.sessionId === pendingChat)) {
      setPendingChat(null);
    }
  }, [chats, pendingChat]);

  // When a session starts running that isn't in our chat list yet — a chat
  // started from another client/tab, or one racing the initial refresh — pull
  // the chat list once so the in-flight chat surfaces in the sidebar without
  // waiting for its turn to finish (issue #100). The server attributes a new
  // chat the moment its id is known, so the refetch reliably includes it. A
  // seen-set keeps a running id (including ones from other projects, since the
  // set is fleet-wide) from triggering more than one refetch — no refetch loop.
  const reactedRunning = useRef<Set<string>>(new Set());
  useEffect(() => {
    let sawFresh = false;
    for (const id of runningSessions) {
      if (reactedRunning.current.has(id)) continue;
      reactedRunning.current.add(id);
      if (!chats.some((c) => c.sessionId === id)) sawFresh = true;
    }
    if (sawFresh) void refreshChats();
  }, [runningSessions, chats, refreshChats]);

  const onTurnComplete = useCallback(
    (live?: { sessionId: string; usage: ChatCompleteUsage }) => {
      // Seed the chat-list ring from the live per-turn usage the pane already
      // holds (issue #164). This makes a brand-new chat's ring appear the
      // instant its first turn ends, instead of waiting on the mtime-memoized
      // disk re-read in loadUsage() — which, for a session with no prior entry,
      // can race and leave the ring blank until a full page reload.
      if (live) {
        setUsageBySession((prev) => ({ ...prev, [live.sessionId]: live.usage }));
      }
      void refreshAfterTurn();
      void refreshProjects();
    },
    [refreshAfterTurn, refreshProjects],
  );

  const togglePin = useCallback(
    async (file: string) => {
      if (!project) return;
      const pinned = project.pinned.includes(file)
        ? await api.unpinFile(slug, file)
        : await api.pinFile(slug, file);
      setProject(pinned);
      upsert(pinned);
    },
    [project, slug, upsert],
  );

  const unpinTab = useCallback(
    async (file: string) => {
      const updated = await api.unpinFile(slug, file);
      setProject(updated);
      upsert(updated);
      // If the unpinned tab is the one being viewed, fall back to the Files list.
      if (filesSubpath === file) navigate(`${base}/files`, { replace: true });
    },
    [slug, base, upsert, filesSubpath, navigate],
  );

  // Per-chat row actions (delete / rename / archive / detach / star / unread).
  const chatActions = useChatActions({
    slug,
    base,
    activeSession,
    navigate,
    chats,
    setChats,
    setLoadErr,
    setArchivedOpen,
    unread,
    markManySeen,
  });
  const { requestDeleteChat, setRenamingChat, archiveChat, detachChat, starChat, toggleUnread } =
    chatActions;

  // Partition the (search-filtered) chat list into the current (top) and
  // archived (bottom) groups (#95), then nest each into a tree so a chat created
  // by another chat renders under it. Starring now floats within a sibling group
  // rather than globally (#373's rule would otherwise pull a starred child out
  // from under its parent) — see buildChatTree. Search (#96) still finds archived
  // chats, surfacing them in the Archived section. `activeTotal` is the unfiltered
  // non-archived count, for the "N/total" badge while searching.
  //
  // Two view prefs re-shape this. FLAT view swaps the tree builder for
  // `flatForest`. RUNNING-ONLY additionally collapses the partition: a running
  // chat that happens to be archived is still running, so it belongs in the one
  // flat list rather than folded away behind the Archived accordion — which then
  // hides itself, since it renders only when it has rows.
  const forest = useCallback(
    (population: Chat[]) =>
      viewPrefs.runningOnly || !viewPrefs.nested
        ? flatForest(population)
        : buildChatTree(population),
    [viewPrefs.runningOnly, viewPrefs.nested],
  );
  const activeChats = useMemo(
    () => forest(viewPrefs.runningOnly ? visibleChats : visibleChats.filter((c) => !c.archived)),
    [visibleChats, forest, viewPrefs.runningOnly],
  );
  const archivedChats = useMemo(
    () => (viewPrefs.runningOnly ? [] : forest(visibleChats.filter((c) => c.archived))),
    [visibleChats, forest, viewPrefs.runningOnly],
  );
  const activeTotal = chats.filter((c) => !c.archived).length;
  // The split badge's right-hand number: this project's chats with a live turn.
  // `runningSessions` is fleet-wide, so intersecting with `chats` (already
  // project-scoped) is what scopes it. Counted over ALL chats, archived
  // included, so the number always matches what the filter would show.
  const runningCount = useMemo(
    () => chats.filter((c) => runningSessions.has(c.sessionId)).length,
    [chats, runningSessions],
  );
  const activeIsArchived = chats.some((c) => c.archived && c.sessionId === activeSession);

  // Belt-and-suspenders for the open chat vanishing from the list (#154). The
  // post-turn sweep can transiently steal a live keeper chat's session id (its
  // job gets stamped `sweeper-<slug>`), so `getAgentSessions("keeper-<slug>")`
  // filters that chat out of `chats` until the next keeper turn re-attributes it
  // — the chat flickers out of the sidebar even though it's open and intact
  // (root cause + proper fix: herdctl#357). Remember the open chat's last-seen
  // DTO so, if it drops out of `chats` while still open, we can keep rendering
  // its row instead of leaving the open chat rowless.
  const lastActiveChatRef = useRef<Chat | null>(null);
  useEffect(() => {
    const found = chats.find((c) => c.sessionId === activeSession);
    if (found) lastActiveChatRef.current = found;
    // Drop a stale cache once we navigate to a different chat (or to a new one).
    else if (lastActiveChatRef.current?.sessionId !== activeSession)
      lastActiveChatRef.current = null;
  }, [chats, activeSession]);

  // The open chat is missing from the list (and isn't the fresh-new or pending
  // placeholder): synthesize a row for it so it always has a sidebar entry.
  // Prefer its last-seen DTO (full name/ring/actions); fall back to a minimal
  // row keyed by session id on a cold load where it was never in the list.
  const openChatMissing =
    !!activeSession &&
    view === "chat" &&
    pendingChat !== activeSession &&
    !chats.some((c) => c.sessionId === activeSession);
  const fallbackChat: Chat | null = openChatMissing
    ? lastActiveChatRef.current?.sessionId === activeSession
      ? lastActiveChatRef.current
      : {
          sessionId: activeSession,
          workingDirectory: "",
          name: "Current chat",
          updatedAt: "",
          resumable: true,
        }
    : null;

  // Deep-link behavior: when the open chat is archived, expand the Archived
  // section so the user can see where they are — once per session, so a manual
  // collapse afterwards sticks (and a list refresh doesn't force it back open).
  useEffect(() => {
    if (activeIsArchived && autoExpandedFor.current !== activeSession) {
      autoExpandedFor.current = activeSession;
      setArchivedOpen(true);
    }
  }, [activeIsArchived, activeSession]);

  if (loadErr) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-danger-edge bg-danger-soft px-4 py-3 text-sm text-danger">
          {loadErr}
        </div>
      </div>
    );
  }
  if (!project) {
    return <div className="p-8 text-sm text-fg-muted">Loading project…</div>;
  }

  const pinned = project.pinned;
  // The single canonical URL for viewing a file is /files/:name — used both by
  // the Files-list "open" action and by pinned sibling tabs. Tab highlighting is
  // derived purely from the URL:
  //  - Chat tab active on /chat[...].
  //  - A pinned-file tab active on /files/<name> when <name> is pinned.
  //  - The Files tab active otherwise (the files list, or an unpinned file open
  //    in the reader). Pinning a file you're viewing therefore just shifts the
  //    highlight to its new sibling tab — the SAME reader keeps rendering it (no
  //    component swap), so the view doesn't jump.
  // A pinned sibling tab is highlighted when the current files subpath is exactly
  // that pinned file (at any depth); otherwise the Files tab itself is active —
  // for the root list, a subdirectory, or an unpinned file open in the reader.
  const activePinnedFile =
    view === "files" && filesSubpath && pinned.includes(filesSubpath) ? filesSubpath : null;
  const filesTabActive = view === "files" && !activePinnedFile;

  // The tab strip renders ONCE (#919): in the header row on desktop, atop the
  // main column on mobile. One copy, not a CSS-hidden twin, so there is only
  // ever one Home tab in the accessibility tree.
  const tabProps = {
    view,
    filesTabActive,
    gitStatus,
    newRunCount,
    pinned,
    activePinnedFile,
    goHome,
    goChat,
    goFiles,
    goChanges,
    goHistory,
    goSettings,
    goTriggers,
    goToFilesPath,
    unpinTab,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader
        name={project.name}
        onHome={goHome}
        openNav={openNav}
        onShowChats={() => setSessionsOpen(true)}
        chatCount={chats.length}
        onNewChat={newChat}
        tabs={isDesktop ? <ProjectTabs placement="header" {...tabProps} /> : undefined}
      />

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          chatList={chatList}
          sessionsOpen={sessionsOpen}
          setSessionsOpen={setSessionsOpen}
          chatSearch={chatSearch}
          setChatSearch={setChatSearch}
          searching={searching}
          newChat={newChat}
          view={view}
          activeSession={activeSession}
          pendingChat={pendingChat}
          chats={chats}
          fallbackChat={fallbackChat}
          visibleChats={visibleChats}
          activeChats={activeChats}
          archivedChats={archivedChats}
          activeTotal={activeTotal}
          runningCount={runningCount}
          viewPrefs={viewPrefs}
          archivedOpen={archivedOpen}
          setArchivedOpen={setArchivedOpen}
          collapsedChats={collapsedChats}
          toggleChatCollapsed={toggleChatCollapsed}
          openChat={openChat}
          unread={unread}
          usageBySession={usageBySession}
          runningSessions={runningSessions}
          onForkChat={requestFork}
          setPromotingChat={root ? setPromotingChat : undefined}
          renameChat={setRenamingChat}
          archiveChat={archiveChat}
          requestDeleteChat={requestDeleteChat}
          starChat={starChat}
          toggleUnread={toggleUnread}
          detachChat={detachChat}
          adoptableCount={adoptableCount}
          adopting={adopting}
          adoptChats={() => setAdoptOpen(true)}
        />

        {/* Main: tabs + content. The active tab is derived from the URL. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!isDesktop && <ProjectTabs placement="column" {...tabProps} />}

          {/* The Changes tab (its own /changes[/:file] route). It owns
              refetching status post-commit and propagates it up so the tab badge
              stays in sync; the selected file is URL-driven so a specific diff is
              deep-linkable (issue #107). */}
          {view === "changes" && gitStatus && (
            <ChangesPane
              slug={project.slug}
              status={gitStatus}
              onStatusChange={(s) => setGitStatus(s.repo ? s : null)}
              selectedFile={routeChangeFile ?? null}
              onSelectFile={openChangeFile}
            />
          )}
          {/* The History tab (#268): a project-level run-history view. Fetch is
              owned above (runsState) so the tab badge works without opening it;
              the pane clears the since-last-visit watermark on mount. */}
          {view === "history" && (
            <HistoryPane
              slug={project.slug}
              state={runsState}
              chats={chats}
              onOpenChat={openChat}
            />
          )}
          {/* Settings: this workspace's own `project.yaml`, and nothing else.
              ONE pane, at the root exactly as in a project — which is what makes
              this tab scroll at all. It used to render the instance-wide
              `paddock.config.yaml` form as a second root-only section (#516
              Phase 5), and two panes in one tab is what broke it: that form is a
              fragment whose `min-h-0 flex-1 overflow-y-auto` body only works as a
              flex-column child, so wrapped in a plain <div> it grew to its full
              content height, refused to shrink, squashed this pane's
              `flex: 1 1 0` to ZERO height and left nothing able to scroll. The
              instance config is its own screen at `/config` now, so the root's
              Settings is an ordinary workspace tab again. */}
          {view === "settings" && (
            <SettingsPane
              project={project}
              onSaved={(p) => {
                setProject(p);
                upsert(p);
              }}
              // The danger zone deletes the project you are standing in, so the
              // page under you stops existing (#923). It is the only delete
              // inside a project since the header's `⋯` menu went (#919).
              onDeleted={() => navigate(gridUrl())}
            />
          )}
          {/* The Triggers tab (Epic T / T4): a self-contained CRUD surface for this
              project's unified triggers (schedules + events + reserved webhooks). Its
              create/edit/delete/enable run through the unified /triggers endpoints, so
              it manages its own state. */}
          {view === "triggers" && <TriggersPane project={project} />}
          {view === "home" && (
            <HomePane
              project={project}
              // `root` IS a gate now (#865). Both feeds are still subtree-scoped
              // server-side — the ROOT's Home lists every project's live/unread
              // work and a project's lists only its own, with no flag needed for
              // that. What needs the flag is the instance-level ONBOARDING the
              // root's Home carries and a project's must not: there is one
              // instance and one root, so "which am I" became a real question.
              // Passed explicitly rather than derived from `project.slug === ""`,
              // which is the root's slug and is falsy.
              root={root}
              // Empty = no projects and no root chats. `null` until known.
              instanceEmpty={root ? instanceEmpty : false}
              onInstanceRecheck={onInstanceRecheck}
              // The projects GRID that used to sit here is gone (#599): the
              // sidebar owns navigating to a project, and its Projects header
              // now carries the New Project button the grid used to host.
              running={attention.running}
              unread={attention.unread}
              attentionLoading={attention.loading}
              attentionError={attention.error}
              changelog={changelog}
              overview={overview}
              onOpenChat={openChatIn}
              onNewChat={newChat}
            />
          )}
          {view === "chat" && (
            <ChatPane
              // Stable across the new->established transition; bumps only on a
              // real chat switch (see paneKeyRef above) so the live transcript
              // doesn't flash when a new chat saves its session id.
              key={chatPaneKey}
              projectSlug={project.slug}
              initialSessionId={activeSession ?? undefined}
              loadHistory={loadHistory}
              onSessionEstablished={onSessionEstablished}
              onSessionStarted={onSessionStarted}
              onTurnComplete={onTurnComplete}
              preloadAvailable={project.hasOverview}
              projectModel={project.model}
              // Per-project offered-models allow-list (issue #457 Step 2); narrows
              // this chat's model picker to the subset when the project sets one.
              projectModels={project.models}
              // Per-project keeper-chat recovery override (issue #301); combined
              // with the instance default to gate the killed-task Continue button.
              projectRecovery={project.recovery}
              // Per-project inbound-attachment override (issue #328); combined
              // with the instance default to resolve the composer's picker + caps.
              projectAttachments={project.attachments}
              forkParent={forkParent ?? undefined}
              onOpenForkParent={openChat}
              onForkFromMessage={requestForkFromMessage}
              onRevertToMessage={revertToMessage}
              onMessageLink={messageLink}
              focusMessageUuid={focusMessageUuid}
              autoFocus={justForked}
              // For a trigger chat (Epic T / T4): the owning trigger's truthful-from-
              // config capability descriptor, drives the read-only capability banner.
              // Prefers the live list DTO, falling back to the last-seen DTO so the
              // banner survives a transient list drop.
              trigger={
                (chats.find((c) => c.sessionId === activeSession) ??
                  (lastActiveChatRef.current?.sessionId === activeSession
                    ? lastActiveChatRef.current
                    : null))?.trigger
              }
            />
          )}
          {/* Files tab (issue #259): one browser that lists the current directory
              (root or a subdirectory) OR renders a file — the same nested
              `/files/<path>` URL addresses both, so folders and files are
              deep-linkable. Navigating (into a folder, up via `..`, a breadcrumb,
              or opening a file) just changes the URL via goToFilesPath. */}
          {view === "files" && (
            <FilesPane
              key={filesSubpath}
              project={project}
              path={filesSubpath}
              onNavigate={goToFilesPath}
              onTogglePin={togglePin}
            />
          )}
        </div>
      </div>

      <ChatDialogs
        actions={chatActions}
        adoption={adoption}
        slug={slug}
        upsert={upsert}
        navigate={navigate}
        promotingChat={promotingChat}
        setPromotingChat={setPromotingChat}
        forkRequest={forkRequest}
        setForkRequest={setForkRequest}
        commitFork={commitFork}
      />
    </div>
  );
}
