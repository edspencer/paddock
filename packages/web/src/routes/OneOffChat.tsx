import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useProjects } from "../lib/projects-context";
import { SCRATCH_SLUG, type Chat } from "../lib/types";
import { ChatPane } from "../components/ChatPane";
import { ContextRing } from "../components/ContextRing";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PromoteChatModal } from "../components/PromoteChatModal";
import { ChatIcon, FolderIcon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "../components/icons";
import { relativeTime, sessionUsageOf } from "../lib/format";

/**
 * One-off (scratch) chats — deliberately secondary to projects. Routed to the
 * server's scratch agent via the "scratch" slug. `/chat` is a fresh session;
 * `/chat/:sessionId` resumes one.
 */
export function OneOffChat() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { upsert } = useProjects();
  const [chats, setChats] = useState<Chat[]>([]);
  const [deletingChat, setDeletingChat] = useState<Chat | null>(null);
  const [promoting, setPromoting] = useState(false);
  // Mobile: the Recent list is an off-canvas drawer (static column on lg+).
  const [recentOpen, setRecentOpen] = useState(false);
  const currentChat = chats.find((c) => c.sessionId === sessionId);

  // Close the Recent drawer whenever the open chat changes (new / switched).
  useEffect(() => {
    setRecentOpen(false);
  }, [sessionId]);

  // Stable ChatPane mount key (same pattern as ProjectView): keep the pane
  // across the new->established transition (we mirror the id into /chat/:id with
  // state.established) so the live transcript doesn't flash, but reset it on a
  // real switch (New one-off / clicking a saved scratch chat).
  const paneKeyRef = useRef({ counter: 0, session: sessionId ?? null });
  if (paneKeyRef.current.session !== (sessionId ?? null)) {
    const established = (location.state as { established?: boolean } | null)?.established;
    if (!established) paneKeyRef.current.counter += 1;
    paneKeyRef.current.session = sessionId ?? null;
  }
  const chatPaneKey = paneKeyRef.current.counter;

  const refresh = useCallback(async () => {
    setChats(await api.listScratchChats().catch(() => []));
  }, []);

  const confirmDeleteChat = useCallback(async () => {
    if (!deletingChat) return;
    const id = deletingChat.sessionId;
    await api.deleteScratchChat(id);
    setChats((prev) => prev.filter((c) => c.sessionId !== id));
    setDeletingChat(null);
    if (sessionId === id) navigate("/chat", { replace: true });
  }, [deletingChat, sessionId, navigate]);

  const renameChat = useCallback(async (chat: Chat) => {
    const next = window.prompt("Rename chat", chat.name);
    if (next === null) return; // cancelled
    const name = next.trim();
    await api.renameScratchChat(chat.sessionId, name || null);
    setChats((prev) =>
      prev.map((c) =>
        c.sessionId === chat.sessionId
          ? { ...c, name: name || c.preview || c.sessionId.slice(0, 8) }
          : c,
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadHistory = useCallback((id: string) => api.scratchChatMessages(id), []);
  const onSessionEstablished = useCallback(
    (id: string) => {
      void refresh();
      // Reflect the real session id in the URL so a refresh resumes it.
      if (!sessionId) navigate(`/chat/${id}`, { replace: true, state: { established: true } });
    },
    [refresh, sessionId, navigate],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-paddock-200 px-4 py-4 dark:border-paddock-800 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRecentOpen(true)}
                className="btn-subtle -ml-2 gap-1.5 px-2 py-1.5 lg:hidden"
                aria-label="Show recent chats"
              >
                <ChatIcon width={16} height={16} />
                Recent
              </button>
              <ChatIcon width={16} height={16} className="hidden text-paddock-400 lg:block" />
              <h1 className="text-lg font-semibold tracking-tight">One-off chat</h1>
            </div>
            <p className="mt-1 text-sm text-paddock-500">
              A scratch conversation, not tied to a project. For anything you'll return to,
              promote it to a project.
            </p>
          </div>
          {sessionId && (
            <button
              className="btn-ghost shrink-0"
              onClick={() => setPromoting(true)}
              title="Turn this chat into a project (keeps its history)"
            >
              <FolderIcon width={15} height={15} />
              Promote to project
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Recent backdrop (mobile only, when the drawer is open). */}
        {recentOpen && (
          <div
            className="fixed inset-0 z-20 bg-black/40 lg:hidden"
            aria-hidden="true"
            onClick={() => setRecentOpen(false)}
          />
        )}
        {/* Scratch session list — static column on lg+, off-canvas drawer on mobile. */}
        <div
          className={`fixed inset-y-0 left-0 z-30 flex w-60 max-w-[80%] shrink-0 flex-col border-r border-paddock-200 bg-canvas shadow-2xl transition-transform duration-200 ease-out dark:border-paddock-800 dark:bg-paddock-900 lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-white/40 lg:shadow-none dark:lg:bg-paddock-900/20 ${
            recentOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center gap-2 p-3">
            <button className="btn-ghost w-full" onClick={() => navigate("/chat")}>
              <PlusIcon width={15} height={15} />
              New one-off
            </button>
            <button
              type="button"
              onClick={() => setRecentOpen(false)}
              aria-label="Close recent chats"
              className="btn-subtle shrink-0 px-2 py-2 lg:hidden"
            >
              <XIcon width={16} height={16} />
            </button>
          </div>
          <div className="section-label mb-1">Recent</div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {chats.length === 0 && (
              <p className="px-2 py-2 text-sm text-paddock-500">No one-off chats yet.</p>
            )}
            {chats.map((c) => (
              <div
                key={c.sessionId}
                className={`group/chat relative mb-0.5 rounded-lg transition-colors ${
                  sessionId === c.sessionId
                    ? "bg-paddock-200/80 dark:bg-paddock-800"
                    : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
                }`}
              >
                <button
                  onClick={() => navigate(`/chat/${c.sessionId}`)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 pr-14 text-left text-sm"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <ContextRing
                      tokens={c.contextTokens}
                      limit={c.contextLimit}
                      usage={sessionUsageOf(c)}
                    />
                    <span className="truncate font-medium">{c.name}</span>
                  </span>
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

        <div className="min-w-0 flex-1">
          <ChatPane
            key={chatPaneKey}
            projectSlug={SCRATCH_SLUG}
            initialSessionId={sessionId}
            loadHistory={loadHistory}
            onSessionEstablished={onSessionEstablished}
            emptyHint="A quick, throwaway chat. Nothing here is organized into a project."
            placeholder="Ask anything…"
          />
        </div>
      </div>

      <ConfirmDialog
        open={deletingChat !== null}
        title="Delete chat?"
        message="This one-off chat's transcript will be permanently removed. This cannot be undone."
        confirmLabel="Delete chat"
        onConfirm={confirmDeleteChat}
        onClose={() => setDeletingChat(null)}
      />

      {sessionId && (
        <PromoteChatModal
          open={promoting}
          sessionId={sessionId}
          defaultName={currentChat?.name}
          onClose={() => setPromoting(false)}
          onPromoted={(project, promoted) => {
            upsert(project);
            setPromoting(false);
            navigate(
              promoted
                ? `/projects/${project.slug}/chat/${sessionId}`
                : `/projects/${project.slug}`,
            );
          }}
        />
      )}
    </div>
  );
}
