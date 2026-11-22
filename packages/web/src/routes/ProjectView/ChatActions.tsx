import type { Chat } from "../../lib/types";
import { type ChatNode, subtreeIds } from "../../lib/chatTree";
import { Tooltip } from "../../components/Tooltip";
import {
  ArchiveIcon,
  BranchIcon,
  EnvelopeIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
} from "../../components/icons";

/** The 24px icon button every action shares — the size of the sidebar's. */
const ICON_BUTTON = "flex h-6 w-6 items-center justify-center rounded-md transition";

/**
 * The open chat's actions, rendered beside the composer's input box
 * (ChatPane's `composerActions` slot). They used to be the sidebar row's hover
 * strip; only Detach stayed on the row, because it is about the row's place in
 * the tree. Every handler is owned by ProjectView — this only renders buttons.
 */
export function ChatActions({
  chat,
  node,
  unread,
  onForkChat,
  setPromotingChat,
  renameChat,
  archiveChat,
  requestDeleteChat,
  toggleUnread,
  starChat,
}: {
  chat: Chat;
  /**
   * The chat's node in the forest the sidebar renders, which is what the
   * Shift-click subtree actions walk. Undefined when the sidebar shows the chat
   * without one (the #154 fallback row, or a search that filtered it out).
   */
  node?: ChatNode;
  unread: ReadonlySet<string>;
  /**
   * Open the fork-naming dialog for this chat (issue #279) — a whole-chat
   * fork, so no message uuid. The transcript rail opens the same dialog with
   * one (#451); neither path forks until the user has named it.
   */
  onForkChat: (chat: Chat) => void;
  /**
   * Open the "promote this chat into a new project" dialog (issue #20).
   * Undefined hides the action — it is only offered at the ROOT. Promoting a
   * chat that already belongs to a project would be a move between projects,
   * which is a different feature and not what this ever meant.
   */
  setPromotingChat?: (chat: Chat) => void;
  /** Opens the rename dialog for this chat; ProjectView owns the commit (#541). */
  renameChat: (chat: Chat) => void;
  /**
   * The three subtree-capable actions (#508). `sessionIds` is the set to apply
   * to — `[chat.sessionId]` on a plain click, the whole subtree on Shift-click.
   * This component owns the modifier + the tree walk (it has the ChatNode);
   * ProjectView owns the optimistic update and its rollback.
   */
  archiveChat: (chat: Chat, sessionIds: string[]) => Promise<void>;
  requestDeleteChat: (chat: Chat, sessionIds: string[]) => void;
  toggleUnread: (chat: Chat, sessionIds: string[]) => Promise<void>;
  starChat: (chat: Chat) => Promise<void>;
}) {
  const descendantCount = node?.descendantCount ?? 0;
  // The open chat is never in `unread` (useUnreadChats excludes it), so this
  // normally reads false and the button offers "Mark as unread".
  const isUnread = unread.has(chat.sessionId);

  // #508: Shift-click applies an action to this chat AND every descendant.
  // Only meaningful on a chat that HAS descendants, so a stray Shift on a leaf
  // behaves exactly like a plain click rather than silently doing something
  // else. The set comes from the rendered tree, so it always matches the count
  // the sidebar's pill and the tooltips just promised — including while a
  // search has narrowed the tree, where acting on chats the user can't see
  // would be worse than acting on fewer.
  const hasSubtree = !!node && descendantCount > 0;
  const targetIds = (e: { shiftKey: boolean }) =>
    hasSubtree && e.shiftKey ? subtreeIds(node) : [chat.sessionId];
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

  // Always visible here, unlike the hover-revealed strip they came from.
  // `contents`: the buttons are laid out by ChatPane's slot, which decides
  // where they sit relative to the input box and how they wrap.
  return (
    <div className="contents">
      <Tooltip content="Fork chat — branch a new chat from this one's context">
        <button
          type="button"
          aria-label={`Fork chat ${chat.name}`}
          onClick={() => onForkChat(chat)}
          className={`${ICON_BUTTON} text-fg-subtle hover:bg-surface-active hover:text-accent`}
        >
          <BranchIcon width={13} height={13} />
        </button>
      </Tooltip>
      {/* Promote into a new project (#20). Offered only at the root. */}
      {setPromotingChat && (
        <Tooltip content="Promote into a new project — give this chat a home of its own">
          <button
            type="button"
            aria-label={`Promote chat ${chat.name} into a project`}
            onClick={() => setPromotingChat(chat)}
            className={`${ICON_BUTTON} text-fg-subtle hover:bg-surface-active hover:text-accent`}
          >
            <PlusIcon width={13} height={13} />
          </button>
        </Tooltip>
      )}
      <Tooltip content="Rename chat">
        <button
          type="button"
          aria-label={`Rename chat ${chat.name}`}
          onClick={() => renameChat(chat)}
          className={`${ICON_BUTTON} text-fg-subtle hover:bg-surface-active hover:text-fg`}
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
          chat.archived ? "Unarchive chat" : "Archive chat — file it away without deleting",
          chat.archived ? `unarchive all ${subtreeTotal}` : `archive all ${subtreeTotal}`,
        )}
      >
        <button
          type="button"
          aria-label={aria(
            `${chat.archived ? "Unarchive" : "Archive"} chat ${chat.name}`,
            chat.archived ? `unarchive all ${subtreeTotal}` : `archive all ${subtreeTotal}`,
          )}
          onClick={(e) => void archiveChat(chat, targetIds(e))}
          className={`${ICON_BUTTON} hover:bg-surface-active hover:text-accent ${
            chat.archived ? "text-accent" : "text-fg-subtle"
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
          aria-label={aria(`Delete chat ${chat.name}`, `delete all ${subtreeTotal}`)}
          onClick={(e) => requestDeleteChat(chat, targetIds(e))}
          className={`${ICON_BUTTON} text-fg-subtle hover:bg-danger-soft hover:text-danger`}
        >
          <TrashIcon width={13} height={13} />
        </button>
      </Tooltip>
      {/* Mark read / unread (#458): toggle the chat's unread state. Mirrors the
          email "mark as unread" pattern so a chat you glanced at can resurface
          its cue later. Label + icon flip with `isUnread` (the same derived
          state that drives the sidebar's accent dot). Subtree-capable (#508) —
          "I've dealt with this whole fan-out" is the case it exists for. */}
      <Tooltip
        content={tip(
          isUnread ? "Mark as read" : "Mark as unread — resurface it later",
          isUnread ? `mark all ${subtreeTotal} read` : `mark all ${subtreeTotal} unread`,
        )}
      >
        <button
          type="button"
          aria-label={aria(
            `Mark chat ${chat.name} ${isUnread ? "read" : "unread"}`,
            isUnread ? `mark all ${subtreeTotal} read` : `mark all ${subtreeTotal} unread`,
          )}
          aria-pressed={isUnread}
          onClick={(e) => void toggleUnread(chat, targetIds(e))}
          className={`${ICON_BUTTON} text-fg-subtle hover:bg-surface-active hover:text-accent`}
        >
          <EnvelopeIcon width={13} height={13} open={!isUnread} />
        </button>
      </Tooltip>
      {/* Star / pin (#373): gold with a solid star while starred. */}
      <Tooltip
        content={chat.starred ? "Unstar chat" : "Star chat — pin it to the top of the list"}
      >
        <button
          type="button"
          aria-label={`${chat.starred ? "Unstar" : "Star"} chat ${chat.name}`}
          aria-pressed={!!chat.starred}
          onClick={() => void starChat(chat)}
          className={`${ICON_BUTTON} hover:bg-surface-active hover:text-warn ${
            chat.starred ? "text-warn" : "text-fg-subtle"
          }`}
        >
          <StarIcon width={13} height={13} fill={chat.starred ? "currentColor" : "none"} />
        </button>
      </Tooltip>
    </div>
  );
}
