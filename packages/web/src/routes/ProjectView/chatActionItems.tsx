import type { ReactNode } from "react";
import type { Chat } from "../../lib/types";
import { type ChatNode, subtreeIds } from "../../lib/chatTree";
import type { useChatActions } from "./useChatActions";
import {
  ArchiveIcon,
  BranchIcon,
  EnvelopeIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
  UnlinkIcon,
} from "../../components/icons";

/*
 * The one definition of a chat's actions. `chatActionItems` returns the ordered
 * list of actions that apply to a chat, with their copy, state and handlers
 * already resolved; a surface only decides how to draw an item. Every surface
 * renders this list, so an action cannot be present on one and missing from
 * another. The sidebar row once held a hand-written copy of these buttons, and
 * Detach was left out of it when the buttons moved to the composer.
 */

/** One action as any surface renders it. */
export interface ChatActionItem {
  id: "fork" | "promote" | "rename" | "archive" | "delete" | "unread" | "star" | "detach";
  icon: ReactNode;
  tooltip: ReactNode;
  ariaLabel: string;
  /** Colour classes for the item's tone and state; the surface supplies size and shape. */
  className: string;
  /** `aria-pressed` for the toggles (read/unread, star); undefined on the rest. */
  pressed?: boolean;
  /** Runs the action. `shiftKey` selects the subtree on the subtree-capable ones (#508). */
  onActivate: (e: { shiftKey: boolean }) => void;
}

type ChatActionHandlers = ReturnType<typeof useChatActions>;

/** Everything the actions need from the route that owns them (ProjectView). */
export interface ChatActionContext
  extends Pick<
    ChatActionHandlers,
    "archiveChat" | "requestDeleteChat" | "toggleUnread" | "starChat" | "detachChat"
  > {
  unread: ReadonlySet<string>;
  /**
   * Open the fork-naming dialog for this chat (issue #279) — a whole-chat
   * fork, so no message uuid. The transcript rail opens the same dialog with
   * one (#451); neither path forks until the user has named it.
   */
  requestFork: (chat: Chat) => void;
  /**
   * Open the "promote this chat into a new project" dialog (issue #20).
   * Undefined hides the action — it is only offered at the ROOT. Promoting a
   * chat that already belongs to a project would be a move between projects,
   * which is a different feature and not what this ever meant.
   */
  setPromotingChat?: (chat: Chat) => void;
  /** Opens the rename dialog for this chat; ProjectView owns the commit (#541). */
  setRenamingChat: (chat: Chat) => void;
}

const ICON = { width: 13, height: 13 };
const QUIET = "text-fg-subtle hover:bg-surface-active";

/**
 * The actions that apply to `chat`, in display order.
 *
 * `node` is the chat's node in the forest the sidebar renders, which is what the
 * Shift-click subtree actions walk. Undefined when the sidebar shows the chat
 * without one (the #154 fallback row, or a search that filtered it out).
 *
 * The three subtree-capable actions (#508) are handed the ids to apply to —
 * `[chat.sessionId]` on a plain click, the whole subtree on Shift-click. This
 * function owns the modifier + the tree walk (it has the ChatNode); ProjectView
 * owns the optimistic update and its rollback.
 */
export function chatActionItems(
  chat: Chat,
  node: ChatNode | undefined,
  ctx: ChatActionContext,
): ChatActionItem[] {
  const descendantCount = node?.descendantCount ?? 0;
  // The open chat is never in `unread` (useUnreadChats excludes it), so this
  // normally reads false and the button offers "Mark as unread".
  const isUnread = ctx.unread.has(chat.sessionId);

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

  const items: ChatActionItem[] = [
    {
      id: "fork",
      icon: <BranchIcon {...ICON} />,
      tooltip: "Fork chat — branch a new chat from this one's context",
      ariaLabel: `Fork chat ${chat.name}`,
      className: `${QUIET} hover:text-accent`,
      onActivate: () => ctx.requestFork(chat),
    },
  ];
  // Promote into a new project (#20). Offered only at the root.
  const { setPromotingChat } = ctx;
  if (setPromotingChat) {
    items.push({
      id: "promote",
      icon: <PlusIcon {...ICON} />,
      tooltip: "Promote into a new project — give this chat a home of its own",
      ariaLabel: `Promote chat ${chat.name} into a project`,
      className: `${QUIET} hover:text-accent`,
      onActivate: () => setPromotingChat(chat),
    });
  }
  const archivePhrase = `${chat.archived ? "unarchive" : "archive"} all ${subtreeTotal}`;
  const unreadPhrase = `mark all ${subtreeTotal} ${isUnread ? "read" : "unread"}`;
  items.push(
    {
      id: "rename",
      icon: <PencilIcon {...ICON} />,
      tooltip: "Rename chat",
      ariaLabel: `Rename chat ${chat.name}`,
      className: `${QUIET} hover:text-fg`,
      onActivate: () => ctx.setRenamingChat(chat),
    },
    // Archive (#95) — subtree-capable (#508). Archiving a parent alone leaves its
    // children behind in the active list (they lose their parent from that
    // population and `buildChatTree` promotes them to roots), so Shift-click is
    // the "take the whole family with it" option. Reversible, so no confirmation
    // — but the tooltip says what it's about to do, which matters most when the
    // parent is COLLAPSED and the chats being archived aren't on screen.
    {
      id: "archive",
      icon: <ArchiveIcon {...ICON} />,
      tooltip: tip(
        chat.archived ? "Unarchive chat" : "Archive chat — file it away without deleting",
        archivePhrase,
      ),
      ariaLabel: aria(
        `${chat.archived ? "Unarchive" : "Archive"} chat ${chat.name}`,
        archivePhrase,
      ),
      className: `hover:bg-surface-active hover:text-accent ${
        chat.archived ? "text-accent" : "text-fg-subtle"
      }`,
      onActivate: (e) => void ctx.archiveChat(chat, targetIds(e)),
    },
    // Delete — subtree-capable (#508) and the one action with no undo, so both
    // variants go through the count-aware confirm dialog.
    {
      id: "delete",
      icon: <TrashIcon {...ICON} />,
      tooltip: tip("Delete chat", `delete all ${subtreeTotal}`),
      ariaLabel: aria(`Delete chat ${chat.name}`, `delete all ${subtreeTotal}`),
      className: "text-fg-subtle hover:bg-danger-soft hover:text-danger",
      onActivate: (e) => ctx.requestDeleteChat(chat, targetIds(e)),
    },
    // Mark read / unread (#458): toggle the chat's unread state. Mirrors the
    // email "mark as unread" pattern so a chat you glanced at can resurface its
    // cue later. Label + icon flip with `isUnread` (the same derived state that
    // drives the sidebar's accent dot). Subtree-capable (#508) — "I've dealt
    // with this whole fan-out" is the case it exists for.
    {
      id: "unread",
      icon: <EnvelopeIcon {...ICON} open={!isUnread} />,
      tooltip: tip(
        isUnread ? "Mark as read" : "Mark as unread — resurface it later",
        unreadPhrase,
      ),
      ariaLabel: aria(`Mark chat ${chat.name} ${isUnread ? "read" : "unread"}`, unreadPhrase),
      className: `${QUIET} hover:text-accent`,
      pressed: isUnread,
      onActivate: (e) => void ctx.toggleUnread(chat, targetIds(e)),
    },
    // Star / pin (#373): gold with a solid star while starred.
    {
      id: "star",
      icon: <StarIcon {...ICON} fill={chat.starred ? "currentColor" : "none"} />,
      tooltip: chat.starred ? "Unstar chat" : "Star chat — pin it to the top of the list",
      ariaLabel: `${chat.starred ? "Unstar" : "Star"} chat ${chat.name}`,
      className: `hover:bg-surface-active hover:text-warn ${
        chat.starred ? "text-warn" : "text-fg-subtle"
      }`,
      pressed: !!chat.starred,
      onActivate: () => void ctx.starChat(chat),
    },
  );
  // Detach from parent (#508) — only when the chat RENDERS nested in the
  // sidebar's forest, so the button never appears where it would be a no-op.
  // The whole subtree travels with it: the chat becomes a root and keeps its own
  // descendants, rather than scattering grandchildren. Last, because it is the
  // one action that comes and goes between chats of the same project; at the
  // end it never moves the buttons before it.
  if (node && node.depth > 0) {
    items.push({
      id: "detach",
      icon: <UnlinkIcon {...ICON} />,
      tooltip:
        descendantCount > 0
          ? `Detach from parent — move this chat and its ${descendantCount} nested chat${
              descendantCount === 1 ? "" : "s"
            } to the top level`
          : "Detach from parent — move this chat to the top level",
      ariaLabel: `Detach chat ${chat.name} from its parent`,
      className: `${QUIET} hover:text-accent`,
      onActivate: () => void ctx.detachChat(chat),
    });
  }
  return items;
}
