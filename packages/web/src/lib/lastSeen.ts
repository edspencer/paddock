// Per-chat "last seen" (read-state) for the unread affordance (#160).
//
// A chat is UNREAD when the agent finished a turn (server `lastTurnCompletedAt`)
// more recently than the user last viewed it. Read-state lives SERVER-SIDE (#189)
// so it follows the user across devices: the chat DTO / projects payload carry a
// `lastSeen` epoch-ms, which is the SOLE source of truth.
//
// This module used to layer a PERSISTENT localStorage mirror on top, taking
// `max(server, local)`. That made devices diverge permanently (#488): a local
// value the server never received marked a chat read on that device only, and the
// mirror never synced upward — so two devices on the same account reported
// different unread counts indefinitely.
//
// The fix separates PERSISTENCE from OPTIMISM. We keep the optimistic instant
// clear (opening a chat shouldn't wait for a POST + refetch to drop its cue) but
// hold it in the SAME in-memory map the server payload folds into. Because that
// map is session-scoped rather than device-scoped, every reload re-derives from
// the server and divergence is structurally impossible rather than merely
// repaired. A failed `/seen` POST rolls the optimistic bump back (see
// `revertSeenLocally`) instead of silently sticking.
//
// - `readLastSeen`     — the effective last-seen (in-memory only).
// - `setServerLastSeen`— fold in a server value (monotonic).
// - `markSeenLocally`  — optimistic bump; caller also fires `POST .../seen`.
// - `revertSeenLocally`— undo that bump when the POST fails.
//
// Nothing in here touches localStorage any more. The one-time migration that
// pushed surviving pre-#488 values up to the server has drained and was deleted
// (#552), along with the two helpers that read and cleared those keys.

const PREFIX = "paddock:lastSeen:";

/**
 * The effective last-seen value per session id: server values folded in from the
 * chat DTO / projects payload, plus optimistic bumps from `markSeenLocally`.
 * Module-level so every consumer (chat list + sidebar badges) shares one view.
 * IN-MEMORY ONLY — never persisted, so a reload starts from server truth (#488).
 */
const lastSeen = new Map<string, number>();

/**
 * Same-tab notification that a `lastSeen` marker changed. The sidebar unread
 * badge (#161) listens for this to recompute its per-project counts the moment
 * the user opens a chat, so the badge clears without a reload.
 */
export const LAST_SEEN_EVENT = "paddock:lastSeen-changed";

/**
 * The pre-#488 localStorage key for a chat's last-seen timestamp. Nothing reads
 * or writes it any more — it survives only so the guard tests can name the key
 * this module must never touch again.
 */
export function lastSeenKey(sessionId: string): string {
  return PREFIX + sessionId;
}

/** Fire the same-tab recompute signal; never throws (non-browser / no window). */
function notify(sessionId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(LAST_SEEN_EVENT, { detail: { sessionId } }));
  } catch {
    /* ignore (non-browser / no window) */
  }
}

/**
 * The epoch-ms the user last viewed this chat, or 0 if never seen (0 sorts before
 * any real completed-turn time, so an unseen chat with a completed turn reads as
 * unread). Server-derived, with any in-flight optimistic bump applied.
 */
export function readLastSeen(sessionId: string): number {
  return lastSeen.get(sessionId) ?? 0;
}

/**
 * Fold a server-provided last-seen value (from the chat DTO / projects payload)
 * into the shared cache. Monotonic — only ever advances — and dispatches the
 * same-tab event when it does, so the unread derivations recompute (e.g. a chat
 * opened on ANOTHER device lands here on the next refresh and clears its cue).
 * A 0/absent server value is ignored (nothing seen yet).
 */
export function setServerLastSeen(sessionId: string, when: number | undefined): void {
  if (!when || !Number.isFinite(when)) return;
  if (when <= (lastSeen.get(sessionId) ?? 0)) return;
  lastSeen.set(sessionId, when);
  notify(sessionId);
}

/**
 * Optimistically mark this chat seen as of `when` (default now) so its cue clears
 * immediately, before the `POST .../seen` round-trips. Monotonic like the server
 * fold. Returns the PREVIOUS value so a failed POST can roll it back — pass it to
 * {@link revertSeenLocally}. Purely in-memory: a reload re-derives from the server.
 */
export function markSeenLocally(sessionId: string, when: number = Date.now()): number {
  const prev = lastSeen.get(sessionId) ?? 0;
  if (when <= prev) return prev;
  lastSeen.set(sessionId, when);
  notify(sessionId);
  return prev;
}

/**
 * Undo an optimistic {@link markSeenLocally} after its `/seen` POST failed, so the
 * unread cue honestly reappears rather than silently sticking (the pre-#488 bug —
 * a swallowed POST failure left the chat looking read forever on that device).
 * Only reverts when the current value is still the optimistic one we set, so a
 * server value that landed in the meantime is never clobbered.
 */
export function revertSeenLocally(sessionId: string, prev: number, applied: number): void {
  if (lastSeen.get(sessionId) !== applied) return; // superseded — leave it alone
  if (prev) lastSeen.set(sessionId, prev);
  else lastSeen.delete(sessionId);
  notify(sessionId);
}

/**
 * Same-tab notification that chats have LEFT this instance (#732). `detail` is
 * the departed session ids.
 *
 * The unread affordance is a set of per-session-id caches — this module's
 * `lastSeen` map and the sidebar badge's completion cache — and none of them had
 * any notion of a chat ending. They only ever grew, so deleting an unread chat
 * left its cue counted by a badge with nothing left to open to clear it. The
 * server side of that is fixed by pruning `chatTurns`, but the badge is also fed
 * by LIVE turn completions over the WS, and under the default `session` drive
 * mode (which writes no job records) those live signals are most of what the
 * badge is made of. So the client needs the same "this is gone" edge, and it
 * needs it without a reload.
 */
export const CHATS_GONE_EVENT = "paddock:chats-gone";

/**
 * Drop every trace of these chats from the client's read-state cache and tell
 * the rest of the tab to do the same ({@link CHATS_GONE_EVENT}).
 *
 * Called after a delete the server confirmed — never optimistically. A chat the
 * delete FAILED on still exists, and forgetting its watermark would resurrect
 * its unread cue on a chat the user was just told survived.
 */
export function forgetChats(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  for (const id of sessionIds) lastSeen.delete(id);
  try {
    window.dispatchEvent(new CustomEvent(CHATS_GONE_EVENT, { detail: { sessionIds } }));
  } catch {
    /* ignore (non-browser / no window) */
  }
}

/**
 * Clear the in-memory cache (tests only). The map is module-level and, unlike the
 * localStorage it replaced, isn't reset by `localStorage.clear()` — so a suite
 * reusing session ids across cases must reset it explicitly.
 */
export function resetLastSeenForTests(): void {
  lastSeen.clear();
}
