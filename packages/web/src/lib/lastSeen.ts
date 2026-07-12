// Per-chat "last seen" (read-state) persistence for the unread affordance (#160).
//
// A chat is UNREAD when the agent finished a turn (server `lastTurnCompletedAt`)
// more recently than the user last viewed it. We persist that last-viewed moment
// per chat in localStorage as an epoch-ms timestamp, keyed by session id, and
// compare it against the chat's completed-turn time on load (and clear it live
// when the user opens/focuses the chat).
//
// Unlike lib/draft.ts / lib/chatModel.ts, a chat is only tracked here once it has
// a real session id (unread is meaningless for a brand-new, never-answered chat),
// so there's no "new:<slug>" fallback key. Cheap + try/catch-guarded for private
// mode / quota; never throws.

const PREFIX = "paddock:lastSeen:";

/** The localStorage key for a chat's last-seen timestamp. */
export function lastSeenKey(sessionId: string): string {
  return PREFIX + sessionId;
}

/**
 * Read the epoch-ms timestamp the user last viewed this chat, or 0 if never
 * seen / unavailable (0 sorts before any real completed-turn time, so an unseen
 * chat with a completed turn reads as unread).
 */
export function readLastSeen(sessionId: string): number {
  try {
    const v = localStorage.getItem(lastSeenKey(sessionId));
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Mark this chat seen as of `when` (default now): persist the timestamp so a
 * later completed turn newer than it flags the chat unread again.
 */
export function writeLastSeen(sessionId: string, when: number = Date.now()): void {
  try {
    localStorage.setItem(lastSeenKey(sessionId), String(when));
  } catch {
    /* ignore (private mode / quota) */
  }
}
