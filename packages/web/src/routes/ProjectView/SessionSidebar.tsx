import type { Dispatch, SetStateAction } from "react";
import type { Chat, ChatCompleteUsage, ChatUsage } from "../../lib/types";
import type { ProjectViewTab } from "./urls";
import { type ChatNode, countNodes, flattenTree, subtreeIds } from "../../lib/chatTree";
import { ContextRing } from "../../components/ContextRing";
import { ProvenanceBadge } from "../../components/ProvenanceBadge";
import { PaneResizer, usePaneWidth } from "../../components/PaneResizer";
import { Tooltip } from "../../components/Tooltip";
import { relativeTime, sessionUsageOf } from "../../lib/format";
import {
  ArchiveIcon,
  BranchIcon,
  ChatIcon,
  ChevronDownIcon,
  EnvelopeIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
  UnlinkIcon,
  XIcon,
} from "../../components/icons";

/** "1 nested chat" / "3 nested chats" — used by both tooltips and aria labels. */
function nested(n: number): string {
  return `${n} nested chat${n === 1 ? "" : "s"}`;
}

/**
 * How many levels of the chat tree get their own indent + guide line. Deeper
 * chats still nest correctly (and collapse with their ancestors), they just stop
 * moving right — a 264px sidebar runs out of title room around here.
 */
const MAX_INDENT_LEVELS = 4;

/** Stable empty set, so the search path doesn't allocate one per render. */
const EMPTY_COLLAPSED: ReadonlySet<string> = new Set();

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
  collapsedChats,
  toggleChatCollapsed,
  openChat,
  unread,
  usageBySession,
  runningSessions,
  setForkingChat,
  setPromotingChat,
  renameChat,
  archiveChat,
  requestDeleteChat,
  starChat,
  toggleUnread,
  detachChat,
}: {
  chatList: ReturnType<typeof usePaneWidth>;
  sessionsOpen: boolean;
  setSessionsOpen: Dispatch<SetStateAction<boolean>>;
  chatSearch: string;
  setChatSearch: Dispatch<SetStateAction<string>>;
  searching: boolean;
  newChat: () => void;
  view: ProjectViewTab;
  activeSession: string | null;
  pendingChat: string | null;
  chats: Chat[];
  fallbackChat: Chat | null;
  visibleChats: Chat[];
  activeChats: ChatNode[];
  archivedChats: ChatNode[];
  activeTotal: number;
  archivedOpen: boolean;
  setArchivedOpen: Dispatch<SetStateAction<boolean>>;
  collapsedChats: ReadonlySet<string>;
  toggleChatCollapsed: (sessionId: string) => void;
  openChat: (sessionId: string) => void;
  unread: ReadonlySet<string>;
  usageBySession: Record<string, ChatUsage | ChatCompleteUsage>;
  runningSessions: ReadonlySet<string>;
  setForkingChat: Dispatch<SetStateAction<Chat | null>>;
  /**
   * Open the "promote this chat into a new project" dialog (issue #20).
   * Undefined hides the action — it is only offered at the ROOT, where the
   * chats that used to be scratch one-offs now live (#516 Phase 6). Promoting a
   * chat that already belongs to a project would be a move between projects,
   * which is a different feature and not what this ever meant.
   */
  setPromotingChat?: Dispatch<SetStateAction<Chat | null>>;
  /** Opens the rename dialog for this chat; ProjectView owns the commit (#541). */
  renameChat: (chat: Chat) => void;
  /**
   * The three subtree-capable actions (#508). `sessionIds` is the set to apply
   * to — `[chat.sessionId]` on a plain click, the whole subtree on Shift-click.
   * The sidebar owns the modifier + the tree walk (it has the ChatNode);
   * ProjectView owns the optimistic update and its rollback.
   */
  archiveChat: (chat: Chat, sessionIds: string[]) => Promise<void>;
  requestDeleteChat: (chat: Chat, sessionIds: string[]) => void;
  toggleUnread: (chat: Chat, sessionIds: string[]) => Promise<void>;
  starChat: (chat: Chat) => Promise<void>;
  /** Promote a nested chat (with its own subtree) to the top level (#508). */
  detachChat: (chat: Chat) => Promise<void>;
}) {
  // While searching, ignore the collapsed set. A query filters to matches and
  // their ancestors, so honouring collapse would let a folded-up parent hide the
  // very chat the user just searched for — it would render as a parent row with a
  // count pill and no visible hit. Collapse state is preserved, not cleared: it
  // returns as soon as the query does.
  const effectiveCollapsed = searching ? EMPTY_COLLAPSED : collapsedChats;

  // Does this project use nesting at all? When nothing has children, rows keep
  // their original flush-left alignment instead of every one reserving an empty
  // twisty gutter. A project that DOES nest reserves it on every row, so sibling
  // titles line up whether or not a given chat has children of its own.
  const anyNesting =
    activeChats.some((n) => n.children.length > 0) ||
    archivedChats.some((n) => n.children.length > 0);

  // Both sidebar counts are CHAT counts, so they walk the whole forest instead of
  // reading `.length` off the roots array (#491). `activeCount` is the numerator
  // of the "N/total" search badge, whose denominator `activeTotal` is a flat
  // unfiltered chat count — pairing it with a roots-only numerator read `1/40`
  // for a search that matched five chats sitting under one parent.
  const activeCount = countNodes(activeChats);
  const archivedCount = countNodes(archivedChats);

  // One chat row — used by both the current list and the Archived section, so
  // the two stay identical (context ring, hover-menu actions) apart from where
  // they live. The Archive action toggles label/icon between the two states.
  //
  // `node` is the chat's place in the tree: a chat created by another chat
  // renders indented beneath it, and the node is what the Shift-click subtree
  // actions walk. `pendingChat` and the #154 fallback row pass none — they're
  // always roots with no children.
  const chatRow = (c: Chat, node?: ChatNode) => {
    const depth = node?.depth ?? 0;
    const childCount = node?.children.length ?? 0;
    const descendantCount = node?.descendantCount ?? 0;
    const isUnread = unread.has(c.sessionId);
    // Read the EFFECTIVE set so the twisty and the count pill agree with what's
    // actually on screen — during a search a collapsed parent renders expanded,
    // and a chevron still pointing right would be lying about it.
    const isCollapsed = effectiveCollapsed.has(c.sessionId);

    // #508: Shift-click applies an action to this chat AND every descendant.
    // Only meaningful on a row that HAS descendants, so a stray Shift on a leaf
    // behaves exactly like a plain click rather than silently doing something
    // else. The set comes from the rendered tree, so it always matches the count
    // the pill and the tooltips just promised — including while a search has
    // narrowed the tree, where acting on chats the user can't see would be worse
    // than acting on fewer.
    const hasSubtree = !!node && descendantCount > 0;
    const targetIds = (e: { shiftKey: boolean }) =>
      hasSubtree && e.shiftKey ? subtreeIds(node) : [c.sessionId];
    /** Total chats a Shift-click would hit — the chat plus its descendants. */
    const subtreeTotal = descendantCount + 1;
    /**
     * Tooltip copy + the matching aria-label suffix. Shift-click is invisible
     * otherwise, and it is also reachable from the keyboard (a browser sets
     * `shiftKey` on the click it synthesises from Enter/Space), so the hint
     * belongs in BOTH — the bubble is pointer-only.
     *
     * `phrase` is the COMPLETED action ("archive all 21"), not a bare verb: the
     * count sits mid-phrase for read/unread ("mark all 21 read"), so a
     * `${verb} all ${n}` template only reads correctly for half the actions.
     */
    const tip = (label: string, phrase: string) =>
      hasSubtree ? (
        <>
          {label} · <span className="font-semibold">Shift-click</span> to {phrase}
        </>
      ) : (
        label
      );
    const aria = (label: string, phrase: string) =>
      hasSubtree ? `${label} (Shift-click to ${phrase})` : label;

    // How many icons this row's hover strip holds: six always (fork, rename,
    // archive, delete, read/unread, star), plus detach on a nested row and
    // promote at the root. The strip is absolutely positioned OVER the
    // timestamp, so `.chat-row--actions-N` tells the stylesheet how narrow the
    // row has to get before it would cover it — see `.chat-row` in index.css.
    // Interpolated rather than switched because these are hand-written classes,
    // not Tailwind utilities, so there is no JIT scan to satisfy; the value is
    // always 6, 7 or 8.
    const actionCount = 6 + (depth > 0 ? 1 : 0) + (setPromotingChat ? 1 : 0);

    return (
    <div
      key={c.sessionId}
      className={`group/chat chat-row chat-row--actions-${actionCount} relative mb-0.5 flex rounded-lg transition-colors ${
        activeSession === c.sessionId && view === "chat"
          ? "bg-paddock-200/80 dark:bg-paddock-800"
          : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
      }`}
    >
      {/* One guide line per ancestor level: indentation you can actually trace
          back to the parent, which plain padding doesn't give you once a family
          runs past a screenful. Depth is capped so a long chain can't squeeze the
          title out of a narrow sidebar — past the cap, rows stop indenting but
          stay in their parent's subtree. */}
      {Array.from({ length: Math.min(depth, MAX_INDENT_LEVELS) }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="w-3 shrink-0 border-l border-paddock-300/60 dark:border-paddock-700/60"
        />
      ))}
      {/* Twisty gutter. A separate control from the row button (a button can't
          nest inside a button) so collapsing a fan-out never opens the chat. */}
      {anyNesting && (
        <div className="flex w-4 shrink-0 items-start justify-center pt-2.5">
          {childCount > 0 && (
            <Tooltip content={isCollapsed ? `Show ${nested(descendantCount)}` : "Hide nested chats"}>
              <button
                type="button"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${descendantCount} chat${descendantCount === 1 ? "" : "s"} under ${c.name}`}
                aria-expanded={!isCollapsed}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleChatCollapsed(c.sessionId);
                }}
                className="flex h-4 w-4 items-center justify-center rounded text-paddock-400 transition hover:bg-paddock-300/60 hover:text-paddock-700 dark:hover:bg-paddock-700 dark:hover:text-paddock-100"
              >
                <ChevronDownIcon
                  width={11}
                  height={11}
                  className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                />
              </button>
            </Tooltip>
          )}
        </div>
      )}
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
        className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg py-2 pr-2.5 text-left text-sm ${anyNesting ? "pl-1" : "pl-2.5"}`}
      >
        {/* Row 1: title + the context/progress ring (spins while streaming). */}
        <span className="flex w-full items-center gap-1.5">
          {/* Unread cue (#160): a small accent dot + slightly bolder name when
              the agent finished a turn the user hasn't seen. Subtle by design;
              never shown for the currently-open chat (excluded in `unread`). */}
          {isUnread && (
            <Tooltip content="New reply you haven't read yet" className="shrink-0">
              <span
                data-unread="true"
                aria-label="Unread reply"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
              />
            </Tooltip>
          )}
          <span
            className={`min-w-0 flex-1 truncate ${isUnread ? "font-semibold" : "font-medium"}`}
          >
            {c.name}
          </span>
          {/* How many chats are folded away under this one. Only while collapsed —
              expanded, the indented rows say it better than a number can. */}
          {isCollapsed && descendantCount > 0 && (
            <Tooltip content={`${nested(descendantCount)} hidden`} className="shrink-0">
              <span className="shrink-0 rounded-full bg-paddock-300/70 px-1.5 text-[10px] font-medium leading-4 text-paddock-600 dark:bg-paddock-700 dark:text-paddock-300">
                {descendantCount}
              </span>
            </Tooltip>
          )}
          {/* Provenance badge (#267): flags the "ran without me" chats —
              scheduled (a cron fired it), spawned (another chat created it), or
              hook (an event/webhook trigger fired it — reuses the hook origin).
              Human-origin chats show nothing, so the list stays quiet.

              A nested row suppresses the `spawned` badge: sitting under its
              parent already says another chat created it, and more loudly than
              the chip did. Kept for a spawned chat rendered at the root (parent
              in another project, or filtered out), where nothing else says it. */}
          {!(depth > 0 && c.provenance?.origin === "spawned") && (
            <ProvenanceBadge provenance={c.provenance} hookName={c.trigger?.name} />
          )}
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
        <span className="chat-row-time text-[11px] text-paddock-400">
          {relativeTime(c.updatedAt)}
        </span>
      </button>
      <div className="absolute bottom-1 right-1.5 flex items-center gap-0.5">
        {/* Detach from parent (#508) — only on a row that actually RENDERS
            nested, so the button never appears where it would look like a no-op.
            The whole subtree travels with it: the chat becomes a root and keeps
            its own descendants, rather than scattering grandchildren. */}
        {depth > 0 && (
          <Tooltip
            content={
              descendantCount > 0
                ? `Detach from parent — move this chat and its ${nested(descendantCount)} to the top level`
                : "Detach from parent — move this chat to the top level"
            }
          >
            <button
              type="button"
              aria-label={`Detach chat ${c.name} from its parent`}
              onClick={(e) => {
                e.stopPropagation();
                void detachChat(c);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-paddock-200 hover:text-accent focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-paddock-700 dark:hover:text-accent"
            >
              <UnlinkIcon width={13} height={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="Fork chat — branch a new chat from this one's context">
          <button
            type="button"
            aria-label={`Fork chat ${c.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setForkingChat(c);
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-paddock-200 hover:text-accent focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-paddock-700 dark:hover:text-accent"
          >
            <BranchIcon width={13} height={13} />
          </button>
        </Tooltip>
        {/* Promote into a new project (#20). Offered only at the root, where the
            chats that used to be scratch one-offs now live (#516 Phase 6). */}
        {setPromotingChat && (
          <Tooltip content="Promote into a new project — give this chat a home of its own">
            <button
              type="button"
              aria-label={`Promote chat ${c.name} into a project`}
              onClick={(e) => {
                e.stopPropagation();
                setPromotingChat(c);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-paddock-200 hover:text-accent focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-paddock-700 dark:hover:text-accent"
            >
              <PlusIcon width={13} height={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="Rename chat">
          <button
            type="button"
            aria-label={`Rename chat ${c.name}`}
            onClick={(e) => {
              e.stopPropagation();
              renameChat(c);
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-paddock-200 hover:text-paddock-700 focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-paddock-700 dark:hover:text-paddock-100"
          >
            <PencilIcon width={13} height={13} />
          </button>
        </Tooltip>
        {/* Archive (#95) — subtree-capable (#508). Archiving a parent alone
            leaves its children behind in the active list (they lose their parent
            from that population and `buildChatTree` promotes them to roots), so
            Shift-click is the "take the whole family with it" option. Reversible,
            so no confirmation — but the tooltip says what it's about to do,
            which matters most when the parent is COLLAPSED and the chats being
            archived aren't on screen. */}
        <Tooltip
          content={tip(
            c.archived ? "Unarchive chat" : "Archive chat — file it away without deleting",
            c.archived ? `unarchive all ${subtreeTotal}` : `archive all ${subtreeTotal}`,
          )}
        >
          <button
            type="button"
            aria-label={aria(
              `${c.archived ? "Unarchive" : "Archive"} chat ${c.name}`,
              c.archived ? `unarchive all ${subtreeTotal}` : `archive all ${subtreeTotal}`,
            )}
            onClick={(e) => {
              e.stopPropagation();
              void archiveChat(c, targetIds(e));
            }}
            className={`flex h-6 w-6 items-center justify-center rounded-md transition focus:opacity-100 group-hover/chat:opacity-100 hover:bg-paddock-200 hover:text-accent dark:hover:bg-paddock-700 dark:hover:text-accent ${
              c.archived ? "text-accent opacity-100" : "text-paddock-400 opacity-0"
            }`}
          >
            <ArchiveIcon width={13} height={13} />
          </button>
        </Tooltip>
        {/* Delete — subtree-capable (#508) and the one action with no undo, so
            both variants go through the count-aware confirm dialog. */}
        <Tooltip content={tip("Delete chat", `delete all ${subtreeTotal}`)}>
          <button
            type="button"
            aria-label={aria(`Delete chat ${c.name}`, `delete all ${subtreeTotal}`)}
            onClick={(e) => {
              e.stopPropagation();
              requestDeleteChat(c, targetIds(e));
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-rose-100 hover:text-rose-600 focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
          >
            <TrashIcon width={13} height={13} />
          </button>
        </Tooltip>
        {/* Mark read / unread (#458): toggle the chat's unread state. Mirrors the
            email "mark as unread" pattern so a chat you glanced at can resurface
            its cue later. Label + icon flip with `isUnread` (the same derived
            state that drives the accent dot); hover-revealed like the other
            actions. Subtree-capable (#508) — "I've dealt with this whole fan-out"
            is the case it exists for. */}
        <Tooltip
          content={tip(
            isUnread ? "Mark as read" : "Mark as unread — resurface it later",
            isUnread ? `mark all ${subtreeTotal} read` : `mark all ${subtreeTotal} unread`,
          )}
        >
          <button
            type="button"
            aria-label={aria(
              `Mark chat ${c.name} ${isUnread ? "read" : "unread"}`,
              isUnread ? `mark all ${subtreeTotal} read` : `mark all ${subtreeTotal} unread`,
            )}
            aria-pressed={isUnread}
            onClick={(e) => {
              e.stopPropagation();
              void toggleUnread(c, targetIds(e));
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 opacity-0 transition hover:bg-paddock-200 hover:text-accent focus:opacity-100 group-hover/chat:opacity-100 dark:hover:bg-paddock-700 dark:hover:text-accent"
          >
            <EnvelopeIcon width={13} height={13} open={!isUnread} />
          </button>
        </Tooltip>
        {/* Star / pin (#373): rightmost action. When starred, always visible and
            gold (solid star); otherwise it behaves exactly like the archive
            button — hidden until row hover/focus. */}
        <Tooltip
          content={c.starred ? "Unstar chat" : "Star chat — pin it to the top of the list"}
        >
          <button
            type="button"
            aria-label={`${c.starred ? "Unstar" : "Star"} chat ${c.name}`}
            aria-pressed={!!c.starred}
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
        </Tooltip>
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
              <Tooltip content="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2">
                <button
                  type="button"
                  onClick={() => setChatSearch("")}
                  aria-label="Clear search"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-paddock-400 transition hover:bg-paddock-200 hover:text-paddock-700 dark:hover:bg-paddock-700 dark:hover:text-paddock-100"
                >
                  <XIcon width={13} height={13} />
                </button>
              </Tooltip>
            )}
          </div>
          <Tooltip content="New chat">
            <button
              type="button"
              className="btn-primary h-9 w-9 shrink-0 p-0"
              onClick={newChat}
              aria-label="New Chat"
            >
              <PlusIcon width={16} height={16} />
            </button>
          </Tooltip>
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
                {searching ? `${activeCount}/${activeTotal}` : activeTotal}
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
            {flattenTree(activeChats, effectiveCollapsed).map((n) => chatRow(n.chat, n))}
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
                  {archivedCount}
                </span>
              </button>
              {archivedOpen && (
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                  {flattenTree(archivedChats, effectiveCollapsed).map((n) => chatRow(n.chat, n))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
