import type { Dispatch, SetStateAction } from "react";
import type { Chat, ChatCompleteUsage, ChatUsage } from "../../lib/types";
import type { ProjectViewTab } from "./urls";
import { type ChatNode, countNodes, flattenTree, subtreeIds } from "../../lib/chatTree";
import { ContextRing } from "../../components/ContextRing";
import { ProvenanceBadge } from "../../components/ProvenanceBadge";
import { PaneResizer, usePaneWidth } from "../../components/PaneResizer";
import { Tooltip } from "../../components/Tooltip";
import { relativeTime, sessionUsageOf } from "../../lib/format";
import { ChatCountBadge } from "./ChatCountBadge";
import { ChatNestingToggle } from "./ChatNestingToggle";
import type { ChatViewPrefs } from "./useChatViewPrefs";
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
  TerminalIcon,
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
  runningCount,
  viewPrefs,
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
  adoptableCount,
  adopting,
  adoptChats,
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
  /** Chats in this project with a live turn — the split badge's right half. */
  runningCount: number;
  viewPrefs: ChatViewPrefs;
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
   * Undefined hides the action — it is only offered at the ROOT. Promoting a
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
  /**
   * How many native Claude Code CLI chats this workspace could adopt (#588) —
   * the sessions the user ran in a terminal against the same working directory.
   *
   * A LIVE count, re-read after every adoption, not a "have they dismissed it yet?"
   * flag: `0` hides the button because there is genuinely nothing left to take, so
   * it comes back on its own once the user accrues more terminal history. That is
   * the whole reason this is a number rather than a boolean.
   */
  adoptableCount: number;
  /** True while an adoption is in flight — the button says so and refuses clicks. */
  adopting: boolean;
  /**
   * Open the adoption confirmation dialog (#660).
   *
   * This used to adopt everything on the spot, justified by adoption being
   * copy-only. Copy-only means it cannot destroy anything — it does not mean the
   * user wanted 26 unrecognised chats in their sidebar, with no undo. The click
   * now opens a dialog that shows what would come in and where from.
   */
  adoptChats: () => void;
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
          ? "bg-surface-selected"
          : "hover:bg-surface-hover"
      }`}
    >
      {/* One guide line per ancestor level: indentation you can actually trace
          back to the parent, which plain padding doesn't give you once a family
          runs past a screenful. Depth is capped so a long chain can't squeeze the
          title out of a narrow sidebar — past the cap, rows stop indenting but
          stay in their parent's subtree. */}
      {/* The guides are drawn in the `lineage` hue rather than the neutral edge,
          because that is precisely what they are: derivation made visible. It is
          the same ink the register uses for a spawn hop and the transcript uses
          for a fork, so one colour means one thing everywhere in the app. The
          innermost guide — the one that leads to THIS row's own parent — is the
          strong step; the ancestors behind it fade back, so a deep chain reads
          as depth rather than as a barcode. */}
      {Array.from({ length: Math.min(depth, MAX_INDENT_LEVELS) }, (_, i: number) => (
        <div
          key={i}
          aria-hidden="true"
          className={`w-3 shrink-0 border-l ${
            i === Math.min(depth, MAX_INDENT_LEVELS) - 1
              ? "border-lineage-edge"
              : "border-lineage-edge/40"
          }`}
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
                className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle transition hover:bg-surface-active hover:text-fg"
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
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-solid"
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
              <span className="shrink-0 rounded-full bg-surface-active px-1.5 text-3xs font-medium leading-4 text-fg-muted">
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
        <span className="chat-row-time text-2xs text-fg-subtle">
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
              className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-surface-active hover:text-accent focus:opacity-100 group-hover/chat:opacity-100"
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
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-surface-active hover:text-accent focus:opacity-100 group-hover/chat:opacity-100"
          >
            <BranchIcon width={13} height={13} />
          </button>
        </Tooltip>
        {/* Promote into a new project (#20). Offered only at the root. */}
        {setPromotingChat && (
          <Tooltip content="Promote into a new project — give this chat a home of its own">
            <button
              type="button"
              aria-label={`Promote chat ${c.name} into a project`}
              onClick={(e) => {
                e.stopPropagation();
                setPromotingChat(c);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-surface-active hover:text-accent focus:opacity-100 group-hover/chat:opacity-100"
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
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-surface-active hover:text-fg focus:opacity-100 group-hover/chat:opacity-100"
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
            className={`flex h-6 w-6 items-center justify-center rounded-md transition focus:opacity-100 group-hover/chat:opacity-100 hover:bg-surface-active hover:text-accent ${
              c.archived ? "text-accent opacity-100" : "text-fg-subtle opacity-0"
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
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-danger-soft hover:text-danger focus:opacity-100 group-hover/chat:opacity-100"
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
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-surface-active hover:text-accent focus:opacity-100 group-hover/chat:opacity-100"
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
            className={`flex h-6 w-6 items-center justify-center rounded-md transition focus:opacity-100 group-hover/chat:opacity-100 hover:bg-surface-active hover:text-warn ${
              c.starred ? "text-warn opacity-100" : "text-fg-subtle opacity-0"
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
          className="fixed inset-0 z-20 bg-overlay lg:hidden"
          aria-hidden="true"
          onClick={() => setSessionsOpen(false)}
        />
      )}
      {/* Session list — static column on lg+, off-canvas drawer on mobile. */}
      <div
        style={chatList.style}
        className={`fixed inset-y-0 left-0 z-30 flex w-64 max-w-[80%] shrink-0 flex-col border-r border-edge bg-surface-raised shadow-2xl transition-transform duration-200 ease-out lg:relative lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-surface-raised/40 lg:shadow-none ${
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
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              type="text"
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              // Short placeholder, full accessible name: the toolbar now carries
              // three controls, and at the default 256px sidebar "Search chats"
              // renders clipped mid-word.
              placeholder="Search"
              aria-label="Search chats"
              className={`input py-1.5 pl-8 ${searching ? "pr-8" : "pr-2"}`}
            />
            {searching && (
              <Tooltip content="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2">
                <button
                  type="button"
                  onClick={() => setChatSearch("")}
                  aria-label="Clear search"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-active hover:text-fg"
                >
                  <XIcon width={13} height={13} />
                </button>
              </Tooltip>
            )}
          </div>
          <ChatNestingToggle
            nested={viewPrefs.nested}
            setNested={viewPrefs.setNested}
            runningOnly={viewPrefs.runningOnly}
          />
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
          {/* Adopt native CLI chats (#588). A full-width row of its own ABOVE the
              "Chats" header rather than a fourth icon in the toolbar: it is a
              one-off migration affordance that needs a readable count in its
              label, and the toolbar is already three controls wide at a 256px
              sidebar. Sitting above the header also puts it directly over the list
              it is about to fill.

              Rendered only while the count is non-zero, and the count is re-read
              after every adoption — so this disappears because there is nothing left
              to adopt, and reappears by itself if the user later runs more
              terminal sessions. There is deliberately no dismiss state.

              It OPENS A DIALOG rather than adopting (#660). The no-dismiss
              design is right only while the count is trustworthy, and it has not
              been: this button has offered Paddock's own sweeper output (#658)
              and another instance's chats (#659). A permanent, one-click,
              irreversible action is the wrong shape for something a user may not
              recognise — so the click now asks. */}
          {adoptableCount > 0 && (
            <div className="px-2 pb-2">
              <button
                type="button"
                onClick={adoptChats}
                disabled={adopting}
                // The accessible name still leads with the visible label's own
                // words ("Adopt N native chat…") — a name that said "Review"
                // while the button read "Adopt" would break label-in-name for
                // anyone driving this by voice. That it opens a dialog rather
                // than acting immediately is carried by `aria-haspopup`, which
                // is what that attribute is for.
                aria-label={`Adopt ${adoptableCount} native Claude Code chat${adoptableCount === 1 ? "" : "s"} into this workspace`}
                aria-haspopup="dialog"
                className="btn-ghost w-full justify-start py-1.5 text-xs"
              >
                <TerminalIcon width={13} height={13} className="shrink-0" />
                <span className="truncate">
                  {adopting
                    ? "Adopting…"
                    : `Adopt ${adoptableCount} native chat${adoptableCount === 1 ? "" : "s"}…`}
                </span>
              </button>
            </div>
          )}
          <div className="mb-1 flex items-center justify-between pr-3">
            <span className="section-label">Chats</span>
            {/* Also rendered while the running filter is ON with nothing left to
                show — the badge is the way back out, so it must not vanish
                along with the rows it was filtering. */}
            {(activeTotal > 0 || viewPrefs.runningOnly) && (
              <ChatCountBadge
                activeTotal={activeTotal}
                shownCount={activeCount}
                searching={searching}
                runningCount={runningCount}
                runningOnly={viewPrefs.runningOnly}
                setRunningOnly={viewPrefs.setRunningOnly}
              />
            )}
          </div>
          {/* Current (non-archived) chats. When the Archived section is expanded
              this pane takes the top ~50% and scrolls independently (#95). */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {/* A fresh new chat with nothing sent yet (no session id at all). */}
            {activeSession === null && view === "chat" && !pendingChat && (
              <div className="mb-0.5 flex items-center gap-1.5 rounded-lg bg-surface-selected px-2.5 py-2 text-sm">
                <ChatIcon width={13} height={13} className="text-fg-muted" />
                <span className="font-medium italic text-fg-muted">
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
                    ? "bg-surface-selected"
                    : "hover:bg-surface-hover"
                }`}
              >
                <button
                  onClick={() => openChat(pendingChat)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-sm"
                >
                  <span className="min-w-0 flex-1 truncate font-medium italic text-fg-muted">
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
              <p className="px-2 py-2 text-sm text-fg-muted">
                No saved chats yet. Send a message to start one.
              </p>
            )}
            {/* The running filter is sticky and global, so you can switch to a
                project where nothing is running and meet an empty sidebar with
                no clue why. This says why, and offers the way out — without it,
                a stuck filter is indistinguishable from a broken chat list.
                Shown whenever the filter is on and nothing is running, even if
                the pinned open chat keeps a row on screen. */}
            {chats.length > 0 && viewPrefs.runningOnly && runningCount === 0 && (
              <p className="px-2 py-2 text-sm text-fg-muted">
                No chats are running.{" "}
                <button
                  type="button"
                  onClick={() => viewPrefs.setRunningOnly(false)}
                  className="text-accent underline underline-offset-2 hover:no-underline"
                >
                  Show all chats
                </button>
              </p>
            )}
            {chats.length > 0 &&
              (!viewPrefs.runningOnly || runningCount > 0) &&
              searching &&
              visibleChats.length === 0 &&
              !fallbackChat && (
                <p className="px-2 py-2 text-sm text-fg-muted">
                  No chats match “{chatSearch.trim()}”.
                </p>
              )}
            {chats.length > 0 &&
              !viewPrefs.runningOnly &&
              !searching &&
              activeChats.length === 0 &&
              !fallbackChat && (
                <p className="px-2 py-2 text-sm text-fg-muted">
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
              className={`flex flex-col border-t border-edge ${
                archivedOpen ? "min-h-0 flex-1" : "shrink-0"
              }`}
            >
              <button
                type="button"
                onClick={() => setArchivedOpen((o) => !o)}
                aria-expanded={archivedOpen}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium eyebrow text-fg-muted transition-colors hover:bg-surface-hover"
              >
                <ChevronDownIcon
                  width={14}
                  height={14}
                  className={`shrink-0 transition-transform ${archivedOpen ? "" : "-rotate-90"}`}
                />
                <span>Archived</span>
                <span className="ml-auto rounded-full bg-surface-active px-1.5 py-0.5 text-3xs font-semibold normal-case text-fg-muted">
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
