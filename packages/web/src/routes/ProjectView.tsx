import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { chatClient } from "../lib/ws";
import { useProjects } from "../lib/projects-context";
import type { Chat, ChatCompleteUsage, ChatUsage, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { TagPill } from "../components/TagPill";
import { ChatPane } from "../components/ChatPane";
import { ContextRing } from "../components/ContextRing";
import { ProvenanceBadge } from "../components/ProvenanceBadge";
import { ChangesPane } from "../components/ChangesPane";
import { HistoryPane } from "../components/HistoryPane";
import { useProjectRuns } from "../lib/useProjectRuns";
import { Markdown } from "../components/Markdown";
import { FilesPane } from "../components/FilesPane";
import { ProjectMenu } from "../components/ProjectMenu";
import { SettingsPane } from "../components/SettingsPane";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ForkChatModal } from "../components/ForkChatModal";
import {
  ArchiveIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  LinkIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
} from "../components/icons";
import { relativeTime, sessionUsageOf } from "../lib/format";
import { areaLabel } from "../lib/areas";
import { clearLastTab, toSubPath, writeLastTab } from "../lib/lastTab";
import { readForkParent, writeForkParent } from "../lib/forkLineage";
import { readLastSeen, writeLastSeen, setServerLastSeen } from "../lib/lastSeen";
import type { GitProjectStatus } from "../lib/types";

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
 */
export function ProjectView() {
  const params = useParams();
  const slug = params.slug ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh: refreshProjects, upsert, remove } = useProjects();

  // Which sub-route are we on? Derived from the URL pathname so it updates on
  // client-side navigation (the `/home`, `/files`, and `/changes` segments
  // distinguish those tabs; anything else is the chat tab).
  const view: "home" | "chat" | "files" | "changes" | "settings" | "history" =
    location.pathname.startsWith(`/projects/${slug}/files`)
      ? "files"
      : location.pathname.startsWith(`/projects/${slug}/changes`)
        ? "changes"
        : location.pathname.startsWith(`/projects/${slug}/history`)
          ? "history"
          : location.pathname.startsWith(`/projects/${slug}/settings`)
            ? "settings"
            : location.pathname.startsWith(`/projects/${slug}/home`)
              ? "home"
              : "chat";
  const routeSessionId = view === "chat" ? params.sessionId : undefined;
  // The Files tab nests: the directory or file being viewed is whatever follows
  // `/projects/:slug/files/` in the URL (issue #259). We read it straight from
  // the pathname (not a router param) and decode each segment, so real "/"
  // separators survive intact. "" = the project root's file list.
  const filesSubpath = view === "files" ? decodeFilesSubpath(location.pathname, slug) : "";
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
  // Unread affordance (#160): a chat is unread when the agent finished a turn
  // while the user wasn't viewing it. Two signals combine:
  //  - `liveUnread`: chats flagged the instant a turn completed for a NON-focused
  //    chat this session (from the shared socket's running-set transitions below);
  //  - server `lastTurnCompletedAt` newer than the locally stored last-seen time
  //    (`lib/lastSeen.ts`), which covers reload + turns that finished while away.
  // Marking a chat seen (open/focus, or its turn completing while focused) writes
  // lastSeen=now and clears its live flag. `seenVersion` bumps on every mark so
  // the (localStorage-backed) derivation below recomputes.
  const [liveUnread, setLiveUnread] = useState<ReadonlySet<string>>(new Set());
  const [seenVersion, setSeenVersion] = useState(0);
  const markSeen = useCallback(
    (sessionId: string) => {
      const when = Date.now();
      // Optimistic same-tab clear (localStorage mirror + event), then persist to
      // the server (#189) so read-state follows the user across devices. The POST
      // is fire-and-forget — the mirror already cleared the cue; a failure just
      // means the next refetch re-derives from whatever the server has.
      writeLastSeen(sessionId, when);
      void api.markChatSeen(slug, sessionId, when).catch(() => undefined);
      setLiveUnread((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setSeenVersion((v) => v + 1);
    },
    [slug],
  );
  const [changelog, setChangelog] = useState("");
  const [files, setFiles] = useState<string[]>([]);
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

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingChat, setDeletingChat] = useState<Chat | null>(null);
  // The chat awaiting a fork-name in the naming dialog (issue #279); null when
  // the dialog is closed.
  const [forkingChat, setForkingChat] = useState<Chat | null>(null);
  // Whether the collapsible "Archived" section is expanded (#95). Collapsed by
  // default; auto-expands (once per session) when the open chat is archived.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const autoExpandedFor = useRef<string | null>(null);

  // The active chat session is the URL's sessionId (null = a fresh "new chat").
  const activeSession = routeSessionId ?? null;

  // The chats actually rendered in the sidebar, after applying the search
  // filter (issue #96). Empty query -> the full list unchanged.
  const visibleChats = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.preview?.toLowerCase().includes(q) ?? false),
    );
  }, [chats, chatSearch]);
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
    // the disk figures overwrite the seed for sessions it does have.
    if (usage) setUsageBySession((prev) => ({ ...prev, ...usage }));
  }, [slug]);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const detail = await api.getProjectDetail(slug);
      setProject(detail.project);
      setChats(detail.chats);
      setChangelog(detail.changelog);
      const fileList = await api.listProjectFiles(slug).catch(() => []);
      setFiles(fileList);
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
    void load();
  }, [slug, load]);

  // Sticky last tab: persist the current in-project sub-path for this project
  // whenever the URL (view / session / file) changes, so the bare
  // `/projects/:slug` redirect can restore exactly where the user left off.
  useEffect(() => {
    const sub =
      view === "home"
        ? toSubPath({ view: "home" })
        : view === "settings"
          ? toSubPath({ view: "settings" })
          : view === "history"
            ? toSubPath({ view: "history" })
            : view === "chat"
              ? toSubPath({ view: "chat", sessionId: routeSessionId })
              : view === "changes"
                ? toSubPath({ view: "changes", file: routeChangeFile })
                : toSubPath({ view: "files", path: filesSubpath || undefined });
    writeLastTab(slug, sub);
  }, [slug, view, routeSessionId, filesSubpath, routeChangeFile]);

  // Refresh just the chat list (e.g. after a new session is established).
  const refreshChats = useCallback(async () => {
    const list = await api.listProjectChats(slug).catch(() => null);
    if (list) setChats(list);
  }, [slug]);

  // After a turn completes, re-fetch the project + files (pull model): a fresh
  // sweep may have written OVERVIEW.md / appended to CHANGELOG / added files.
  const refreshAfterTurn = useCallback(async () => {
    const detail = await api.getProjectDetail(slug).catch(() => null);
    if (detail) {
      setProject(detail.project);
      setChats(detail.chats);
      setChangelog(detail.changelog);
    }
    const fileList = await api.listProjectFiles(slug).catch(() => null);
    if (fileList) setFiles(fileList);
    // A completed turn may have authored/changed files — refresh git status so
    // the Changes badge stays accurate without opening the panel.
    void refreshGit();
    // A completed turn changes the chat's context fill — refresh its ring (#116).
    void loadUsage();
  }, [slug, refreshGit, loadUsage]);

  const loadHistory = useCallback(
    (sessionId: string) => api.projectChatMessages(slug, sessionId),
    [slug],
  );

  // Any tab/chat/file navigation closes the mobile session drawer.
  useEffect(() => {
    setSessionsOpen(false);
  }, [view, routeSessionId, filesSubpath, routeChangeFile]);

  // --- URL-driven navigation (all tab/chat/file clicks change the route) -----
  const goHome = useCallback(() => navigate(`/projects/${slug}/home`), [navigate, slug]);
  const goChat = useCallback(() => navigate(`/projects/${slug}/chat`), [navigate, slug]);
  const goFiles = useCallback(() => navigate(`/projects/${slug}/files`), [navigate, slug]);
  const goChanges = useCallback(() => navigate(`/projects/${slug}/changes`), [navigate, slug]);
  const goHistory = useCallback(() => navigate(`/projects/${slug}/history`), [navigate, slug]);
  const goSettings = useCallback(() => navigate(`/projects/${slug}/settings`), [navigate, slug]);
  // Select a specific changed file in the Changes tab, reflecting it in the URL
  // so a specific diff/file is deep-linkable (issue #107). null clears to the
  // bare /changes route.
  const openChangeFile = useCallback(
    (file: string | null) =>
      navigate(
        file
          ? `/projects/${slug}/changes/${encodeURIComponent(file)}`
          : `/projects/${slug}/changes`,
      ),
    [navigate, slug],
  );
  // Start a brand-new chat. Bump the pane nonce first so the ChatPane is force-
  // remounted into a clean, session-less composer even when the current pane is a
  // still-streaming new chat whose establish navigation hasn't landed yet (which
  // would otherwise leave `routeSessionId` null and make `goChat` a no-op).
  const newChat = useCallback(() => {
    setNewChatNonce((n) => n + 1);
    goChat();
  }, [goChat]);
  const openChat = useCallback(
    (sessionId: string) =>
      navigate(`/projects/${slug}/chat/${encodeURIComponent(sessionId)}`),
    [navigate, slug],
  );
  // Fork a chat with a chosen name: duplicate it server-side into a NEW session
  // in the same project, then jump straight to it. The fork exists immediately —
  // a real, resumable chat with the parent's full history visible. The name is
  // collected up front by the ForkChatModal (issue #279); we record the lineage
  // locally for the composer back-link and pass `justForked` so the pane focuses
  // the composer to continue.
  const forkChat = useCallback(
    async (chat: Chat, name: string) => {
      let newId: string;
      try {
        newId = await api.forkChat(slug, chat.sessionId, name);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : "Failed to fork chat");
        return;
      }
      writeForkParent(newId, { sessionId: chat.sessionId, name: chat.name });
      await refreshChats();
      navigate(`/projects/${slug}/chat/${encodeURIComponent(newId)}`, {
        state: { justForked: true },
      });
    },
    [navigate, slug, refreshChats],
  );
  // The chat this one was forked from (for the composer back-link), from local
  // lineage recorded at fork time.
  const forkParent = readForkParent(routeSessionId);
  // True right after forking (router state), so the pane auto-focuses its
  // composer to continue the new fork.
  const justForked = (location.state as { justForked?: boolean } | null)?.justForked === true;
  // Navigate the Files tab to a subpath — a folder, a file, or "" for the root
  // (issue #259). Each segment is encoded individually so the real "/" separators
  // stay in the URL (deep-linkable nested path) while odd filename characters are
  // still escaped.
  const goToFilesPath = useCallback(
    (subpath: string) =>
      navigate(
        subpath
          ? `/projects/${slug}/files/${subpath.split("/").map(encodeURIComponent).join("/")}`
          : `/projects/${slug}/files`,
      ),
    [navigate, slug],
  );

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
        navigate(`/projects/${slug}/chat/${encodeURIComponent(sessionId)}`, {
          replace: true,
          state: { established: true },
        });
      }
    },
    [refreshChats, refreshProjects, routeSessionId, navigate, slug],
  );

  // When a brand-new chat first establishes its session id, reflect it in the
  // URL (replace) so a reload restores that chat and the sticky tab points at it.
  const onSessionEstablished = useCallback(
    (sessionId: string) => {
      void refreshChats();
      void refreshProjects();
      if (!routeSessionId) {
        navigate(`/projects/${slug}/chat/${encodeURIComponent(sessionId)}`, {
          replace: true,
          state: { established: true },
        });
      }
    },
    [refreshChats, refreshProjects, routeSessionId, navigate, slug],
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
      if (filesSubpath === file) navigate(`/projects/${slug}/files`, { replace: true });
    },
    [slug, upsert, filesSubpath, navigate],
  );

  const confirmDeleteChat = useCallback(async () => {
    if (!deletingChat) return;
    const id = deletingChat.sessionId;
    await api.deleteProjectChat(slug, id);
    setChats((prev) => prev.filter((c) => c.sessionId !== id));
    // If the deleted chat is the one open, drop back to a fresh "new chat".
    if (activeSession === id) navigate(`/projects/${slug}/chat`, { replace: true });
    setDeletingChat(null);
  }, [deletingChat, slug, activeSession, navigate]);

  const renameChat = useCallback(
    async (chat: Chat) => {
      const next = window.prompt("Rename chat", chat.name);
      if (next === null) return; // cancelled
      const name = next.trim();
      await api.renameProjectChat(slug, chat.sessionId, name || null);
      setChats((prev) =>
        prev.map((c) =>
          c.sessionId === chat.sessionId
            ? { ...c, name: name || c.preview || c.sessionId.slice(0, 8) }
            : c,
        ),
      );
    },
    [slug],
  );

  // Archive or unarchive a chat (#95): toggle the persisted flag and optimistically
  // move it between the current list and the Archived section. Non-destructive —
  // the transcript is untouched and the chat stays fully usable.
  const archiveChat = useCallback(
    async (chat: Chat) => {
      const next = !chat.archived;
      setChats((prev) =>
        prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, archived: next } : c)),
      );
      // When archiving the last one out of an expanded section, keep it open so
      // the user sees where it went; opening/closing is otherwise user-driven.
      if (next) setArchivedOpen(true);
      try {
        await api.archiveProjectChat(slug, chat.sessionId, next);
      } catch (e) {
        // Roll back the optimistic move on failure.
        setChats((prev) =>
          prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, archived: chat.archived } : c)),
        );
        setLoadErr(e instanceof Error ? e.message : "Failed to archive chat");
      }
    },
    [slug],
  );

  // Partition the (search-filtered) chat list into the current (top) and
  // archived (bottom) groups (#95). Search (#96) still finds archived chats — it
  // just surfaces them in the Archived section. `activeTotal` is the unfiltered
  // non-archived count, for the "N/total" badge while searching.
  const activeChats = visibleChats.filter((c) => !c.archived);
  const archivedChats = visibleChats.filter((c) => c.archived);
  const activeTotal = chats.filter((c) => !c.archived).length;
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

  // Fold the server-backed read-state (#189) from each chat DTO into the shared
  // client cache whenever the list changes, so `readLastSeen` prefers it. This
  // is what makes a chat opened on ANOTHER device show as read here.
  useEffect(() => {
    for (const c of chats) setServerLastSeen(c.sessionId, c.lastSeen);
  }, [chats]);

  // The set of unread chats, re-derived whenever the list, the focused chat, a
  // live completion, or a mark-seen changes. The currently-open chat is NEVER
  // unread. Otherwise a chat is unread if it was live-flagged this session, or
  // its server-reported last completed-turn time is newer than lastSeen.
  const unread = useMemo(() => {
    const s = new Set<string>();
    for (const c of chats) {
      if (view === "chat" && c.sessionId === activeSession) continue;
      if (liveUnread.has(c.sessionId)) {
        s.add(c.sessionId);
        continue;
      }
      const completed = c.lastTurnCompletedAt ? Date.parse(c.lastTurnCompletedAt) : NaN;
      if (Number.isFinite(completed) && completed > readLastSeen(c.sessionId)) {
        s.add(c.sessionId);
      }
    }
    return s;
    // seenVersion is a manual dep: readLastSeen reads localStorage, which isn't
    // reactive, so a markSeen bumps it to force this recompute.
  }, [chats, view, activeSession, liveUnread, seenVersion]);

  // Mark the focused chat seen on open / deep-link / reload (write lastSeen=now),
  // so viewing a chat clears its unread cue and keeps it read across reloads.
  useEffect(() => {
    if (view === "chat" && activeSession) markSeen(activeSession);
  }, [view, activeSession, markSeen]);

  // Live turn-complete detection for chats WITHOUT a mounted pane (the sidebar
  // can't rely on ChatPane's onTurnComplete, which only fires for the focused
  // chat). When a session leaves the shared running-set it just finished a turn:
  // mark it read if it's the focused chat, else flag it unread immediately.
  const prevRunning = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const prev = prevRunning.current;
    for (const id of prev) {
      if (runningSessions.has(id)) continue; // still running
      if (view === "chat" && id === activeSession) {
        markSeen(id); // completed while focused → stays read
      } else {
        setLiveUnread((s) => (s.has(id) ? s : new Set(s).add(id)));
      }
    }
    prevRunning.current = runningSessions;
  }, [runningSessions, view, activeSession, markSeen]);

  // One chat row — used by both the current list and the Archived section, so
  // the two stay identical (context ring, hover-menu actions) apart from where
  // they live. The Archive action toggles label/icon between the two states.
  const chatRow = (c: Chat) => {
    const isUnread = unread.has(c.sessionId);
    return (
    <div
      key={c.sessionId}
      className={`group/chat relative mb-0.5 rounded-lg transition-colors ${
        activeSession === c.sessionId && view === "chat"
          ? "bg-paddock-200/80 dark:bg-paddock-800"
          : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
      }`}
    >
      {/*
        #115: the title leads and the context/progress ring floats to the far
        right of row 1; the four hover actions drop to row 2 (an absolute
        container anchored bottom-right) instead of overlaying the title line
        (#104), so the title uses the full width at rest and on hover — no
        pr-[…] reservation needed. The title stays inside the click target so
        the whole row opens the chat.
      */}
      <button
        type="button"
        onClick={() => openChat(c.sessionId)}
        className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm"
      >
        {/* Row 1: title + the context/progress ring (spins while streaming). */}
        <span className="flex w-full items-center gap-1.5">
          {/* Unread cue (#160): a small accent dot + slightly bolder name when
              the agent finished a turn the user hasn't seen. Subtle by design;
              never shown for the currently-open chat (excluded in `unread`). */}
          {isUnread && (
            <span
              data-unread="true"
              aria-label="Unread reply"
              title="New reply you haven't read yet"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            />
          )}
          <span
            className={`min-w-0 flex-1 truncate ${isUnread ? "font-semibold" : "font-medium"}`}
          >
            {c.name}
          </span>
          {/* Provenance badge (#267): flags the "ran without me" chats —
              scheduled (a cron fired it) or spawned (another chat created it).
              Human-origin chats show nothing, so the list stays quiet. */}
          <ProvenanceBadge provenance={c.provenance} />
          {/* Ring data is fetched lazily (issue #116) so the list renders before
              the per-chat transcript parse; `working` spins it while streaming
              (issue #115). */}
          <ContextRing
            tokens={usageBySession[c.sessionId]?.contextTokens ?? c.contextTokens}
            limit={usageBySession[c.sessionId]?.contextLimit ?? c.contextLimit}
            usage={sessionUsageOf(usageBySession[c.sessionId] ?? c)}
            working={runningSessions.has(c.sessionId)}
          />
        </span>
        {/* Row 2 (left): relative time. The actions live on this row too, as
            an absolute sibling anchored bottom-right (below). */}
        <span className="text-[11px] text-paddock-400">{relativeTime(c.updatedAt)}</span>
      </button>
      <div className="absolute bottom-1 right-1.5 flex items-center gap-0.5">
        <button
          type="button"
          aria-label={`Fork chat ${c.name}`}
          title="Fork chat — branch a new chat from this one's context"
          onClick={(e) => {
            e.stopPropagation();
            setForkingChat(c);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-paddock-200 hover:text-accent focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-paddock-700 dark:hover:text-accent"
        >
          <BranchIcon width={13} height={13} />
        </button>
        <button
          type="button"
          aria-label={`Rename chat ${c.name}`}
          title="Rename chat"
          onClick={(e) => {
            e.stopPropagation();
            void renameChat(c);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-paddock-200 hover:text-paddock-700 focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-paddock-700 dark:hover:text-paddock-100"
        >
          <PencilIcon width={13} height={13} />
        </button>
        <button
          type="button"
          aria-label={`${c.archived ? "Unarchive" : "Archive"} chat ${c.name}`}
          title={c.archived ? "Unarchive chat" : "Archive chat — file it away without deleting"}
          onClick={(e) => {
            e.stopPropagation();
            void archiveChat(c);
          }}
          className={`flex h-6 w-6 items-center justify-center rounded-md transition focus:opacity-100 group-hover/chat:opacity-100 hover:bg-paddock-200 hover:text-accent dark:hover:bg-paddock-700 dark:hover:text-accent ${
            c.archived ? "text-accent opacity-100" : "text-paddock-400 opacity-0"
          }`}
        >
          <ArchiveIcon width={13} height={13} />
        </button>
        <button
          type="button"
          aria-label={`Delete chat ${c.name}`}
          title="Delete chat"
          onClick={(e) => {
            e.stopPropagation();
            setDeletingChat(c);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-rose-100 hover:text-rose-600 focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
        >
          <TrashIcon width={13} height={13} />
        </button>
      </div>
    </div>
    );
  };

  if (loadErr) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-rose-300/60 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {loadErr}
        </div>
      </div>
    );
  }
  if (!project) {
    return <div className="p-8 text-sm text-paddock-500">Loading project…</div>;
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
  // that pinned (top-level) file; otherwise the Files tab itself is active — for
  // the root list, a subdirectory, or an unpinned file open in the reader.
  const activePinnedFile =
    view === "files" && filesSubpath && pinned.includes(filesSubpath) ? filesSubpath : null;
  const filesTabActive = view === "files" && !activePinnedFile;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header. On mobile it's a compact single-row breadcrumb (the project name
          links to Home; the tags / overview badge / "updated" time and the
          summary live on the Home tab, so they're desktop-only here). On lg+ it
          wraps into the full rich header. */}
      <header className="border-b border-paddock-200 px-3 py-2.5 dark:border-paddock-800 sm:px-6 lg:py-4">
        <div className="flex items-center gap-2 lg:flex-wrap lg:gap-3">
          <button
            type="button"
            onClick={() => setSessionsOpen(true)}
            className="btn-subtle -ml-1 shrink-0 gap-1.5 px-2 py-1.5 lg:-ml-2 lg:hidden"
            aria-label="Show chats"
          >
            <ChatIcon width={16} height={16} />
            <span className="hidden sm:inline">Chats</span>
            {chats.length > 0 && (
              <span className="text-[11px] text-paddock-400">{chats.length}</span>
            )}
          </button>
          {/* The project name doubles as a breadcrumb up to the Home tab. */}
          <h1 className="min-w-0 text-xl font-semibold tracking-tight">
            <button
              type="button"
              onClick={goHome}
              title="Project home"
              className="block max-w-full truncate rounded transition-colors hover:text-accent"
            >
              {project.name}
            </button>
          </h1>
          <StatusPill status={project.status} />
          {project.domain.map((d) => (
            <TagPill key={d} tag={d} className="hidden lg:inline-flex" />
          ))}
          {project.hasOverview && (
            <span
              title="A sweep has curated an OVERVIEW.md for this project. New chats can preload it as context."
              className="hidden items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 lg:inline-flex dark:bg-emerald-950/50 dark:text-emerald-400"
            >
              <CheckIcon width={11} height={11} />
              Overview
            </span>
          )}
          {project.repoBacked && (
            <a
              href={repoHref(project.repo)}
              target="_blank"
              rel="noreferrer"
              title={`Repo-backed project — the keeper works in a clone of ${project.repo}`}
              className="hidden items-center gap-1 rounded-md bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 lg:inline-flex dark:bg-sky-950/50 dark:text-sky-400"
            >
              <BranchIcon width={11} height={11} />
              Repo
            </a>
          )}
          <span className="ml-auto hidden items-center gap-1 text-xs text-paddock-400 lg:inline-flex">
            <ClockIcon width={12} height={12} />
            updated {relativeTime(project.updated)}
          </span>
          {/* Mobile-only shortcut to start a new chat (desktop has it in the
              session-list column). */}
          <button
            type="button"
            onClick={newChat}
            aria-label="New chat"
            title="New chat"
            className="btn-subtle ml-auto shrink-0 px-2 py-1.5 lg:hidden"
          >
            <PlusIcon width={16} height={16} />
          </button>
          <ProjectMenu
            onEdit={goSettings}
            onDelete={() => setDeleteOpen(true)}
            size={18}
          />
        </div>
        {project.summary && (
          <p className="mt-1.5 hidden text-sm text-paddock-600 lg:block dark:text-paddock-400">
            {project.summary}
          </p>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Session-list backdrop (mobile only, when the drawer is open). */}
        {sessionsOpen && (
          <div
            className="fixed inset-0 z-20 bg-black/40 lg:hidden"
            aria-hidden="true"
            onClick={() => setSessionsOpen(false)}
          />
        )}
        {/* Session list — static column on lg+, off-canvas drawer on mobile. */}
        <div
          className={`fixed inset-y-0 left-0 z-30 flex w-64 max-w-[80%] shrink-0 flex-col border-r border-paddock-200 bg-canvas shadow-2xl transition-transform duration-200 ease-out dark:border-paddock-800 dark:bg-paddock-900 lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-white/40 lg:shadow-none dark:lg:bg-paddock-900/20 ${
            sessionsOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center gap-2 p-3">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                width={15}
                height={15}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-paddock-400"
              />
              <input
                type="text"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
                className="input py-1.5 pl-8 pr-8"
              />
              {searching && (
                <button
                  type="button"
                  onClick={() => setChatSearch("")}
                  aria-label="Clear search"
                  title="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-paddock-400 transition hover:bg-paddock-200 hover:text-paddock-700 dark:hover:bg-paddock-700 dark:hover:text-paddock-100"
                >
                  <XIcon width={13} height={13} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="btn-primary h-9 w-9 shrink-0 p-0"
              onClick={newChat}
              aria-label="New Chat"
              title="New Chat"
            >
              <PlusIcon width={16} height={16} />
            </button>
            <button
              type="button"
              onClick={() => setSessionsOpen(false)}
              aria-label="Close chats"
              className="btn-subtle shrink-0 px-2 py-2 lg:hidden"
            >
              <XIcon width={16} height={16} />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1 flex items-center justify-between pr-3">
              <span className="section-label">Chats</span>
              {activeTotal > 0 && (
                <span className="text-[11px] text-paddock-400">
                  {searching ? `${activeChats.length}/${activeTotal}` : activeTotal}
                </span>
              )}
            </div>
            {/* Current (non-archived) chats. When the Archived section is expanded
                this pane takes the top ~50% and scrolls independently (#95). */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {/* A fresh new chat with nothing sent yet (no session id at all). */}
              {activeSession === null && view === "chat" && !pendingChat && (
                <div className="mb-0.5 flex items-center gap-1.5 rounded-lg bg-paddock-200/80 px-2.5 py-2 text-sm dark:bg-paddock-800">
                  <ChatIcon width={13} height={13} className="text-paddock-500" />
                  <span className="font-medium italic text-paddock-600 dark:text-paddock-300">
                    New chat…
                  </span>
                </div>
              )}
              {/* A new chat that has started streaming but isn't in the server
                  list yet — a real, clickable entry so it's clearly created and
                  safe to navigate away from (issue #36). */}
              {pendingChat && !chats.some((c) => c.sessionId === pendingChat) && (
                <div
                  className={`group/chat relative mb-0.5 rounded-lg transition-colors ${
                    activeSession === pendingChat && view === "chat"
                      ? "bg-paddock-200/80 dark:bg-paddock-800"
                      : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
                  }`}
                >
                  <button
                    onClick={() => openChat(pendingChat)}
                    className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium italic text-paddock-600 dark:text-paddock-300">
                      New chat…
                    </span>
                    {/* #115: the merged spinning ring stands in for the old
                        pulsing dot — an indeterminate spinner (no fill arc yet). */}
                    <ContextRing working />
                  </button>
                </div>
              )}
              {/* The open chat, kept visible even if it's momentarily missing
                  from the list (mis-attributed by the post-turn sweep, #154). */}
              {fallbackChat && chatRow(fallbackChat)}
              {chats.length === 0 && !fallbackChat && (
                <p className="px-2 py-2 text-sm text-paddock-500">
                  No saved chats yet. Send a message to start one.
                </p>
              )}
              {chats.length > 0 && searching && visibleChats.length === 0 && !fallbackChat && (
                <p className="px-2 py-2 text-sm text-paddock-500">
                  No chats match “{chatSearch.trim()}”.
                </p>
              )}
              {chats.length > 0 && !searching && activeChats.length === 0 && !fallbackChat && (
                <p className="px-2 py-2 text-sm text-paddock-500">
                  No active chats — see Archived below.
                </p>
              )}
              {activeChats.map(chatRow)}
            </div>
            {/* Archived section (#95): a collapsible accordion pinned to the
                bottom. Collapsed by default with a count badge; expanding it
                animates up to a ~50% splitter, its list scrolling independently. */}
            {archivedChats.length > 0 && (
              <div
                className={`flex flex-col border-t border-paddock-200 dark:border-paddock-800 ${
                  archivedOpen ? "min-h-0 flex-1" : "shrink-0"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setArchivedOpen((o) => !o)}
                  aria-expanded={archivedOpen}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-paddock-500 transition-colors hover:bg-paddock-200/40 dark:text-paddock-400 dark:hover:bg-paddock-800/40"
                >
                  <ChevronDownIcon
                    width={14}
                    height={14}
                    className={`shrink-0 transition-transform ${archivedOpen ? "" : "-rotate-90"}`}
                  />
                  <span>Archived</span>
                  <span className="ml-auto rounded-full bg-paddock-200 px-1.5 py-0.5 text-[10px] font-semibold normal-case text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300">
                    {archivedChats.length}
                  </span>
                </button>
                {archivedOpen && (
                  <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                    {archivedChats.map(chatRow)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Main: tabs + content. The active tab is derived from the URL. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* On mobile the chat view hides the tab bar — the compact header
              breadcrumb (name → Home) is the way back to the tabbed hub, so the
              chat gets the full height. Tabs stay visible on Home/Files/Changes
              and on lg+ everywhere. */}
          <div
            className={`items-center gap-1 overflow-x-auto border-b border-paddock-200 px-4 dark:border-paddock-800 ${
              view === "chat" ? "hidden lg:flex" : "flex"
            }`}
          >
            <TabButton active={view === "home"} onClick={goHome}>
              Home
            </TabButton>
            <TabButton active={view === "chat"} onClick={goChat}>
              Chat
            </TabButton>
            <TabButton active={filesTabActive} onClick={goFiles}>
              Files
            </TabButton>
            {/* The Changes tab appears ONLY when the projects dir is a git repo.
                It carries a subtle "N uncommitted" badge so pending work is
                visible without opening it. */}
            {gitStatus && (
              <TabButton active={view === "changes"} onClick={goChanges}>
                <span className="inline-flex items-center gap-1.5">
                  Changes
                  {gitStatus.files.length > 0 && (
                    <span
                      title={`${gitStatus.files.length} uncommitted change${
                        gitStatus.files.length === 1 ? "" : "s"
                      }`}
                      className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                    >
                      {gitStatus.files.length}
                    </span>
                  )}
                </span>
              </TabButton>
            )}
            {/* The History tab — the "while you were away" run view (#268). Its
                badge counts unattended (scheduled + spawned) runs that finished
                since the user last opened it, so unattended work is visible
                without opening the tab. */}
            <TabButton active={view === "history"} onClick={goHistory}>
              <span className="inline-flex items-center gap-1.5">
                History
                {newRunCount > 0 && (
                  <span
                    title={`${newRunCount} new unattended run${newRunCount === 1 ? "" : "s"} since your last visit`}
                    className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-semibold text-accent-700 dark:text-accent"
                  >
                    {newRunCount}
                  </span>
                )}
              </span>
            </TabButton>
            <TabButton active={view === "settings"} onClick={goSettings}>
              <span className="inline-flex items-center gap-1.5">
                <WrenchIcon width={13} height={13} />
                Settings
              </span>
            </TabButton>
            {/* Pinned file tabs (sibling tabs), order preserved by the server.
                Each links to /files/:name so the tab is deep-linkable. */}
            {pinned.map((f) => (
              <PinnedTab
                key={f}
                file={f}
                active={activePinnedFile === f}
                onSelect={() => goToFilesPath(f)}
                onUnpin={() => void unpinTab(f)}
              />
            ))}
          </div>

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
          {view === "settings" && (
            <SettingsPane
              project={project}
              onSaved={(p) => {
                setProject(p);
                upsert(p);
              }}
            />
          )}
          {view === "home" && (
            <HomePane
              project={project}
              chats={chats}
              changelog={changelog}
              files={files}
              runningSessions={runningSessions}
              onOpenChat={openChat}
              onNewChat={newChat}
              onOpenFile={goToFilesPath}
              onOpenFiles={goFiles}
              onEditDetails={goSettings}
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
              forkParent={forkParent ?? undefined}
              onOpenForkParent={openChat}
              autoFocus={justForked}
              isProjectChat
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

      <ConfirmDialog
        open={deleteOpen}
        title="Delete project?"
        message={
          <>
            <span className="font-medium text-ink dark:text-ink-dark">{project.name}</span> and all
            its chats and files will be permanently removed. This cannot be undone.
          </>
        }
        confirmLabel="Delete project"
        onConfirm={async () => {
          await api.deleteProject(project.slug);
          remove(project.slug);
          clearLastTab(project.slug);
          navigate("/");
        }}
        onClose={() => setDeleteOpen(false)}
      />
      <ConfirmDialog
        open={deletingChat !== null}
        title="Delete chat?"
        message="This chat's transcript will be permanently removed. This cannot be undone."
        confirmLabel="Delete chat"
        onConfirm={confirmDeleteChat}
        onClose={() => setDeletingChat(null)}
      />
      {forkingChat && (
        <ForkChatModal
          open
          chatName={forkingChat.name}
          onClose={() => setForkingChat(null)}
          onFork={(name) => {
            const chat = forkingChat;
            setForkingChat(null);
            void forkChat(chat, name);
          }}
        />
      )}
    </div>
  );
}

/** A pinned-file sibling tab with a small unpin "x". */
function PinnedTab({
  file,
  active,
  onSelect,
  onUnpin,
}: {
  file: string;
  active: boolean;
  onSelect: () => void;
  onUnpin: () => void;
}) {
  return (
    <div
      className={`group/pin -mb-px flex items-center gap-1 border-b-2 pr-1 transition-colors ${
        active
          ? "border-accent"
          : "border-transparent"
      }`}
    >
      <button
        onClick={onSelect}
        title={file}
        aria-label={`Open ${file} tab`}
        role="tab"
        aria-selected={active}
        className={`flex items-center gap-1.5 py-2.5 pl-3 pr-1 text-sm font-medium transition-colors ${
          active
            ? "text-ink dark:text-ink-dark"
            : "text-paddock-500 hover:text-paddock-700 dark:hover:text-paddock-300"
        }`}
      >
        <PinIcon width={12} height={12} className="shrink-0 text-accent" />
        <span className="max-w-[10rem] truncate">{file}</span>
      </button>
      <button
        type="button"
        aria-label={`Unpin ${file}`}
        title={`Unpin ${file}`}
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        className="flex h-5 w-5 items-center justify-center rounded text-paddock-400 opacity-60 transition hover:bg-paddock-200/70 hover:text-paddock-700 focus:opacity-100 group-hover/pin:opacity-100 dark:hover:bg-paddock-800"
      >
        <XIcon width={12} height={12} />
      </button>
    </div>
  );
}

/**
 * The Home tab: the project's landing/overview. Gives `/projects/:slug` a real
 * destination (instead of silently forwarding into a chat) and is the mobile
 * navigation hub — summary + metadata + edit, recent chats, recent files, and
 * the CHANGELOG, all deep-linkable via `/projects/:slug/home`.
 */
function HomePane({
  project,
  chats,
  changelog,
  files,
  runningSessions,
  onOpenChat,
  onNewChat,
  onOpenFile,
  onOpenFiles,
  onEditDetails,
}: {
  project: Project;
  chats: Chat[];
  changelog: string;
  files: string[];
  runningSessions: ReadonlySet<string>;
  onOpenChat: (sessionId: string) => void;
  onNewChat: () => void;
  onOpenFile: (name: string) => void;
  onOpenFiles: () => void;
  onEditDetails: () => void;
}) {
  const recentChats = chats.slice(0, 6);
  const recentFiles = files.slice(0, 6);
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-6 py-6">
        {/* Overview: summary + metadata + edit-details shortcut. */}
        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">
              Overview
            </h3>
            <button
              onClick={onEditDetails}
              className="btn-subtle -mr-1 gap-1.5 px-2 py-1 text-xs"
            >
              <PencilIcon width={13} height={13} />
              Edit details
            </button>
          </div>
          <div className="card">
            {project.summary ? (
              <p className="text-sm text-paddock-700 dark:text-paddock-300">{project.summary}</p>
            ) : (
              <p className="text-sm italic text-paddock-400">No summary set yet.</p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-3">
              <Meta label="Status" value={project.status} />
              <Meta label="Area" value={areaLabel(project.group)} />
              <Meta label="Visibility" value={project.visibility} />
              <Meta label="Model" value={project.model} />
              <Meta label="Started" value={project.started} />
              <Meta label="Updated" value={project.updated} />
              {project.domain.length > 0 && (
                <Meta label="Domains" value={project.domain.join(", ")} />
              )}
              {project.repoBacked && project.repo && (
                <Meta label="Repo" value={project.repo} />
              )}
            </dl>
            {project.links && project.links.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {project.links.map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md bg-paddock-100 px-2 py-1 text-xs text-paddock-700 transition-colors hover:bg-paddock-200 dark:bg-paddock-900 dark:text-paddock-300 dark:hover:bg-paddock-800"
                  >
                    <LinkIcon width={12} height={12} />
                    {l.label || l.url}
                  </a>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Chats: recent sessions + a shortcut to start a new one. */}
        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">
              Chats
              {chats.length > 0 && <span className="ml-1.5 text-paddock-400">{chats.length}</span>}
            </h3>
            <button onClick={onNewChat} className="btn-subtle -mr-1 gap-1.5 px-2 py-1 text-xs">
              <PlusIcon width={13} height={13} />
              New chat
            </button>
          </div>
          {recentChats.length === 0 ? (
            <div className="card">
              <p className="text-sm italic text-paddock-400">
                No chats yet. Start one to begin working with the keeper agent.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-paddock-200 dark:border-paddock-800">
              {recentChats.map((c, i) => (
                <button
                  key={c.sessionId}
                  onClick={() => onOpenChat(c.sessionId)}
                  className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-paddock-100/70 dark:hover:bg-paddock-900/40 ${
                    i > 0 ? "border-t border-paddock-200 dark:border-paddock-800" : ""
                  }`}
                >
                  {runningSessions.has(c.sessionId) ? (
                    <span
                      title="Streaming a response…"
                      aria-label="streaming"
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                    />
                  ) : (
                    <ChatIcon width={14} height={14} className="shrink-0 text-paddock-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                  <span className="shrink-0 text-[11px] text-paddock-400">
                    {relativeTime(c.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Files: a preview of the file index; "View all" jumps to the Files tab. */}
        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">
              Files
              {files.length > 0 && <span className="ml-1.5 text-paddock-400">{files.length}</span>}
            </h3>
            {files.length > recentFiles.length && (
              <button onClick={onOpenFiles} className="btn-subtle -mr-1 px-2 py-1 text-xs">
                View all
              </button>
            )}
          </div>
          {recentFiles.length === 0 ? (
            <div className="card">
              <p className="text-sm italic text-paddock-400">
                No files yet. Files the keeper agent writes appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-paddock-200 dark:border-paddock-800">
              {recentFiles.map((f, i) => (
                <button
                  key={f}
                  onClick={() => onOpenFile(f)}
                  className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-paddock-100/70 dark:hover:bg-paddock-900/40 ${
                    i > 0 ? "border-t border-paddock-200 dark:border-paddock-800" : ""
                  }`}
                >
                  <FileIcon width={15} height={15} className="shrink-0 text-paddock-400" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-paddock-700 dark:text-paddock-200">
                    {f}
                  </span>
                  {project.pinned.includes(f) && (
                    <PinIcon width={12} height={12} className="shrink-0 text-accent" />
                  )}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* CHANGELOG.md — the curated project log. */}
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-paddock-500">
            CHANGELOG.md
          </h3>
          <div className="card">
            {changelog.trim() ? (
              <Markdown>{changelog}</Markdown>
            ) : (
              <p className="text-sm italic text-paddock-400">No CHANGELOG.md yet.</p>
            )}
          </div>
        </section>

        <p className="mt-6 text-[11px] text-paddock-400">
          Project directory: <span className="font-mono">{project.dir}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * Best-effort browsable URL for a repo-backed project's repo (issue #187): strip
 * a trailing `.git`, and rewrite an `scp`-style `git@host:owner/repo` into
 * `https://host/owner/repo` so the "Repo" badge links somewhere useful. A plain
 * https/http URL passes through; anything unrecognized (a local path) falls back
 * to `#` so the badge is inert rather than broken.
 */
/**
 * Extract the Files-tab subpath from the pathname (issue #259): whatever follows
 * `/projects/:slug/files/`, decoded one segment at a time so real "/" separators
 * survive intact (a raw `decodeURIComponent` of the whole thing is fine here too,
 * but per-segment mirrors exactly how goToFilesPath encodes it). "" = the root.
 */
function decodeFilesSubpath(pathname: string, slug: string): string {
  const prefix = `/projects/${slug}/files`;
  if (!pathname.startsWith(prefix)) return "";
  const rest = pathname.slice(prefix.length).replace(/^\//, "");
  if (!rest) return "";
  return rest
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

function repoHref(repo?: string): string {
  if (!repo) return "#";
  const trimmed = repo.trim().replace(/\.git$/i, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const scp = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/i.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return "#";
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-paddock-400">
        {label}
      </dt>
      <dd className="text-paddock-700 dark:text-paddock-300">{value}</dd>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-accent text-ink dark:text-ink-dark"
          : "border-transparent text-paddock-500 hover:text-paddock-700 dark:hover:text-paddock-300"
      }`}
    >
      {children}
    </button>
  );
}
