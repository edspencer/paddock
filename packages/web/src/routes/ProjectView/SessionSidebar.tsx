import type { Dispatch, SetStateAction } from "react";
import type { Chat, ChatCompleteUsage, ChatUsage } from "../../lib/types";
import { ContextRing } from "../../components/ContextRing";
import { ProvenanceBadge } from "../../components/ProvenanceBadge";
import { PaneResizer, usePaneWidth } from "../../components/PaneResizer";
import { relativeTime, sessionUsageOf } from "../../lib/format";
import {
  ArchiveIcon,
  BranchIcon,
  ChatIcon,
  ChevronDownIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from "../../components/icons";

/**
 * The project's session-list column (extracted from ProjectView.tsx, issue #403):
 * the mobile drawer backdrop + the sidebar (search, new-chat, the current/pending
 * chat rows, and the collapsible Archived section). Every input is an already-
 * computed value or a stable callback owned by ProjectView — drilled here via one
 * wide props object. The lone WS subscription and `runningSessions` stay owned by
 * ProjectView (passed in) so the fleet-wide running set doesn't fragment.
 */
export function SessionSidebar({
  chatList,
  sessionsOpen,
  setSessionsOpen,
  chatSearch,
  setChatSearch,
  searching,
  newChat,
  view,
  activeSession,
  pendingChat,
  chats,
  fallbackChat,
  visibleChats,
  activeChats,
  archivedChats,
  activeTotal,
  archivedOpen,
  setArchivedOpen,
  openChat,
  unread,
  usageBySession,
  runningSessions,
  setForkingChat,
  renameChat,
  archiveChat,
  setDeletingChat,
  starChat,
}: {
  chatList: ReturnType<typeof usePaneWidth>;
  sessionsOpen: boolean;
  setSessionsOpen: Dispatch<SetStateAction<boolean>>;
  chatSearch: string;
  setChatSearch: Dispatch<SetStateAction<string>>;
  searching: boolean;
  newChat: () => void;
  view: "home" | "chat" | "files" | "changes" | "settings" | "history" | "triggers";
  activeSession: string | null;
  pendingChat: string | null;
  chats: Chat[];
  fallbackChat: Chat | null;
  visibleChats: Chat[];
  activeChats: Chat[];
  archivedChats: Chat[];
  activeTotal: number;
  archivedOpen: boolean;
  setArchivedOpen: Dispatch<SetStateAction<boolean>>;
  openChat: (sessionId: string) => void;
  unread: ReadonlySet<string>;
  usageBySession: Record<string, ChatUsage | ChatCompleteUsage>;
  runningSessions: ReadonlySet<string>;
  setForkingChat: Dispatch<SetStateAction<Chat | null>>;
  renameChat: (chat: Chat) => Promise<void>;
  archiveChat: (chat: Chat) => Promise<void>;
  setDeletingChat: Dispatch<SetStateAction<Chat | null>>;
  starChat: (chat: Chat) => Promise<void>;
}) {
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
              scheduled (a cron fired it), spawned (another chat created it), or
              hook (an event/webhook trigger fired it — reuses the hook origin).
              Human-origin chats show nothing, so the list stays quiet. */}
          <ProvenanceBadge provenance={c.provenance} hookName={c.trigger?.name} />
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
        {/* Star / pin (#373): rightmost action. When starred, always visible and
            gold (solid star); otherwise it behaves exactly like the archive
            button — hidden until row hover/focus. */}
        <button
          type="button"
          aria-label={`${c.starred ? "Unstar" : "Star"} chat ${c.name}`}
          aria-pressed={!!c.starred}
          title={c.starred ? "Unstar chat" : "Star chat — pin it to the top of the list"}
          onClick={(e) => {
            e.stopPropagation();
            void starChat(c);
          }}
          className={`flex h-6 w-6 items-center justify-center rounded-md transition focus:opacity-100 group-hover/chat:opacity-100 hover:bg-paddock-200 hover:text-amber-500 dark:hover:bg-paddock-700 dark:hover:text-amber-400 ${
            c.starred ? "text-amber-400 opacity-100" : "text-paddock-400 opacity-0"
          }`}
        >
          <StarIcon width={13} height={13} fill={c.starred ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
    );
  };

  return (
    <>
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
        style={chatList.style}
        className={`fixed inset-y-0 left-0 z-30 flex w-64 max-w-[80%] shrink-0 flex-col border-r border-paddock-200 bg-canvas shadow-2xl transition-transform duration-200 ease-out dark:border-paddock-800 dark:bg-paddock-900 lg:relative lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-white/40 lg:shadow-none dark:lg:bg-paddock-900/20 ${
          sessionsOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {chatList.isDesktop && (
          <PaneResizer
            spec={chatList.spec}
            width={chatList.width}
            onPreview={chatList.preview}
            onCommit={chatList.commit}
            onReset={chatList.reset}
            label="Resize chat list"
          />
        )}
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
    </>
  );
}
