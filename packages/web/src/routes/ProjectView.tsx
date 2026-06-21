import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  PinIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "../components/icons";
import { relativeTime } from "../lib/format";

/** Built-in tabs are "chat" / "files"; a pinned file tab is `file:<name>`. */
type Tab = "chat" | "files" | `file:${string}`;

export function ProjectView() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const { refresh: refreshProjects, upsert, remove } = useProjects();

  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [changelog, setChangelog] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingChat, setDeletingChat] = useState<Chat | null>(null);

  // null = a fresh "new chat"; a sessionId = a resumed chat.
  const [activeSession, setActiveSession] = useState<string | null>(null);
  // Bumping this remounts ChatPane to reset its transcript on switch.
  const [chatKey, setChatKey] = useState(0);
  const [tab, setTab] = useState<Tab>("chat");
  // The file open in the Files tab's reader (null = the file list).
  const [openFile, setOpenFile] = useState<string | null>(null);

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
    setActiveSession(null);
    setTab("chat");
    setOpenFile(null);
    setChatKey((k) => k + 1);
    void load();
  }, [slug, load]);

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

  const newChat = () => {
    setActiveSession(null);
    setTab("chat");
    setChatKey((k) => k + 1);
  };

  const openChat = (sessionId: string) => {
    setActiveSession(sessionId);
    setTab("chat");
    setChatKey((k) => k + 1);
  };

  const onSessionEstablished = useCallback(() => {
    void refreshChats();
    void refreshProjects();
  }, [refreshChats, refreshProjects]);

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
      // If the unpinned tab was active, fall back to Files.
      setTab((t) => (t === `file:${file}` ? "files" : t));
    },
    [slug, upsert],
  );

  const confirmDeleteChat = useCallback(async () => {
    if (!deletingChat) return;
    const id = deletingChat.sessionId;
    await api.deleteProjectChat(slug, id);
    setChats((prev) => prev.filter((c) => c.sessionId !== id));
    // If the deleted chat is open, drop back to a fresh "new chat".
    if (activeSession === id) {
      setActiveSession(null);
      setChatKey((k) => k + 1);
    }
    setDeletingChat(null);
  }, [deletingChat, slug, activeSession]);

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
  // The file currently shown by the active pinned tab, if any.
  const activePinnedFile = tab.startsWith("file:") ? tab.slice("file:".length) : null;

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
            {activeSession === null && tab === "chat" && (
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
                  activeSession === c.sessionId && tab === "chat"
                    ? "bg-paddock-200/80 dark:bg-paddock-800"
                    : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
                }`}
              >
                <button
                  onClick={() => openChat(c.sessionId)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 pr-8 text-left text-sm"
                >
                  <span className="w-full truncate font-medium">{c.name}</span>
                  <span className="text-[11px] text-paddock-400">{relativeTime(c.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete chat ${c.name}`}
                  title="Delete chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingChat(c);
                  }}
                  className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-rose-100 hover:text-rose-600 focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                >
                  <TrashIcon width={13} height={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Main: tabs + content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 overflow-x-auto border-b border-paddock-200 px-4 dark:border-paddock-800">
            <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
              Chat
            </TabButton>
            <TabButton active={tab === "files"} onClick={() => setTab("files")}>
              Files &amp; Changelog
            </TabButton>
            {/* Pinned file tabs (sibling tabs), order preserved by the server. */}
            {pinned.map((f) => (
              <PinnedTab
                key={f}
                file={f}
                active={tab === `file:${f}`}
                onSelect={() => setTab(`file:${f}`)}
                onUnpin={() => void unpinTab(f)}
              />
            ))}
          </div>

          {tab === "chat" && (
            <ChatPane
              key={chatKey}
              projectSlug={project.slug}
              initialSessionId={activeSession ?? undefined}
              loadHistory={loadHistory}
              onSessionEstablished={onSessionEstablished}
              onTurnComplete={onTurnComplete}
              preloadAvailable={project.hasOverview}
              isProjectChat
            />
          )}
          {tab === "files" && (
            <FilesTab
              project={project}
              changelog={changelog}
              files={files}
              openFile={openFile}
              onOpenFile={setOpenFile}
              onTogglePin={togglePin}
            />
          )}
          {activePinnedFile && (
            <div className="flex-1 overflow-y-auto">
              <FileView slug={project.slug} name={activePinnedFile} />
            </div>
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

function FilesTab({
  project,
  changelog,
  files,
  openFile,
  onOpenFile,
  onTogglePin,
}: {
  project: Project;
  changelog: string;
  files: string[];
  openFile: string | null;
  onOpenFile: (name: string | null) => void;
  onTogglePin: (file: string) => void;
}) {
  // When a file is open, show the reader with a back link.
  if (openFile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-paddock-200 px-4 py-2 dark:border-paddock-800">
          <button
            onClick={() => onOpenFile(null)}
            className="btn-subtle -ml-2 py-1.5 text-xs"
          >
            ← Files
          </button>
          <span className="font-mono text-sm text-paddock-700 dark:text-paddock-300">
            {openFile}
          </span>
          <button
            onClick={() => onTogglePin(openFile)}
            className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              project.pinned.includes(openFile)
                ? "bg-accent/10 text-accent"
                : "text-paddock-500 hover:bg-paddock-200/60 dark:hover:bg-paddock-800/60"
            }`}
            title={project.pinned.includes(openFile) ? "Unpin (remove tab)" : "Pin as a tab"}
          >
            <PinIcon width={13} height={13} />
            {project.pinned.includes(openFile) ? "Pinned" : "Pin as tab"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileView slug={project.slug} name={openFile} />
        </div>
      </div>
    );
  }

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
