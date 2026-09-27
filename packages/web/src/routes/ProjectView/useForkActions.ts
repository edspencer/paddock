import { useCallback, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { api } from "../../lib/api";
import { writeForkParent } from "../../lib/forkLineage";
import type { Chat } from "../../lib/types";
import { chatMessageUrl } from "./urls";

/**
 * Forking (the sidebar's whole-chat fork and the transcript rail's
 * fork-from-here, #279/#451), revert-to-message (#451), and the per-message
 * deep link. Lifted out of `ProjectView` verbatim (#919).
 */
export function useForkActions({
  slug,
  base,
  activeSession,
  chats,
  navigate,
  refreshChats,
  setLoadErr,
}: {
  slug: string;
  /** `""` at the root, `/projects/:slug` otherwise (#516). */
  base: string;
  activeSession: string | null;
  chats: Chat[];
  navigate: NavigateFunction;
  refreshChats: () => Promise<void>;
  setLoadErr: (msg: string | null) => void;
}) {
  // Single-flight guard for fork-from-message so a double-click can't mint two
  // forks (#451 QA). ProjectView outlives chat navigation, so it's a ref, not state.
  const forkingRef = useRef(false);
  /**
   * The fork awaiting a name in the naming dialog (issue #279); null when the
   * dialog is closed. BOTH fork paths land here: the sidebar's per-chat button
   * (the whole chat, no `fromUuid`) and the transcript's per-message rail
   * (#451), which carries the anchor message's uuid so the copy is cut at that
   * turn. Forking from a specific message is a deliberate split, and the name is
   * where the reason for it gets recorded — so it asks, exactly as the sidebar
   * does, instead of minting `Fork of <chat>` behind the user's back.
   *
   * The uuid rides INSIDE this state rather than in a state of its own, because
   * it is the one thing distinguishing the two paths and its loss is invisible:
   * a dropped uuid still forks, still takes the typed name, still navigates — it
   * just silently copies the ENTIRE transcript instead of stopping where the
   * user pointed. One object means a stale rail uuid can never leak into a later
   * sidebar fork.
   */
  const [forkRequest, setForkRequest] = useState<{ chat: Chat; fromUuid?: string } | null>(null);
  /**
   * Perform the fork the user has now named: duplicate the chat server-side into
   * a NEW session in the same project, then jump straight to it. The fork exists
   * immediately — a real, resumable chat with the parent's history visible. The
   * name is collected up front by the ForkChatModal (issue #279); we record the
   * lineage locally for the composer back-link and pass `justForked` so the pane
   * focuses the composer to continue.
   *
   * `fromUuid` (issue #451) is what makes this the whole chat or a branch: given
   * one, the server copies only the PREFIX up to that message. It is threaded
   * through explicitly and never defaulted — see `forkRequest`.
   */
  const commitFork = useCallback(
    async (chat: Chat, name: string, fromUuid?: string) => {
      // Guard against a double-submit minting two forks (#451 QA): ignore a
      // second invocation while one is already in flight. Navigation unmounts
      // the pane on success but NOT this route, hence the explicit release.
      if (forkingRef.current) return;
      forkingRef.current = true;
      let newId: string;
      try {
        newId = await api.forkChat(slug, chat.sessionId, name, fromUuid);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : "Failed to fork chat");
        forkingRef.current = false;
        return;
      }
      writeForkParent(newId, { sessionId: chat.sessionId, name: chat.name });
      await refreshChats();
      navigate(`${base}/chat/${encodeURIComponent(newId)}`, {
        state: { justForked: true },
      });
      // ProjectView stays mounted across chat navigation, so clear the guard for
      // the next (deliberate) fork.
      forkingRef.current = false;
    },
    [navigate, base, slug, refreshChats],
  );
  /** Ask for a name before forking a whole chat (the sidebar's fork button). */
  const requestFork = useCallback((chat: Chat) => setForkRequest({ chat }), []);
  /**
   * Ask for a name before forking the active chat at `uuid` (the transcript's
   * per-message rail, issue #451). Same dialog, same default, one extra field.
   *
   * The synthesized fallback covers the open chat transiently dropping out of
   * the list (#154): the rail is rendered by the pane, not the sidebar, so it
   * stays clickable then — and a dialog titled after a chat we cannot name beats
   * a button that does nothing.
   */
  const requestForkFromMessage = useCallback(
    (uuid: string) => {
      if (!activeSession) return;
      const source = chats.find((c) => c.sessionId === activeSession) ?? {
        sessionId: activeSession,
        workingDirectory: "",
        name: "Current chat",
        updatedAt: "",
        resumable: true,
      };
      setForkRequest({ chat: source, fromUuid: uuid });
    },
    [activeSession, chats],
  );
  // Revert the active chat back to an earlier message (issue #451): truncate in
  // place (same session id); the pane reloads its own shorter transcript once
  // this resolves. Rethrow so the pane surfaces the failure and skips its reload.
  const revertToMessage = useCallback(
    async (uuid: string) => {
      if (!activeSession) return;
      try {
        await api.revertChat(slug, activeSession, uuid);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : "Failed to revert chat");
        throw e;
      }
      await refreshChats();
    },
    [activeSession, slug, refreshChats],
  );
  // --- message deep links -----------------------------------------------------
  // Absolute, so what lands on the clipboard is shareable rather than a path only
  // this tab can resolve (see chatMessageUrl for the fragment's shape).
  const messageLink = useCallback(
    (uuid: string) =>
      activeSession
        ? `${window.location.origin}${chatMessageUrl(base, activeSession, uuid)}`
        : window.location.href,
    [base, activeSession],
  );

  return {
    forkRequest,
    setForkRequest,
    commitFork,
    requestFork,
    requestForkFromMessage,
    revertToMessage,
    messageLink,
  };
}
