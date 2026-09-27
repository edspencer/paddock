import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import { api } from "../../lib/api";
import { forgetChats } from "../../lib/lastSeen";
import { descendantIds } from "../../lib/chatTree";
import type { Chat } from "../../lib/types";

/** What the chat row actions need from the route that owns the chat list. */
export interface ChatActionDeps {
  slug: string;
  /** `""` at the root, `/projects/:slug` otherwise (#516). */
  base: string;
  activeSession: string | null;
  navigate: NavigateFunction;
  chats: Chat[];
  setChats: Dispatch<SetStateAction<Chat[]>>;
  setLoadErr: (msg: string | null) => void;
  setArchivedOpen: (open: boolean) => void;
  unread: ReadonlySet<string>;
  markManySeen: (sessionIds: string[]) => void;
}

/**
 * The per-chat row actions — delete (count-aware, #508), rename (#541), archive
 * (#95), detach (#508), star (#373) and read/unread (#458) — plus the state of
 * the two dialogs that front them. Lifted out of `ProjectView` verbatim (#919):
 * each is an optimistic update on the route's chat list with a rollback, and
 * none of them touches anything else in the route.
 */
export function useChatActions({
  slug,
  base,
  activeSession,
  navigate,
  chats,
  setChats,
  setLoadErr,
  setArchivedOpen,
  unread,
  markManySeen,
}: ChatActionDeps) {
  // The chat awaiting a new name in the rename dialog (#541); null when closed.
  const [renamingChat, setRenamingChat] = useState<Chat | null>(null);
  /**
   * The chat delete awaiting confirmation. `ids` is what will actually be
   * removed — just the chat, or (on a Shift-click) the chat plus every
   * descendant. Carried alongside the chat so the dialog can COUNT what it's
   * about to destroy: shift-deleting a fan-out takes out chats that may not even
   * be on screen (the parent can be collapsed), and there is no undo.
   */
  const [deletingChat, setDeletingChat] = useState<{
    chat: Chat;
    ids: string[];
    /**
     * Nested chats that will SURVIVE the delete and be promoted to the top level
     * by it. Non-zero whenever the chat has descendants the action isn't taking:
     * a plain click on a parent (which never took them), or a Shift-click while a
     * search has narrowed the rendered tree to a couple of matching children.
     * The dialog says so — orphaning twenty chats is not something an
     * irreversible action should do without mentioning it.
     */
    orphanCount: number;
  } | null>(null);

  const confirmDeleteChat = useCallback(async () => {
    if (!deletingChat) return;
    const { ids } = deletingChat;
    // One chat keeps the plain route; a subtree goes through the batch route so a
    // failure partway can't leave half a family deleted with nothing to report.
    // Either way we only drop the ids the server says it actually REMOVED — a
    // chat that failed to delete stays in the list rather than silently vanishing
    // from the UI while its transcript is still on disk.
    let removed: string[];
    if (ids.length === 1) {
      await api.deleteProjectChat(slug, ids[0]);
      removed = ids;
    } else {
      const res = await api.deleteProjectChats(slug, ids);
      removed = res.removed;
      if (res.failed.length) {
        setLoadErr(
          `Deleted ${res.removed.length} of ${ids.length} chats — ${res.failed.length} could not be removed.`,
        );
      }
    }
    const gone = new Set(removed);
    // #732: retract these chats from every per-session-id cache in the tab —
    // read-state here, the sidebar badge's completion cache via the event. Only
    // the ids the server CONFIRMED removed, for the same reason the list filter
    // below uses them: a chat the delete spared still exists, and forgetting its
    // watermark would re-raise an unread cue on a chat we just said survived.
    forgetChats(removed);
    setChats((prev) => prev.filter((c) => !gone.has(c.sessionId)));
    // If the open chat was among them, drop back to a fresh "new chat". `base`
    // is "" at the root and `/projects/:slug` otherwise (#516).
    if (activeSession && gone.has(activeSession)) {
      navigate(`${base}/chat`, { replace: true });
    }
    setDeletingChat(null);
  }, [deletingChat, slug, base, activeSession, navigate]);

  /** Open the count-aware delete confirmation for a chat (or a whole subtree). */
  const requestDeleteChat = useCallback(
    (chat: Chat, ids: string[]) => {
      // Descendants are counted against the UNFILTERED list, narrowed to this
      // chat's own population (active or archived) because that's what the tree
      // nests at. Anything attached but not being deleted gets orphaned to the
      // root, and the dialog has to say so.
      const population = chats.filter((c) => !!c.archived === !!chat.archived);
      const taking = new Set(ids);
      const orphanCount = descendantIds(population, chat.sessionId).filter(
        (id) => !taking.has(id),
      ).length;
      setDeletingChat({ chat, ids, orphanCount });
    },
    [chats],
  );

  // Commit a rename from the modal. `name === null` is the deliberate "clear it"
  // case, which resets the chat to its generated preview name — the modal keeps
  // that distinct from cancelling, which never reaches here at all (#541).
  const commitRename = useCallback(
    async (chat: Chat, name: string | null) => {
      await api.renameProjectChat(slug, chat.sessionId, name);
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

  // Archive or unarchive a chat (#95): toggle the persisted flag and optimistically
  // move it between the current list and the Archived section. Non-destructive —
  // the transcript is untouched and the chat stays fully usable.
  // `sessionIds` is the set to apply to (#508): the chat alone on a plain click,
  // or the chat plus every descendant on a Shift-click. A subtree always lives in
  // ONE population — the tree is built per population, so an active chat's
  // descendants are all active too — which is why the rollback can restore every
  // id to the clicked chat's previous `archived` value rather than snapshotting
  // each one.
  const archiveChat = useCallback(
    async (chat: Chat, sessionIds: string[]) => {
      const next = !chat.archived;
      const ids = new Set(sessionIds);
      setChats((prev) => prev.map((c) => (ids.has(c.sessionId) ? { ...c, archived: next } : c)));
      // When archiving the last one out of an expanded section, keep it open so
      // the user sees where it went; opening/closing is otherwise user-driven.
      if (next) setArchivedOpen(true);
      try {
        if (sessionIds.length === 1) await api.archiveProjectChat(slug, sessionIds[0], next);
        else await api.archiveProjectChats(slug, sessionIds, next);
      } catch (e) {
        // Roll back the whole optimistic move on failure — one call, one undo.
        setChats((prev) =>
          prev.map((c) => (ids.has(c.sessionId) ? { ...c, archived: chat.archived } : c)),
        );
        setLoadErr(e instanceof Error ? e.message : "Failed to archive chat");
      }
    },
    [slug],
  );

  /**
   * Detach a chat from its parent (#508): promote it — with its own nested chats
   * — to the top level. Optimistically drop the local `parent` edge so the row
   * jumps out immediately; the server override is what makes it stick across a
   * reload (clearing an edge alone wouldn't: most edges are re-derived by
   * inference, see the detach route).
   */
  const detachChat = useCallback(
    async (chat: Chat) => {
      const parent = chat.parent;
      if (!parent) return;
      setChats((prev) =>
        prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, parent: undefined } : c)),
      );
      try {
        await api.detachProjectChat(slug, chat.sessionId, true);
      } catch (e) {
        setChats((prev) =>
          prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, parent } : c)),
        );
        setLoadErr(e instanceof Error ? e.message : "Failed to detach chat");
      }
    },
    [slug],
  );

  // Star or unstar a chat (#373): toggle the persisted flag and optimistically
  // re-pin it to the top of its population. Orthogonal to archiving — starring
  // never moves a chat between the active and Archived sections.
  const starChat = useCallback(
    async (chat: Chat) => {
      const next = !chat.starred;
      setChats((prev) =>
        prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, starred: next } : c)),
      );
      try {
        await api.starProjectChat(slug, chat.sessionId, next);
      } catch (e) {
        // Roll back the optimistic pin on failure.
        setChats((prev) =>
          prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, starred: chat.starred } : c)),
        );
        setLoadErr(e instanceof Error ? e.message : "Failed to star chat");
      }
    },
    [slug],
  );

  // Toggle a chat's read/unread state (#458) — the sixth chat action. If the chat
  // currently reads as unread (for ANY reason: manual flag, a live completion, or
  // a turn finished while away), mark it seen (clears the manual flag + advances
  // last-seen). Otherwise set the manual unread override so it resurfaces its cue
  // later ("look at it again in the morning"), optimistically with rollback.
  // `sessionIds` is the subtree set (#508); the CLICKED chat decides the
  // direction for the whole set, so a mixed family ends up uniformly read or
  // uniformly unread rather than each row flipping its own way.
  const toggleUnread = useCallback(
    async (chat: Chat, sessionIds: string[]) => {
      if (unread.has(chat.sessionId)) {
        markManySeen(sessionIds);
        return;
      }
      const ids = new Set(sessionIds);
      // Unlike archive, a subtree's manual-unread flags are NOT uniform, so the
      // rollback restores each chat's own prior value.
      const before = new Map(
        chats.filter((c) => ids.has(c.sessionId)).map((c) => [c.sessionId, c.unread]),
      );
      setChats((prev) => prev.map((c) => (ids.has(c.sessionId) ? { ...c, unread: true } : c)));
      try {
        if (sessionIds.length === 1) await api.markChatUnread(slug, sessionIds[0], true);
        else await api.markChatsUnread(slug, sessionIds, true);
      } catch (e) {
        // Roll back the optimistic flags on failure.
        setChats((prev) =>
          prev.map((c) =>
            ids.has(c.sessionId) ? { ...c, unread: before.get(c.sessionId) } : c,
          ),
        );
        setLoadErr(e instanceof Error ? e.message : "Failed to mark chat unread");
      }
    },
    [unread, markManySeen, slug, chats],
  );

  return {
    deletingChat,
    setDeletingChat,
    confirmDeleteChat,
    requestDeleteChat,
    renamingChat,
    setRenamingChat,
    commitRename,
    archiveChat,
    detachChat,
    starChat,
    toggleUnread,
  };
}
