// Per-chat queued-message persistence (issue #197).
//
// The message queue (#91) stacks a single follow-up to auto-send when the
// current turn finishes. That queued text lived only in component-local React
// state, so a chat switch (ChatPane is keyed by chat identity in the parent) or
// a page refresh silently dropped it — surprising, since the unsent composer
// draft right next to it DOES survive (see lib/draft.ts). This persists the
// queued message the same way, so it's restored when the pane remounts and can
// still auto-flush on the next completed turn.
//
// Keyed identically to lib/draft.ts / lib/chatModel.ts: a brand-new chat has no
// session id yet, so it's keyed by its project slug ("new:<slug>"); once the
// chat establishes a real session id, that id is used. Writing an empty/null
// message removes the key, so flushing/editing/clearing the queue (all of which
// set the state to null) forgets the stored message for free.
//
// Cheap, try/catch-guarded for private mode / quota, never throws.

const PREFIX = "paddock:queued:";

/**
 * The localStorage key for a chat's queued message. `sessionId` is the
 * established Claude session id once known; before that a chat is keyed by its
 * slug as "new:<slug>" (the keeper is per-project, so this disambiguates the
 * pending new chat from saved ones).
 */
export function queuedKey(sessionId: string | null | undefined, slug: string): string {
  return PREFIX + (sessionId ?? `new:${slug}`);
}

/** Read the saved queued message for a chat, or `null` if none/unavailable. */
export function readQueued(sessionId: string | null | undefined, slug: string): string | null {
  try {
    const v = localStorage.getItem(queuedKey(sessionId, slug));
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Persist (or, when `text` is null/empty, forget) a chat's queued message.
 * Storing null/"" removes the key so a flushed/cleared queue leaves nothing
 * behind.
 */
export function writeQueued(
  sessionId: string | null | undefined,
  slug: string,
  text: string | null,
): void {
  try {
    const key = queuedKey(sessionId, slug);
    if (text && text.length > 0) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    /* ignore (private mode / quota) */
  }
}
