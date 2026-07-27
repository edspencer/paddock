import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  readLastSeen,
  markSeenLocally,
  revertSeenLocally,
  setServerLastSeen,
} from "../../lib/lastSeen";
import type { Chat } from "../../lib/types";

/**
 * Unread affordance (#160), extracted from ProjectView.tsx (issue #403). A chat
 * is unread when the agent finished a turn while the user wasn't viewing it, or
 * the user MANUALLY flagged it unread (#458). Three signals combine:
 *  - `c.unread`: the per-user manual "mark unread" override (#458), server-backed;
 *  - `liveUnread`: chats flagged the instant a turn completed for a NON-focused
 *    chat this session (from the shared socket's running-set transitions);
 *  - server `lastTurnCompletedAt` newer than the server-backed last-seen time
 *    (`lib/lastSeen.ts`), which covers reload + turns that finished while away.
 * Marking a chat seen (open/focus, or its turn completing while focused) bumps
 * lastSeen=now, clears its live flag, and clears the manual override (via the
 * `onSeen` callback + the server's `/seen` route). `seenVersion` bumps on every
 * mark so the derivation recomputes.
 *
 * Owns `liveUnread`/`seenVersion` internally; the WS-owned `runningSessions` set
 * stays owned by ProjectView and is passed in (the fleet-wide running set must
 * not fragment). Returns `markSeen` (also called by the sidebar) and the derived
 * `unread` set. `onSeen` MUST be stable (a `useCallback`) — markSeen depends on
 * it, and the auto-mark-seen effect depends on markSeen.
 */
export function useUnreadChats({
  slug,
  chats,
  view,
  activeSession,
  runningSessions,
  onSeen,
}: {
  slug: string;
  chats: Chat[];
  view: string;
  activeSession: string | null;
  runningSessions: ReadonlySet<string>;
  onSeen?: (sessionId: string) => void;
}): { markSeen: (sessionId: string) => void; unread: ReadonlySet<string> } {
  const [liveUnread, setLiveUnread] = useState<ReadonlySet<string>>(new Set());
  const [seenVersion, setSeenVersion] = useState(0);
  const markSeen = useCallback(
    (sessionId: string) => {
      const when = Date.now();
      // Optimistic in-memory clear (+ same-tab event), then persist to the server
      // (#189), which is the sole source of truth (#488). The bump is session-
      // scoped, so a reload always re-derives from the server and devices can't
      // diverge; if the POST fails we roll it back so the cue honestly reappears
      // rather than silently sticking (the pre-#488 behaviour).
      const prev = markSeenLocally(sessionId, when);
      // The `/seen` route also clears any server-side manual unread override (#458);
      // `onSeen` mirrors that in the parent's chat state so the cue can't briefly
      // flicker back after leaving the chat, before the next list refetch.
      void api.markChatSeen(slug, sessionId, when).catch(() => {
        revertSeenLocally(sessionId, prev, when);
        setSeenVersion((v) => v + 1);
      });
      onSeen?.(sessionId);
      setLiveUnread((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setSeenVersion((v) => v + 1);
    },
    [slug, onSeen],
  );

  // Fold the server-backed read-state (#189) from each chat DTO into the shared
  // client cache whenever the list changes. This is what makes a chat opened on
  // ANOTHER device show as read here. The `seenVersion` bump is REQUIRED: the
  // cache is a plain module-level map, so folding into it doesn't invalidate the
  // derivation below on its own. Without it a freshly-loaded chat renders unread
  // until some other signal happened to recompute — visible as a cue that flashes
  // on load for chats the server already knows are seen.
  useEffect(() => {
    for (const c of chats) setServerLastSeen(c.sessionId, c.lastSeen);
    setSeenVersion((v) => v + 1);
  }, [chats]);

  // The set of unread chats, re-derived whenever the list, the focused chat, a
  // live completion, or a mark-seen changes. The currently-open chat is NEVER
  // unread. Otherwise a chat is unread if the user manually flagged it (#458), it
  // was live-flagged this session, or its server-reported last completed-turn time
  // is newer than lastSeen.
  const unread = useMemo(() => {
    const s = new Set<string>();
    for (const c of chats) {
      if (view === "chat" && c.sessionId === activeSession) continue;
      if (c.unread || liveUnread.has(c.sessionId)) {
        s.add(c.sessionId);
        continue;
      }
      const completed = c.lastTurnCompletedAt ? Date.parse(c.lastTurnCompletedAt) : NaN;
      if (Number.isFinite(completed) && completed > readLastSeen(c.sessionId)) {
        s.add(c.sessionId);
      }
    }
    return s;
    // seenVersion is a manual dep: readLastSeen reads a module-level map, which
    // isn't reactive, so a markSeen bumps it to force this recompute.
  }, [chats, view, activeSession, liveUnread, seenVersion]);

  // Mark the focused chat seen on open / deep-link / reload (write lastSeen=now),
  // so viewing a chat clears its unread cue and keeps it read across reloads.
  useEffect(() => {
    if (view === "chat" && activeSession) markSeen(activeSession);
  }, [view, activeSession, markSeen]);

  // Live turn-complete detection for chats WITHOUT a mounted pane (the sidebar
  // can't rely on ChatPane's onTurnComplete, which only fires for the focused
  // chat). When a session leaves the shared running-set it just finished a turn:
  // mark it read if it's the focused chat, else flag it unread immediately.
  const prevRunning = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const prev = prevRunning.current;
    for (const id of prev) {
      if (runningSessions.has(id)) continue; // still running
      if (view === "chat" && id === activeSession) {
        markSeen(id); // completed while focused → stays read
      } else {
        setLiveUnread((s) => (s.has(id) ? s : new Set(s).add(id)));
      }
    }
    prevRunning.current = runningSessions;
  }, [runningSessions, view, activeSession, markSeen]);

  return { markSeen, unread };
}
