import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { chatClient } from "../lib/ws";
import { useProjects } from "../lib/projects-context";
import type { Chat, ChatCompleteUsage, ChatUsage, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { TagPill } from "../components/TagPill";
import { ChatPane } from "../components/ChatPane";
import type { ShellOutletContext } from "../components/AppShell";
import { ChangesPane } from "../components/ChangesPane";
import { HistoryPane } from "../components/HistoryPane";
import { useProjectRuns } from "../lib/useProjectRuns";
import { FilesPane } from "../components/FilesPane";
import { ProjectMenu } from "../components/ProjectMenu";
import { SettingsPane } from "../components/SettingsPane";
import { TriggersPane } from "../components/TriggersPane";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ForkChatModal } from "../components/ForkChatModal";
import { usePaneWidth } from "../components/PaneResizer";
import { CHATLIST_PANE } from "../lib/paneWidth";
import {
  BoltIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  MenuIcon,
  PlusIcon,
  WrenchIcon,
} from "../components/icons";
import { relativeTime } from "../lib/format";
import { clearLastTab, toSubPath, writeLastTab } from "../lib/lastTab";
import { readForkParent, writeForkParent } from "../lib/forkLineage";
import type { GitProjectStatus } from "../lib/types";
import { decodeFilesSubpath, deriveView, repoHref } from "./ProjectView/urls";
import { TabButton } from "./ProjectView/TabButton";
import { PinnedTab } from "./ProjectView/PinnedTab";
import { HomePane } from "./ProjectView/HomePane";
import { SessionSidebar } from "./ProjectView/SessionSidebar";
import { useUnreadChats } from "./ProjectView/useUnreadChats";

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
  // Opens the global project-nav drawer (#372). On mobile this view hosts the
  // hamburger inline in its own header, so the shell's brand row can be dropped.
  // Tolerates a missing context (rendered outside the shell, e.g. in tests) by
  // falling back to a no-op.
  const shell = useOutletContext<ShellOutletContext | null>();
  const openNav = shell?.openNav ?? (() => {});
  const { refresh: refreshProjects, upsert, remove } = useProjects();

  // Which sub-route are we on? Derived purely from the URL (see `deriveView`).
  const view = deriveView(location.pathname, slug);
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
  // Desktop-only draggable width for the chat-list pane (#374), persisted per-browser.
  const chatList = usePaneWidth(CHATLIST_PANE);
  const autoExpandedFor = useRef<string | null>(null);

  // The active chat session is the URL's sessionId (null = a fresh "new chat").
  const activeSession = routeSessionId ?? null;

  // Unread affordance (#160): owns liveUnread/seenVersion, folds server read-state
  // (#189), and derives the unread set + marks the focused chat seen. Takes the
  // WS-owned `runningSessions` (kept owned here so the fleet-wide set doesn't
  // fragment) to flag chats that finish a turn while unfocused.
  const { unread } = useUnreadChats({ slug, chats, view, activeSession, runningSessions });

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
            : view === "triggers"
              ? toSubPath({ view: "triggers" })
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
  const goTriggers = useCallback(() => navigate(`/projects/${slug}/triggers`), [navigate, slug]);
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
  // The Hooks tab was renamed + folded into Triggers (Epic T / T4). Redirect any old
  // `/hooks` link/bookmark to the canonical `/triggers` route (replace so Back skips it).
  useEffect(() => {
    if (location.pathname.startsWith(`/projects/${slug}/hooks`)) {
      navigate(`/projects/${slug}/triggers`, { replace: true });
    }
  }, [location.pathname, navigate, slug]);
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
  // Fork a NEW chat branched at an earlier message (issue #451): fork the active
  // session's PREFIX up to `uuid`, then jump to the new chat to continue it.
  const forkFromMessage = useCallback(
    async (uuid: string) => {
      if (!activeSession) return;
      const source = chats.find((c) => c.sessionId === activeSession);
      const name = source ? `Fork of ${source.name}` : undefined;
      let newId: string;
      try {
        newId = await api.forkChat(slug, activeSession, name, uuid);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : "Failed to fork chat");
        return;
      }
      if (source) writeForkParent(newId, { sessionId: source.sessionId, name: source.name });
      await refreshChats();
      navigate(`/projects/${slug}/chat/${encodeURIComponent(newId)}`, {
        state: { justForked: true },
      });
    },
    [activeSession, chats, navigate, slug, refreshChats],
  );
  // Revert the active chat back to an earlier message (issue #451): truncate in
  // place (same session id); the pane reloads its own shorter transcript once
  // this resolves. Rethrow so the pane surfaces the failure and skips its reload.
  const revertToMessage = useCallback(
    async (uuid: string) => {
      if (!activeSession) return;
      try {
        await api.revertChat(slug, activeSession, uuid);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : "Failed to revert chat");
        throw e;
      }
      await refreshChats();
    },
    [activeSession, slug, refreshChats],
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

  // Star or unstar a chat (#373): toggle the persisted flag and optimistically
  // re-pin it to the top of its population. Orthogonal to archiving — starring
  // never moves a chat between the active and Archived sections.
  const starChat = useCallback(
    async (chat: Chat) => {
      const next = !chat.starred;
      setChats((prev) =>
        prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, starred: next } : c)),
      );
      try {
        await api.starProjectChat(slug, chat.sessionId, next);
      } catch (e) {
        // Roll back the optimistic pin on failure.
        setChats((prev) =>
          prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, starred: chat.starred } : c)),
        );
        setLoadErr(e instanceof Error ? e.message : "Failed to star chat");
      }
    },
    [slug],
  );

  // Float starred chats to the top of a list while preserving the existing
  // (server, mtime-ordered) order within the starred and unstarred groups (#373).
  // `Array.filter` is a stable partition, so this is order-preserving.
  const starredFirst = (list: Chat[]) => [
    ...list.filter((c) => c.starred),
    ...list.filter((c) => !c.starred),
  ];

  // Partition the (search-filtered) chat list into the current (top) and
  // archived (bottom) groups (#95), each with starred chats pinned to the top
  // (#373). Search (#96) still finds archived chats — it just surfaces them in
  // the Archived section. `activeTotal` is the unfiltered non-archived count,
  // for the "N/total" badge while searching.
  const activeChats = starredFirst(visibleChats.filter((c) => !c.archived));
  const archivedChats = starredFirst(visibleChats.filter((c) => c.archived));
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
  // that pinned file (at any depth); otherwise the Files tab itself is active —
  // for the root list, a subdirectory, or an unpinned file open in the reader.
  const activePinnedFile =
    view === "files" && filesSubpath && pinned.includes(filesSubpath) ? filesSubpath : null;
  const filesTabActive = view === "files" && !activePinnedFile;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header. On mobile it's a compact single row that also HOSTS the global
          nav hamburger (#372) — the shell drops its separate brand row on project
          routes so these two collapse into one, reclaiming vertical space. The
          project name links to Home; the tags / overview badge / "updated" time
          and the summary live on the Home tab (desktop-only here). `pt-safe`
          clears the status bar/notch now that the shell's bar is gone. On lg+ it
          wraps into the full rich header. */}
      <header className="pt-safe border-b border-paddock-200 px-3 pb-2.5 dark:border-paddock-800 sm:px-6 lg:py-4">
        <div className="flex items-center gap-2 lg:flex-wrap lg:gap-3">
          {/* Global project-nav drawer — inline on mobile only (the shell's own
              hamburger row is suppressed on project routes). */}
          <button
            type="button"
            onClick={openNav}
            className="btn-subtle -ml-1 shrink-0 px-2 py-1.5 lg:hidden"
            aria-label="Open menu"
          >
            <MenuIcon width={20} height={20} />
          </button>
          <button
            type="button"
            onClick={() => setSessionsOpen(true)}
            className="btn-subtle shrink-0 gap-1.5 px-2 py-1.5 lg:-ml-2 lg:hidden"
            aria-label="Show chats"
          >
            <ChatIcon width={16} height={16} />
            <span className="hidden sm:inline">Chats</span>
            {chats.length > 0 && (
              <span className="text-[11px] text-paddock-400">{chats.length}</span>
            )}
          </button>
          {/* The project name doubles as a breadcrumb up to the Home tab. */}
          <h1 className="min-w-0 text-lg font-semibold tracking-tight lg:text-xl">
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
          archivedOpen={archivedOpen}
          setArchivedOpen={setArchivedOpen}
          openChat={openChat}
          unread={unread}
          usageBySession={usageBySession}
          runningSessions={runningSessions}
          setForkingChat={setForkingChat}
          renameChat={renameChat}
          archiveChat={archiveChat}
          setDeletingChat={setDeletingChat}
          starChat={starChat}
        />

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
            {/* The Triggers tab (Epic T / T4): per-project triggers — an agent turn
                that fires on a schedule, a lifecycle event, or a webhook (reserved),
                with a precise type + capability picker. Folds in the former Hooks tab
                and the Settings→Schedules section. */}
            <TabButton active={view === "triggers"} onClick={goTriggers}>
              <span className="inline-flex items-center gap-1.5">
                <BoltIcon width={13} height={13} />
                Triggers
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
          {/* The Triggers tab (Epic T / T4): a self-contained CRUD surface for this
              project's unified triggers (schedules + events + reserved webhooks). Its
              create/edit/delete/enable run through the unified /triggers endpoints, so
              it manages its own state. */}
          {view === "triggers" && <TriggersPane project={project} />}
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
              // Per-project keeper-chat recovery override (issue #301); combined
              // with the instance default to gate the killed-task Continue button.
              projectRecovery={project.recovery}
              // Per-project inbound-attachment override (issue #328); combined
              // with the instance default to resolve the composer's picker + caps.
              projectAttachments={project.attachments}
              forkParent={forkParent ?? undefined}
              onOpenForkParent={openChat}
              onForkFromMessage={forkFromMessage}
              onRevertToMessage={revertToMessage}
              autoFocus={justForked}
              isProjectChat
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
