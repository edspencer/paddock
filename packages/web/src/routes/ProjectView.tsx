import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useProjects } from "../lib/projects-context";
import type { Chat, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { ChatPane } from "../components/ChatPane";
import { Markdown } from "../components/Markdown";
import { FileView } from "../components/FileView";
import { ProjectMenu } from "../components/ProjectMenu";
import { EditProjectModal } from "../components/EditProjectModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  ChatIcon,
  CheckIcon,
  ClockIcon,
  FileIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "../components/icons";
import { relativeTime } from "../lib/format";
import { clearLastTab, toSubPath, writeLastTab } from "../lib/lastTab";

/**
 * The active view ("chat" or "files") and the selected chat/file are derived
 * from the URL via the route's params, NOT local state. This makes every tab,
 * chat, and file deep-linkable + restorable on reload, and keeps the tab bar
 * highlighting correct on a direct load. Routes that mount this component:
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
  // client-side navigation (the presence of `/files` distinguishes the tab).
  const view: "chat" | "files" = location.pathname.startsWith(`/projects/${slug}/files`)
    ? "files"
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
  const [changelog, setChangelog] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingChat, setDeletingChat] = useState<Chat | null>(null);

  // The active chat session is the URL's sessionId (null = a fresh "new chat").
  const activeSession = routeSessionId ?? null;

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
  }, [slug]);

  useEffect(() => {
    setProject(null);
    void load();
  }, [slug, load]);

  // Sticky last tab: persist the current in-project sub-path for this project
  // whenever the URL (view / session / file) changes, so the bare
  // `/projects/:slug` redirect can restore exactly where the user left off.
  useEffect(() => {
    const sub =
      view === "chat"
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
  }, [slug]);

  const loadHistory = useCallback(
    (sessionId: string) => api.projectChatMessages(slug, sessionId),
    [slug],
  );

  // --- URL-driven navigation (all tab/chat/file clicks change the route) -----
  const goChat = useCallback(() => navigate(`/projects/${slug}/chat`), [navigate, slug]);
  const goFiles = useCallback(() => navigate(`/projects/${slug}/files`), [navigate, slug]);
  const newChat = goChat;
  const openChat = useCallback(
    (sessionId: string) =>
      navigate(`/projects/${slug}/chat/${encodeURIComponent(sessionId)}`),
    [navigate, slug],
  );
  const openFile = useCallback(
    (name: string) => navigate(`/projects/${slug}/files/${encodeURIComponent(name)}`),
    [navigate, slug],
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
      {/* Header */}
      <header className="border-b border-paddock-200 px-6 py-4 dark:border-paddock-800">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          <StatusPill status={project.status} />
          {project.domain.map((d) => (
            <span key={d} className="tag">
              {d}
            </span>
          ))}
          {project.hasOverview && (
            <span
              title="A sweep has curated an OVERVIEW.md for this project. New chats can preload it as context."
              className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
            >
              <CheckIcon width={11} height={11} />
              Overview
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-paddock-400">
            <ClockIcon width={12} height={12} />
            updated {relativeTime(project.updated)}
          </span>
          <ProjectMenu
            onEdit={() => setEditOpen(true)}
            onDelete={() => setDeleteOpen(true)}
            size={18}
          />
        </div>
        {project.summary && (
          <p className="mt-1.5 text-sm text-paddock-600 dark:text-paddock-400">{project.summary}</p>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Session list */}
        <div className="flex w-64 shrink-0 flex-col border-r border-paddock-200 bg-white/40 dark:border-paddock-800 dark:bg-paddock-900/20">
          <div className="p-3">
            <button className="btn-primary w-full" onClick={newChat}>
              <PlusIcon width={15} height={15} />
              New Chat
            </button>
          </div>
          <div className="mb-1 flex items-center justify-between pr-3">
            <span className="section-label">Chats</span>
            {chats.length > 0 && (
              <span className="text-[11px] text-paddock-400">{chats.length}</span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {/* The pending new chat, shown while it has no session id yet. */}
            {activeSession === null && view === "chat" && (
              <div className="mb-0.5 flex items-center gap-1.5 rounded-lg bg-paddock-200/80 px-2.5 py-2 text-sm dark:bg-paddock-800">
                <ChatIcon width={13} height={13} className="text-paddock-500" />
                <span className="font-medium italic text-paddock-600 dark:text-paddock-300">
                  New chat…
                </span>
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
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 pr-14 text-left text-sm"
                >
                  <span className="w-full truncate font-medium">{c.name}</span>
                  <span className="text-[11px] text-paddock-400">{relativeTime(c.updatedAt)}</span>
                </button>
                <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
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
          <div className="flex items-center gap-1 overflow-x-auto border-b border-paddock-200 px-4 dark:border-paddock-800">
            <TabButton active={view === "chat"} onClick={goChat}>
              Chat
            </TabButton>
            <TabButton active={filesTabActive} onClick={goFiles}>
              Files &amp; Changelog
            </TabButton>
            {/* Pinned file tabs (sibling tabs), order preserved by the server.
                Each links to /files/:name so the tab is deep-linkable. */}
            {pinned.map((f) => (
              <PinnedTab
                key={f}
                file={f}
                active={activePinnedFile === f}
                onSelect={() => openFile(f)}
                onUnpin={() => void unpinTab(f)}
              />
            ))}
          </div>

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
              onTurnComplete={onTurnComplete}
              preloadAvailable={project.hasOverview}
              isProjectChat
            />
          )}
          {/* Files tab with no file selected -> the files list + changelog. */}
          {view === "files" && !viewingFile && (
            <FilesList
              project={project}
              changelog={changelog}
              files={files}
              onOpenFile={openFile}
              onTogglePin={togglePin}
            />
          )}
          {/* Any /files/:name (pinned or not) -> the single file reader. The
              same component renders regardless of pinned state, so pinning the
              file you're viewing only changes which tab is highlighted. */}
          {view === "files" && viewingFile && (
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

/** The Files & Changelog list (files index + summary + CHANGELOG). */
function FilesList({
  project,
  changelog,
  files,
  onOpenFile,
  onTogglePin,
}: {
  project: Project;
  changelog: string;
  files: string[];
  onOpenFile: (name: string) => void;
  onTogglePin: (file: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <section className="mb-8">
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

        <section className="mb-8">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-paddock-500">
            Summary
          </h3>
          <div className="card">
            {project.summary ? (
              <p className="text-sm text-paddock-700 dark:text-paddock-300">{project.summary}</p>
            ) : (
              <p className="text-sm italic text-paddock-400">No summary set.</p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-3">
              <Meta label="Status" value={project.status} />
              <Meta label="Visibility" value={project.visibility} />
              <Meta label="Started" value={project.started} />
              <Meta label="Updated" value={project.updated} />
              {project.domain.length > 0 && (
                <Meta label="Domains" value={project.domain.join(", ")} />
              )}
            </dl>
          </div>
        </section>

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
