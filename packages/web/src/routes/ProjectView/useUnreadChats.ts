import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { readLastSeen, writeLastSeen, setServerLastSeen } from "../../lib/lastSeen";
import type { Chat } from "../../lib/types";

/**
 * Unread affordance (#160), extracted from ProjectView.tsx (issue #403). A chat
 * is unread when the agent finished a turn while the user wasn't viewing it.
 * Two signals combine:
 *  - `liveUnread`: chats flagged the instant a turn completed for a NON-focused
 *    chat this session (from the shared socket's running-set transitions);
 *  - server `lastTurnCompletedAt` newer than the locally stored last-seen time
 *    (`lib/lastSeen.ts`), which covers reload + turns that finished while away.
 * Marking a chat seen (open/focus, or its turn completing while focused) writes
 * lastSeen=now and clears its live flag. `seenVersion` bumps on every mark so
 * the (localStorage-backed) derivation recomputes.
 *
 * Owns `liveUnread`/`seenVersion` internally; the WS-owned `runningSessions` set
 * stays owned by ProjectView and is passed in (the fleet-wide running set must
 * not fragment). Returns `markSeen` (also called by the sidebar) and the derived
 * `unread` set.
 */
export function useUnreadChats({
  slug,
  chats,
  view,
  activeSession,
  runningSessions,
}: {
  slug: string;
  chats: Chat[];
  view: string;
  activeSession: string | null;
  runningSessions: ReadonlySet<string>;
}): { markSeen: (sessionId: string) => void; unread: ReadonlySet<string> } {
  const [liveUnread, setLiveUnread] = useState<ReadonlySet<string>>(new Set());
  const [seenVersion, setSeenVersion] = useState(0);
  const markSeen = useCallback(
    (sessionId: string) => {
      const when = Date.now();
      // Optimistic same-tab clear (localStorage mirror + event), then persist to
      // the server (#189) so read-state follows the user across devices. The POST
      // is fire-and-forget — the mirror already cleared the cue; a failure just
      // means the next refetch re-derives from whatever the server has.
      writeLastSeen(sessionId, when);
      void api.markChatSeen(slug, sessionId, when).catch(() => undefined);
      setLiveUnread((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setSeenVersion((v) => v + 1);
    },
    [slug],
  );

  // Fold the server-backed read-state (#189) from each chat DTO into the shared
  // client cache whenever the list changes, so `readLastSeen` prefers it. This
  // is what makes a chat opened on ANOTHER device show as read here.
  useEffect(() => {
    for (const c of chats) setServerLastSeen(c.sessionId, c.lastSeen);
  }, [chats]);

  // The set of unread chats, re-derived whenever the list, the focused chat, a
  // live completion, or a mark-seen changes. The currently-open chat is NEVER
  // unread. Otherwise a chat is unread if it was live-flagged this session, or
  // its server-reported last completed-turn time is newer than lastSeen.
  const unread = useMemo(() => {
    const s = new Set<string>();
    for (const c of chats) {
      if (view === "chat" && c.sessionId === activeSession) continue;
      if (liveUnread.has(c.sessionId)) {
        s.add(c.sessionId);
        continue;
      }
      const completed = c.lastTurnCompletedAt ? Date.parse(c.lastTurnCompletedAt) : NaN;
      if (Number.isFinite(completed) && completed > readLastSeen(c.sessionId)) {
        s.add(c.sessionId);
      }
    }
    return s;
    // seenVersion is a manual dep: readLastSeen reads localStorage, which isn't
    // reactive, so a markSeen bumps it to force this recompute.
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
