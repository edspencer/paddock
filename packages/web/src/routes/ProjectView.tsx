import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { chatClient } from "../lib/ws";
import { useProjects } from "../lib/projects-context";
import type { Chat, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { TagPill } from "../components/TagPill";
import { ChatPane } from "../components/ChatPane";
import { ContextRing } from "../components/ContextRing";
import { ChangesPane } from "../components/ChangesPane";
import { Markdown } from "../components/Markdown";
import { FileView } from "../components/FileView";
import { ProjectMenu } from "../components/ProjectMenu";
import { EditProjectModal } from "../components/EditProjectModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  FileIcon,
  LinkIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "../components/icons";
import { relativeTime } from "../lib/format";
import { areaLabel } from "../lib/areas";
import { clearLastTab, toSubPath, writeLastTab } from "../lib/lastTab";
import { readForkParent, writeForkParent } from "../lib/forkLineage";
import type { GitProjectStatus } from "../lib/types";

/**
 * The active view ("home" | "chat" | "files") and the selected chat/file are
 * derived from the URL via the route's params, NOT local state. This makes every
 * tab, chat, and file deep-linkable + restorable on reload, and keeps the tab
 * bar highlighting correct on a direct load. Routes that mount this component:
 *   /projects/:slug/home                -> Home tab (project overview)
 *   /projects/:slug/chat[/:sessionId]   -> Chat tab (optionally a saved chat)
 *   /projects/:slug/files[/:name]       -> Files tab / a specific file (or pin)
 */
export function ProjectView() {
  const params = useParams();
  const slug = params.slug ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh: refreshProjects, upsert, remove } = useProjects();

  // Which sub-route are we on? Derived from the URL pathname so it updates on
  // client-side navigation (the `/home` and `/files` segments distinguish those
  // tabs; anything else is the chat tab).
  const view: "home" | "chat" | "files" = location.pathname.startsWith(
    `/projects/${slug}/files`,
  )
    ? "files"
    : location.pathname.startsWith(`/projects/${slug}/home`)
      ? "home"
      : "chat";
  const routeSessionId = view === "chat" ? params.sessionId : undefined;
  const routeFileName = view === "files" && params.name ? decodeURIComponent(params.name) : undefined;

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
  const chatPaneKey = paneKeyRef.current.counter;

  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
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
  // hidden. The "Changes" tab is local UI state (not a route), so it overlays
  // the URL-driven chat/files tabs; selecting Chat/Files dismisses it.
  const [gitStatus, setGitStatus] = useState<GitProjectStatus | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  // Mobile: the session list is an off-canvas drawer (static column on lg+).
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingChat, setDeletingChat] = useState<Chat | null>(null);

  // The active chat session is the URL's sessionId (null = a fresh "new chat").
  const activeSession = routeSessionId ?? null;

  // Fetch the project's git status; clears it (hiding the Changes tab) when the
  // projects dir isn't a repo or the request fails. Safe to call freely.
  const refreshGit = useCallback(async () => {
    const next = await api.gitStatus(slug).catch(() => null);
    setGitStatus(next && next.repo ? next : null);
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
  }, [slug, refreshGit]);

  useEffect(() => {
    setProject(null);
    setGitStatus(null);
    setShowChanges(false);
    void load();
  }, [slug, load]);

  // Sticky last tab: persist the current in-project sub-path for this project
  // whenever the URL (view / session / file) changes, so the bare
  // `/projects/:slug` redirect can restore exactly where the user left off.
  useEffect(() => {
    const sub =
      view === "home"
        ? toSubPath({ view: "home" })
        : view === "chat"
          ? toSubPath({ view: "chat", sessionId: routeSessionId })
          : toSubPath({ view: "files", name: routeFileName });
    writeLastTab(slug, sub);
  }, [slug, view, routeSessionId, routeFileName]);

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
  }, [slug, refreshGit]);

  const loadHistory = useCallback(
    (sessionId: string) => api.projectChatMessages(slug, sessionId),
    [slug],
  );

  // Any navigation back to a URL-driven tab dismisses the Changes overlay so the
  // routed content (chat / file) shows through again.
  useEffect(() => {
    setShowChanges(false);
    setSessionsOpen(false);
  }, [view, routeSessionId, routeFileName]);

  // --- URL-driven navigation (all tab/chat/file clicks change the route) -----
  const goHome = useCallback(() => navigate(`/projects/${slug}/home`), [navigate, slug]);
  const goChat = useCallback(() => navigate(`/projects/${slug}/chat`), [navigate, slug]);
  const goFiles = useCallback(() => navigate(`/projects/${slug}/files`), [navigate, slug]);
  const newChat = goChat;
  const openChat = useCallback(
    (sessionId: string) =>
      navigate(`/projects/${slug}/chat/${encodeURIComponent(sessionId)}`),
    [navigate, slug],
  );
  // Fork a chat: eagerly duplicate it server-side into a NEW session in the same
  // project, then jump straight to it. The fork exists immediately — a real,
  // resumable chat with the parent's full history visible — titled
  // "Fork of <parent>". We record the lineage locally for the composer back-link
  // and pass `justForked` so the pane focuses the composer to continue.
  const forkChat = useCallback(
    async (chat: Chat) => {
      let newId: string;
      try {
        newId = await api.forkChat(slug, chat.sessionId, `Fork of ${chat.name}`);
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
  const openFile = useCallback(
    (name: string) => navigate(`/projects/${slug}/files/${encodeURIComponent(name)}`),
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

  const onTurnComplete = useCallback(() => {
    void refreshAfterTurn();
    void refreshProjects();
  }, [refreshAfterTurn, refreshProjects]);

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
      if (routeFileName === file) navigate(`/projects/${slug}/files`, { replace: true });
    },
    [slug, upsert, routeFileName, navigate],
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
  const viewingFile = view === "files" ? (routeFileName ?? null) : null;
  const activePinnedFile = viewingFile && pinned.includes(viewingFile) ? viewingFile : null;
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
            onEdit={() => setEditOpen(true)}
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
            <button className="btn-primary w-full" onClick={newChat}>
              <PlusIcon width={15} height={15} />
              New Chat
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
          <div className="mb-1 flex items-center justify-between pr-3">
            <span className="section-label">Chats</span>
            {chats.length > 0 && (
              <span className="text-[11px] text-paddock-400">{chats.length}</span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
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
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                  <span className="truncate font-medium italic text-paddock-600 dark:text-paddock-300">
                    New chat…
                  </span>
                </button>
              </div>
            )}
            {chats.length === 0 && (
              <p className="px-2 py-2 text-sm text-paddock-500">
                No saved chats yet. Send a message to start one.
              </p>
            )}
            {chats.map((c) => (
              <div
                key={c.sessionId}
                className={`group/chat relative mb-0.5 rounded-lg transition-colors ${
                  activeSession === c.sessionId && view === "chat"
                    ? "bg-paddock-200/80 dark:bg-paddock-800"
                    : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
                }`}
              >
                <button
                  onClick={() => openChat(c.sessionId)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 pr-[5.25rem] text-left text-sm"
                >
                  <span className="flex w-full items-center gap-1.5">
                    {runningSessions.has(c.sessionId) && (
                      <span
                        title="Streaming a response…"
                        aria-label="streaming"
                        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                      />
                    )}
                    <ContextRing tokens={c.contextTokens} limit={c.contextLimit} />
                    <span className="truncate font-medium">{c.name}</span>
                  </span>
                  <span className="text-[11px] text-paddock-400">{relativeTime(c.updatedAt)}</span>
                </button>
                <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={`Fork chat ${c.name}`}
                    title="Fork chat — branch a new chat from this one's context"
                    onClick={(e) => {
                      e.stopPropagation();
                      void forkChat(c);
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
            ))}
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
              view === "chat" && !showChanges ? "hidden lg:flex" : "flex"
            }`}
          >
            <TabButton active={view === "home" && !showChanges} onClick={goHome}>
              Home
            </TabButton>
            <TabButton active={view === "chat" && !showChanges} onClick={goChat}>
              Chat
            </TabButton>
            <TabButton active={filesTabActive && !showChanges} onClick={goFiles}>
              Files
            </TabButton>
            {/* The Changes tab appears ONLY when the projects dir is a git repo.
                It carries a subtle "N uncommitted" badge so pending work is
                visible without opening it. */}
            {gitStatus && (
              <TabButton active={showChanges} onClick={() => setShowChanges(true)}>
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
            {/* Pinned file tabs (sibling tabs), order preserved by the server.
                Each links to /files/:name so the tab is deep-linkable. */}
            {pinned.map((f) => (
              <PinnedTab
                key={f}
                file={f}
                active={activePinnedFile === f && !showChanges}
                onSelect={() => {
                  setShowChanges(false);
                  openFile(f);
                }}
                onUnpin={() => void unpinTab(f)}
              />
            ))}
          </div>

          {/* The Changes panel overlays the routed tab content when open. It
              owns refetching status post-commit and propagates it up so the tab
              badge stays in sync. */}
          {showChanges && gitStatus && (
            <ChangesPane
              slug={project.slug}
              status={gitStatus}
              onStatusChange={(s) => setGitStatus(s.repo ? s : null)}
            />
          )}
          {!showChanges && view === "home" && (
            <HomePane
              project={project}
              chats={chats}
              changelog={changelog}
              files={files}
              runningSessions={runningSessions}
              onOpenChat={openChat}
              onNewChat={newChat}
              onOpenFile={openFile}
              onOpenFiles={goFiles}
              onEditDetails={() => setEditOpen(true)}
            />
          )}
          {!showChanges && view === "chat" && (
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
          {/* Files tab with no file selected -> the files list. */}
          {!showChanges && view === "files" && !viewingFile && (
            <FilesList
              project={project}
              files={files}
              onOpenFile={openFile}
              onTogglePin={togglePin}
            />
          )}
          {/* Any /files/:name (pinned or not) -> the single file reader. The
              same component renders regardless of pinned state, so pinning the
              file you're viewing only changes which tab is highlighted. */}
          {!showChanges && view === "files" && viewingFile && (
            <FileReader
              key={viewingFile}
              project={project}
              name={viewingFile}
              onBack={goFiles}
              onTogglePin={togglePin}
            />
          )}
        </div>
      </div>

      {editOpen && (
        <EditProjectModal
          open
          project={project}
          onClose={() => setEditOpen(false)}
          onSaved={(p) => {
            setProject(p);
            upsert(p);
            setEditOpen(false);
          }}
        />
      )}
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
 * The single file reader for /files/:name (used for both an unpinned file
 * opened from the list AND a pinned sibling tab). A back link returns to the
 * files list; the pin toggle pins/unpins the file (which only moves the tab
 * highlight, since this same reader keeps rendering the file).
 */
function FileReader({
  project,
  name,
  onBack,
  onTogglePin,
}: {
  project: Project;
  name: string;
  onBack: () => void;
  onTogglePin: (file: string) => void;
}) {
  const isPinned = project.pinned.includes(name);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-paddock-200 px-4 py-2 dark:border-paddock-800">
        <button onClick={onBack} className="btn-subtle -ml-2 py-1.5 text-xs">
          ← Files
        </button>
        <span className="font-mono text-sm text-paddock-700 dark:text-paddock-300">{name}</span>
        <button
          onClick={() => onTogglePin(name)}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
            isPinned
              ? "bg-accent/10 text-accent"
              : "text-paddock-500 hover:bg-paddock-200/60 dark:hover:bg-paddock-800/60"
          }`}
          title={isPinned ? "Unpin (remove tab)" : "Pin as a tab"}
        >
          <PinIcon width={13} height={13} />
          {isPinned ? "Pinned" : "Pin as tab"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <FileView slug={project.slug} name={name} />
      </div>
    </div>
  );
}

/** The Files tab: the project's file index (summary + CHANGELOG live on Home). */
function FilesList({
  project,
  files,
  onOpenFile,
  onTogglePin,
}: {
  project: Project;
  files: string[];
  onOpenFile: (name: string) => void;
  onTogglePin: (file: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-paddock-500">
            Files
          </h3>
          {files.length === 0 ? (
            <div className="card">
              <p className="text-sm italic text-paddock-400">
                No files yet. Files the keeper agent writes (and sweep-curated
                OVERVIEW.md) will appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-paddock-200 dark:border-paddock-800">
              {files.map((f, i) => {
                const isPinned = project.pinned.includes(f);
                return (
                  <div
                    key={f}
                    className={`group/file flex items-center gap-2 px-3 py-2.5 transition-colors hover:bg-paddock-100/70 dark:hover:bg-paddock-900/40 ${
                      i > 0 ? "border-t border-paddock-200 dark:border-paddock-800" : ""
                    }`}
                  >
                    <button
                      onClick={() => onOpenFile(f)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <FileIcon
                        width={15}
                        height={15}
                        className="shrink-0 text-paddock-400"
                      />
                      <span className="truncate font-mono text-sm text-paddock-700 dark:text-paddock-200">
                        {f}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={isPinned ? `Unpin ${f}` : `Pin ${f}`}
                      title={isPinned ? "Unpin (remove tab)" : "Pin as a sibling tab"}
                      onClick={() => onTogglePin(f)}
                      className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                        isPinned
                          ? "bg-accent/10 text-accent"
                          : "text-paddock-400 opacity-0 hover:bg-paddock-200/70 hover:text-paddock-700 focus:opacity-100 group-hover/file:opacity-100 dark:hover:bg-paddock-800"
                      }`}
                    >
                      <PinIcon width={12} height={12} />
                      {isPinned ? "Pinned" : "Pin"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
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
