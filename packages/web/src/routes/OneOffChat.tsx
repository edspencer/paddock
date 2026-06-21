import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { SCRATCH_SLUG, type Chat } from "../lib/types";
import { ChatPane } from "../components/ChatPane";
import { ChatIcon, PlusIcon } from "../components/icons";
import { relativeTime } from "../lib/format";

/**
 * One-off (scratch) chats — deliberately secondary to projects. Routed to the
 * server's scratch agent via the "scratch" slug. `/chat` is a fresh session;
 * `/chat/:sessionId` resumes one.
 */
export function OneOffChat() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [chats, setChats] = useState<Chat[]>([]);

  const refresh = useCallback(async () => {
    setChats(await api.listScratchChats().catch(() => []));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadHistory = useCallback((id: string) => api.scratchChatMessages(id), []);
  const onSessionEstablished = useCallback(
    (id: string) => {
      void refresh();
      // Reflect the real session id in the URL so a refresh resumes it.
      if (!sessionId) navigate(`/chat/${id}`, { replace: true });
    },
    [refresh, sessionId, navigate],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-paddock-200 px-6 py-4 dark:border-paddock-800">
        <div className="flex items-center gap-2">
          <ChatIcon width={16} height={16} className="text-paddock-400" />
          <h1 className="text-lg font-semibold tracking-tight">One-off chat</h1>
        </div>
        <p className="mt-1 text-sm text-paddock-500">
          A scratch conversation, not tied to a project. For anything you'll return to,
          create a project instead.
        </p>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Scratch session list */}
        <div className="flex w-60 shrink-0 flex-col border-r border-paddock-200 bg-white/40 dark:border-paddock-800 dark:bg-paddock-900/20">
          <div className="p-3">
            <button className="btn-ghost w-full" onClick={() => navigate("/chat")}>
              <PlusIcon width={15} height={15} />
              New one-off
            </button>
          </div>
          <div className="section-label mb-1">Recent</div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {chats.length === 0 && (
              <p className="px-2 py-2 text-sm text-paddock-500">No one-off chats yet.</p>
            )}
            {chats.map((c) => (
              <button
                key={c.sessionId}
                onClick={() => navigate(`/chat/${c.sessionId}`)}
                className={`mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  sessionId === c.sessionId
                    ? "bg-paddock-200/80 dark:bg-paddock-800"
                    : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
                }`}
              >
                <span className="w-full truncate font-medium">{c.name}</span>
                <span className="text-[11px] text-paddock-400">{relativeTime(c.updatedAt)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <ChatPane
            key={sessionId ?? "new"}
            projectSlug={SCRATCH_SLUG}
            initialSessionId={sessionId}
            loadHistory={loadHistory}
            onSessionEstablished={onSessionEstablished}
            emptyHint="A quick, throwaway chat. Nothing here is organized into a project."
            placeholder="Ask anything…"
          />
        </div>
      </div>
    </div>
  );
}
