import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  readLastSeen,
  markSeenLocally,
  revertSeenLocally,
  setServerLastSeen,
} from "../../lib/lastSeen";
import type { Chat } from "../../lib/types";
import { isPageHidden, usePageVisible } from "../../lib/usePageVisible";

/**
 * An automatic mark-seen held back because the tab was hidden (#958). `keepUnread`
 * is the #608 inferred/explicit distinction, carried so the eventual mark is the
 * one that would have happened: an explicit seen (you OPENED it) outranks an
 * inferred one (a turn landed while it was open), so merging two keeps explicit.
 */
interface DeferredSeen {
  id: string;
  keepUnread: boolean;
}

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
 * mark so the derivation recomputes. The one exception is an INFERRED seen
 * (#608) — a turn landing in the chat you happen to be looking at — which bumps
 * lastSeen but leaves an explicit "mark unread" alone: intent beats inference.
 *
 * Owns `liveUnread`/`seenVersion` internally; the WS-owned `runningSessions` set
 * stays owned by ProjectView and is passed in (the fleet-wide running set must
 * not fragment). Returns `markSeen` (also called by the sidebar), its
 * whole-subtree sibling `markManySeen` (#508), and the derived `unread` set.
 * `onSeen` MUST be stable (a `useCallback`) — markSeen depends on it, and the
 * auto-mark-seen effect depends on markSeen.
 *
 * Seen only while visible (#958): the two AUTOMATIC marks — opening the chat,
 * and its turn landing while it is open — are deferred while the tab is hidden
 * (a background tab, a middle-clicked "open in new tab"), and performed on the
 * next `visibilitychange` to visible IF the chat is still the focused one. While
 * deferred, the focused chat is allowed to be unread like any other, so the tab's
 * status, the sidebar and the fleet strip all say "a reply landed you haven't
 * seen". Explicit marks (a click) are not deferred; a click implies visibility.
 */
export function useUnreadChats({
  slug,
  chats,
  view,
  activeSession,
  runningSessions,
  onSeen,
  onManySeen,
}: {
  slug: string;
  chats: Chat[];
  view: string;
  activeSession: string | null;
  runningSessions: ReadonlySet<string>;
  onSeen?: (sessionId: string) => void;
  /**
   * The bulk sibling of `onSeen` (#508): mirror the manual-unread clear for a
   * whole set, and return an UNDO. `markManySeen` is an explicit bulk action with
   * a rollback, so the mirror has to be reversible too — unlike `onSeen`, which
   * rides the "you just opened this chat" path where there is nothing to undo.
   * Need not be stable; nothing depends on it via an effect.
   */
  onManySeen?: (sessionIds: string[]) => () => void;
}): {
  markSeen: (sessionId: string, opts?: { keepUnread?: boolean }) => void;
  markManySeen: (sessionIds: string[]) => void;
  unread: ReadonlySet<string>;
} {
  const [liveUnread, setLiveUnread] = useState<ReadonlySet<string>>(new Set());
  const [seenVersion, setSeenVersion] = useState(0);
  const [deferred, setDeferred] = useState<DeferredSeen | null>(null);
  const visible = usePageVisible();
  /**
   * Mark a chat seen. `keepUnread` makes it an INFERRED seen (#608): the
   * lastSeen watermark still advances, but a manual "mark unread" override
   * (#458) is left alone on BOTH sides — the parent's mirror isn't cleared and
   * the server is asked to keep its flag. Intent outranks inference.
   */
  const markSeen = useCallback(
    (sessionId: string, opts?: { keepUnread?: boolean }) => {
      const when = Date.now();
      const keepUnread = opts?.keepUnread === true;
      // Optimistic in-memory clear (+ same-tab event), then persist to the server
      // (#189), which is the sole source of truth (#488). The bump is session-
      // scoped, so a reload always re-derives from the server and devices can't
      // diverge; if the POST fails we roll it back so the cue honestly reappears
      // rather than silently sticking (the pre-#488 behaviour).
      const prev = markSeenLocally(sessionId, when);
      // The `/seen` route also clears any server-side manual unread override (#458);
      // `onSeen` mirrors that in the parent's chat state so the cue can't briefly
      // flicker back after leaving the chat, before the next list refetch. Both
      // halves are skipped for an inferred seen (#608) so an explicit flag stands.
      const opt = keepUnread ? { keepUnread: true } : undefined;
      void api.markChatSeen(slug, sessionId, when, opt).catch(() => {
        revertSeenLocally(sessionId, prev, when);
        setSeenVersion((v) => v + 1);
      });
      if (!keepUnread) onSeen?.(sessionId);
      // An explicit mark supersedes a deferred one for the same chat — there is
      // nothing left to do when the tab comes back.
      if (!keepUnread) setDeferred((d) => (d?.id === sessionId ? null : d));
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

  /**
   * Mark a WHOLE set of chats seen (#508) — the Shift-click "mark read" on a
   * parent row, which covers it and every descendant.
   *
   * One chat delegates to {@link markSeen} so the ordinary path keeps using
   * `/seen`. Several go through the batch route in ONE request: looping `/seen`
   * over 21 chats can half-succeed, and there'd be no single thing to roll back.
   * The batch route does both halves of "read" server-side (clears each manual
   * unread override AND advances each watermark), which is exactly what `/seen`
   * does for one chat.
   */
  const markManySeen = useCallback(
    (sessionIds: string[]) => {
      if (sessionIds.length <= 1) {
        if (sessionIds[0]) markSeen(sessionIds[0]);
        return;
      }
      const when = Date.now();
      // THREE things go optimistically read here, so all three have to come back
      // if the POST fails. Rolling back only the lastSeen bump (as the first cut
      // of this did) leaves the family showing as read forever: nothing polls, so
      // the client never re-derives from the server until an unrelated turn or
      // chat creation triggers a refetch.
      const seenBefore = sessionIds.map((id) => [id, markSeenLocally(id, when)] as const);
      const liveBefore = sessionIds.filter((id) => liveUnread.has(id));
      // The parent mirrors the manual-unread clear in its own chat list and hands
      // back the undo — it owns that state, so it owns restoring it.
      const undoManualClear = onManySeen?.(sessionIds);
      setLiveUnread((live) => {
        if (!liveBefore.length) return live;
        const next = new Set(live);
        for (const id of liveBefore) next.delete(id);
        return next;
      });
      setSeenVersion((v) => v + 1);
      void api.markChatsUnread(slug, sessionIds, false).catch(() => {
        for (const [id, p] of seenBefore) revertSeenLocally(id, p, when);
        if (liveBefore.length) {
          setLiveUnread((live) => {
            const next = new Set(live);
            for (const id of liveBefore) next.add(id);
            return next;
          });
        }
        undoManualClear?.();
        setSeenVersion((v) => v + 1);
      });
    },
    [slug, onManySeen, markSeen, liveUnread],
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
  // live completion, or a mark-seen changes. The currently-open chat is never
  // unread — UNLESS its mark-seen is deferred because the tab is hidden (#958),
  // in which case nobody has seen it and it is judged like any other. That is
  // what the chat page's `✓ ` reports: "this chat is unread while you're on it
  // in a background tab" — a turn that landed while hidden, OR an already-unread
  // chat opened in a background tab (middle-click). Both are intended.
  // Otherwise a chat is unread if the user manually flagged it (#458), it was
  // live-flagged this session, or its server-reported last completed-turn time
  // is newer than lastSeen.
  // An ARCHIVED chat is never unread here: archived is silent, the rule the
  // projects payload's `chatTurns` and `/chats/attention` apply, so a dot in the
  // Archived section would be one no badge counts. Silenced, not consumed — its
  // read-state is untouched, so unarchiving brings the cue back.
  const unread = useMemo(() => {
    const s = new Set<string>();
    for (const c of chats) {
      if (c.archived) continue;
      if (view === "chat" && c.sessionId === activeSession && deferred?.id !== c.sessionId) continue;
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
  }, [chats, view, activeSession, liveUnread, seenVersion, deferred]);

  // Hold an automatic mark back until the tab is visible (#958). Merging keeps
  // the explicit flavour if either mark was explicit (see `DeferredSeen`).
  const defer = useCallback((id: string, keepUnread: boolean) => {
    setDeferred((d) =>
      d?.id === id ? (d.keepUnread && !keepUnread ? { id, keepUnread } : d) : { id, keepUnread },
    );
  }, []);

  // Mark the focused chat seen on open / deep-link / reload (write lastSeen=now),
  // so viewing a chat clears its unread cue and keeps it read across reloads.
  // Visibility is READ here, not a dependency: re-marking on every return to the
  // tab would spend a manual "mark unread" set on the open chat (#608).
  useEffect(() => {
    if (view !== "chat" || !activeSession) return;
    if (isPageHidden()) defer(activeSession, false);
    else markSeen(activeSession);
  }, [view, activeSession, markSeen, defer]);

  // Settle a deferred mark. Focus moved off the chat (a redirect, a deletion) →
  // drop it: it belongs to a chat nobody is looking at, which stays unread. Tab
  // visible with the chat still focused → perform it, as the flavour recorded.
  // `visible` is the re-run trigger; the live read is what decides, so a render
  // that raced a `visibilitychange` can't mark a hidden tab seen. The clear is an
  // identity updater: the open effect above may have queued a deferral for a NEW
  // focused chat in this same commit, and that one must survive.
  //
  // A LAYOUT effect, so the mark lands before the browser paints the render the
  // `visibilitychange` caused: the `✓ ` / unread cue would otherwise show for one
  // frame on return. Safe here: it only sets state (re-rendered synchronously,
  // still pre-paint) and fires the `/seen` POST, which is async; it reads no
  // layout, and nothing downstream depends on it running after paint.
  useLayoutEffect(() => {
    if (!deferred) return;
    const stillFocused = view === "chat" && deferred.id === activeSession;
    if (stillFocused && isPageHidden()) return;
    setDeferred((d) => (d === deferred ? null : d));
    if (!stillFocused) return;
    // A deferred OPEN is an explicit seen, so it clears a manual "mark unread"
    // (#458) — including one set from another tab or device while this tab was
    // hidden. Deliberate: the user is now actually looking at the chat, which is
    // exactly what an explicit seen means, and the same thing opening it in a
    // visible tab would have done. #608's "intent beats inference" is preserved
    // for the INFERRED flavour (a turn landing while hidden), which still keeps
    // the flag via `keepUnread`.
    markSeen(deferred.id, deferred.keepUnread ? { keepUnread: true } : undefined);
  }, [deferred, visible, view, activeSession, markSeen]);

  // Live turn-complete detection for chats WITHOUT a mounted pane (the sidebar
  // can't rely on ChatPane's onTurnComplete, which only fires for the focused
  // chat). When a session leaves the shared running-set it just finished a turn:
  // mark it read if it's the focused chat, else flag it unread immediately.
  const prevRunning = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const prev = prevRunning.current;
    for (const id of prev) {
      if (runningSessions.has(id)) continue; // still running
      if (view === "chat" && id === activeSession && isPageHidden()) {
        // Completed while focused but the tab is hidden (#958): nobody watched
        // it land. Flag it like any unseen reply, and leave the (inferred) mark
        // for when the tab is shown.
        setLiveUnread((s) => (s.has(id) ? s : new Set(s).add(id)));
        defer(id, true);
      } else if (view === "chat" && id === activeSession) {
        // Completed while focused → stays read, but this is an INFERRED seen, so
        // it must not spend a manual unread flag the user set seconds earlier
        // (#608) — including one set from another client via the API.
        markSeen(id, { keepUnread: true });
      } else {
        setLiveUnread((s) => (s.has(id) ? s : new Set(s).add(id)));
      }
    }
    prevRunning.current = runningSessions;
  }, [runningSessions, view, activeSession, markSeen, defer]);

  return { markSeen, markManySeen, unread };
}
