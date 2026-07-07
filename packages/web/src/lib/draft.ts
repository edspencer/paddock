// Per-chat unsent-composer-draft persistence.
//
// A chat switch remounts ChatPane (it's keyed by chat identity in the parent),
// and a page refresh reloads it from scratch — either way the in-memory draft
// text is lost. To keep an in-progress message across switches/reloads, we
// persist the unsent composer text per chat in localStorage, restore it when
// the chat mounts, and drop it once the message is sent.
//
// Keyed exactly like lib/chatModel.ts: a brand-new chat has no session id yet,
// so it's keyed by its project slug ("new:<slug>"); once the chat establishes a
// real session id, that id is used. Writing an empty draft removes the key, so
// clearing the composer (e.g. on send) forgets the stored draft for free.
//
// Mirrors the helper style in lib/chatModel.ts / lib/lastTab.ts (cheap,
// try/catch-guarded for private mode / quota, never throws).

const PREFIX = "paddock:draft:";

/**
 * The localStorage key for a chat's saved draft. `sessionId` is the established
 * Claude session id once known; before that, a chat is keyed by its slug as
 * "new:<slug>" (the keeper is per-project, so this disambiguates the pending
 * new chat from saved ones).
 */
export function draftKey(sessionId: string | null | undefined, slug: string): string {
  return PREFIX + (sessionId ?? `new:${slug}`);
}

/** Read the saved draft text for a chat, or "" if none/unavailable. */
export function readDraft(sessionId: string | null | undefined, slug: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId, slug)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist (or, when `text` is empty, forget) a chat's unsent draft. Storing an
 * empty string removes the key so a cleared composer leaves no stale draft.
 */
export function writeDraft(
  sessionId: string | null | undefined,
  slug: string,
  text: string,
): void {
  try {
    const key = draftKey(sessionId, slug);
    if (text.length > 0) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Forget a chat's saved draft (e.g. on send). */
export function clearDraft(sessionId: string | null | undefined, slug: string): void {
  try {
    localStorage.removeItem(draftKey(sessionId, slug));
  } catch {
    /* ignore */
  }
}
