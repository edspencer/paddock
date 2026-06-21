// Per-chat model selection persistence.
//
// The model picker in the chat composer (CONTRACT-v3 §8) remembers, per chat,
// which model the user selected. Stored in localStorage under a per-chat key so
// reopening that chat (or reloading) restores the choice. A brand-new chat has
// no session id yet, so it's keyed by its project slug ("new:<slug>"); once the
// chat establishes a real session id, the picker keys off that id instead.
//
// Mirrors the helper style in lib/lastTab.ts (cheap, try/catch-guarded for
// private mode / quota, never throws).

const PREFIX = "paddock:chatModel:";

/**
 * The localStorage key for a chat's saved model. `sessionId` is the established
 * Claude session id once known; before that, a chat is keyed by its slug as
 * "new:<slug>" (the keeper is per-project, so this disambiguates the pending
 * new chat from saved ones).
 */
export function chatModelKey(sessionId: string | null | undefined, slug: string): string {
  return PREFIX + (sessionId ?? `new:${slug}`);
}

/** Read the saved model id for a chat, or null if none/unavailable. */
export function readChatModel(sessionId: string | null | undefined, slug: string): string | null {
  try {
    const v = localStorage.getItem(chatModelKey(sessionId, slug));
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Persist a chat's selected model id. */
export function writeChatModel(
  sessionId: string | null | undefined,
  slug: string,
  model: string,
): void {
  try {
    localStorage.setItem(chatModelKey(sessionId, slug), model);
  } catch {
    /* ignore (private mode / quota) */
  }
}
