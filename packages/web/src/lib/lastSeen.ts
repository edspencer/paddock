// Per-chat "last seen" (read-state) persistence for the unread affordance (#160).
//
// A chat is UNREAD when the agent finished a turn (server `lastTurnCompletedAt`)
// more recently than the user last viewed it. Read-state now lives SERVER-SIDE
// (#189) so it follows the user across devices: the chat DTO / projects payload
// carry a `lastSeen` epoch-ms, which is the source of truth. This module keeps a
// localStorage MIRROR purely for optimistic same-tab UI (so opening a chat clears
// its cue instantly, before the POST round-trips) and layers the two: the
// effective last-seen for a chat is `max(server, local)`.
//
// - `readLastSeen` returns that max — server value folded in via `setServerLastSeen`
//   whenever a chats/projects payload arrives, local value from localStorage.
// - `writeLastSeen` is the optimistic local write (+ same-tab event); the caller
//   also fires the `POST .../seen` so the server catches up.
//
// Unlike lib/draft.ts / lib/chatModel.ts, a chat is only tracked here once it has
// a real session id (unread is meaningless for a brand-new, never-answered chat),
// so there's no "new:<slug>" fallback key. Cheap + try/catch-guarded for private
// mode / quota; never throws.

const PREFIX = "paddock:lastSeen:";

/**
 * Server-provided last-seen values, keyed by session id (from the chat DTO /
 * projects payload). This is the cross-device source of truth; it's merged with
 * the local optimistic mirror in `readLastSeen`. Module-level so every consumer
 * (chat list + sidebar badges) shares one view, updated in place.
 */
const serverLastSeen = new Map<string, number>();

/**
 * Same-tab notification that a `lastSeen` marker changed (the `storage` event
 * only fires in OTHER tabs). The sidebar unread badge (#161) listens for this
 * to recompute its per-project counts the moment the user opens a chat, so the
 * badge clears without a reload.
 */
export const LAST_SEEN_EVENT = "paddock:lastSeen-changed";

/** The localStorage key for a chat's last-seen timestamp. */
export function lastSeenKey(sessionId: string): string {
  return PREFIX + sessionId;
}

/** The localStorage-only last-seen value for a chat (0 if none / unavailable). */
function readLocalLastSeen(sessionId: string): number {
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
 * The effective epoch-ms the user last viewed this chat: `max(server, local)`,
 * or 0 if never seen / unavailable (0 sorts before any real completed-turn time,
 * so an unseen chat with a completed turn reads as unread). The SERVER value
 * (folded in via `setServerLastSeen` from the DTO) is the cross-device source of
 * truth; the local mirror only ever pushes it FORWARD for optimistic same-tab UI
 * during the POST round-trip, never backward.
 */
export function readLastSeen(sessionId: string): number {
  return Math.max(readLocalLastSeen(sessionId), serverLastSeen.get(sessionId) ?? 0);
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
  if (when <= (serverLastSeen.get(sessionId) ?? 0)) return;
  serverLastSeen.set(sessionId, when);
  try {
    window.dispatchEvent(new CustomEvent(LAST_SEEN_EVENT, { detail: { sessionId } }));
  } catch {
    /* ignore (non-browser / no window) */
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
  // Let the sidebar badge recompute in THIS tab (storage events don't self-fire).
  try {
    window.dispatchEvent(new CustomEvent(LAST_SEEN_EVENT, { detail: { sessionId } }));
  } catch {
    /* ignore (non-browser / no window) */
  }
}
