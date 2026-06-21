import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useProjects } from "../lib/projects-context";
import type { Chat, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { ChatPane } from "../components/ChatPane";
import { Markdown } from "../components/Markdown";
import { ProjectMenu } from "../components/ProjectMenu";
import { EditProjectModal } from "../components/EditProjectModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ChatIcon, ClockIcon, PlusIcon, TrashIcon } from "../components/icons";
import { relativeTime } from "../lib/format";

type Tab = "chat" | "files";

export function ProjectView() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const { refresh: refreshProjects, upsert, remove } = useProjects();

  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [changelog, setChangelog] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingChat, setDeletingChat] = useState<Chat | null>(null);

  // null = a fresh "new chat"; a sessionId = a resumed chat.
  const [activeSession, setActiveSession] = useState<string | null>(null);
  // Bumping this remounts ChatPane to reset its transcript on switch.
  const [chatKey, setChatKey] = useState(0);
  const [tab, setTab] = useState<Tab>("chat");

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const detail = await api.getProjectDetail(slug);
      setProject(detail.project);
      setChats(detail.chats);
      setChangelog(detail.changelog);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Failed to load project");
    }
  }, [slug]);

  useEffect(() => {
    setProject(null);
    setActiveSession(null);
    setTab("chat");
    setChatKey((k) => k + 1);
    void load();
  }, [slug, load]);

  // Refresh just the chat list (e.g. after a new session is established).
  const refreshChats = useCallback(async () => {
    const list = await api.listProjectChats(slug).catch(() => null);
    if (list) setChats(list);
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
            {activeSession === null && (
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
                  activeSession === c.sessionId
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
          <div className="flex gap-1 border-b border-paddock-200 px-4 dark:border-paddock-800">
            <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
              Chat
            </TabButton>
            <TabButton active={tab === "files"} onClick={() => setTab("files")}>
              Files &amp; Changelog
            </TabButton>
          </div>

          {tab === "chat" ? (
            <ChatPane
              key={chatKey}
              projectSlug={project.slug}
              initialSessionId={activeSession ?? undefined}
              loadHistory={loadHistory}
              onSessionEstablished={onSessionEstablished}
            />
          ) : (
            <FilesTab project={project} changelog={changelog} />
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

function FilesTab({ project, changelog }: { project: Project; changelog: string }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
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
      className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-accent text-ink dark:text-ink-dark"
          : "border-transparent text-paddock-500 hover:text-paddock-700 dark:hover:text-paddock-300"
      }`}
    >
      {children}
    </button>
  );
}
