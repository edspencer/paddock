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

const TS_PREFIX = "paddock:queuedts:";
const ID_PREFIX = "paddock:queuedqid:";

/** The localStorage key for a queued message's legacy enqueue timestamp (#245). */
function queuedTsKey(sessionId: string | null | undefined, slug: string): string {
  return TS_PREFIX + (sessionId ?? `new:${slug}`);
}

/** The localStorage key for a queued message's stable queue id (#245/#736). */
function queuedIdKey(sessionId: string | null | undefined, slug: string): string {
  return ID_PREFIX + (sessionId ?? `new:${slug}`);
}

/**
 * Read the stable id of a chat's queued message (#245/#736), or null.
 *
 * The server matches it against what it has already drained, so it must survive a
 * reload alongside the text — otherwise a reloaded pane re-asserts a message the
 * server already sent and it goes out twice.
 *
 * This used to be the enqueue TIMESTAMP, and the server compared those timestamps
 * as an ordering. They came from `Date.now()` in whichever browser queued the
 * message, so a single fast clock left the server's marker in the future and every
 * later queued message on that chat was silently destroyed (#736). The id is now
 * opaque and compared only for equality. A queue written by the older client is
 * migrated in place, keeping its identity across the upgrade.
 */
export function readQueuedId(sessionId: string | null | undefined, slug: string): string | null {
  try {
    const v = localStorage.getItem(queuedIdKey(sessionId, slug));
    if (v && v.length > 0) return v;
    const legacy = localStorage.getItem(queuedTsKey(sessionId, slug));
    const n = legacy ? Number(legacy) : NaN;
    return Number.isFinite(n) ? `ts:${n}` : null;
  } catch {
    return null;
  }
}

/** Persist (or forget, when `id` is null) a queued message's stable queue id. */
export function writeQueuedId(
  sessionId: string | null | undefined,
  slug: string,
  id: string | null,
): void {
  try {
    const key = queuedIdKey(sessionId, slug);
    if (id != null && id.length > 0) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
    // The pre-#736 key is superseded either way; drop it so a later read can't
    // resurrect a stale identity from it.
    localStorage.removeItem(queuedTsKey(sessionId, slug));
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Mint a fresh queue id. Opaque — never parsed, only compared. */
export function newQueuedId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Older/insecure-context browsers have no randomUUID; any unique-enough
    // string works, since the value is never interpreted.
    return `q-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}
