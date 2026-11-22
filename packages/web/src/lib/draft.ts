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
//
// The fleet strip lists every chat holding a draft, so each write that changes
// a stored draft fires {@link DRAFTS_CHANGED_EVENT} for the rest of the tab.
// Other tabs hear about it through the browser's own `storage` event.

const PREFIX = "paddock:draft:";

/**
 * Same-tab notification that a saved draft changed. `detail.ids` are the draft
 * ids written — a session id, or "new:<slug>" (see {@link draftId}). The
 * `storage` event covers other tabs, but never fires in the tab that wrote.
 */
export const DRAFTS_CHANGED_EVENT = "paddock:drafts-changed";

/** Fire the same-tab signal; never throws (non-browser / no window). */
function notify(ids: readonly string[]): void {
  if (ids.length === 0) return;
  try {
    window.dispatchEvent(new CustomEvent(DRAFTS_CHANGED_EVENT, { detail: { ids } }));
  } catch {
    /* ignore (non-browser / no window) */
  }
}

/** Remove one key, reporting whether there was anything there to remove. */
function removeKey(key: string): boolean {
  try {
    if (localStorage.getItem(key) === null) return false;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** A draft's id: its session id, or "new:<slug>" — {@link draftKey} minus the prefix. */
export function draftId(sessionId: string | null | undefined, slug: string): string {
  return sessionId ?? `new:${slug}`;
}

/** Whether a localStorage key is a saved draft's (for filtering `storage` events). */
export function isDraftKey(key: string): boolean {
  return key.startsWith(PREFIX);
}

/**
 * The localStorage key for a chat's saved draft. `sessionId` is the established
 * Claude session id once known; before that, a chat is keyed by its slug as
 * "new:<slug>" (the keeper is per-project, so this disambiguates the pending
 * new chat from saved ones).
 */
export function draftKey(sessionId: string | null | undefined, slug: string): string {
  return PREFIX + draftId(sessionId, slug);
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
  const key = draftKey(sessionId, slug);
  if (text.length === 0) {
    if (removeKey(key)) notify([draftId(sessionId, slug)]);
    return;
  }
  try {
    // ChatPane writes on mount with the text it just restored; an unchanged
    // value is not news to anyone listening.
    if (localStorage.getItem(key) === text) return;
    localStorage.setItem(key, text);
    notify([draftId(sessionId, slug)]);
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Forget a chat's saved draft (e.g. on send). */
export function clearDraft(sessionId: string | null | undefined, slug: string): void {
  if (removeKey(draftKey(sessionId, slug))) notify([draftId(sessionId, slug)]);
}

/**
 * Forget the saved drafts of chats that no longer exist. Called after a delete
 * the server confirmed — never optimistically, for the same reason as
 * `forgetChats` in lib/lastSeen.ts: a chat the delete spared still exists, and
 * its half-typed message should still be waiting in its composer.
 */
export function clearDrafts(sessionIds: readonly string[]): void {
  notify(sessionIds.filter((id) => removeKey(PREFIX + id)));
}

/**
 * Every draft saved in this browser, as draft id -> text. One pass over
 * localStorage's keys with a prefix test, so it is cheap enough to re-run on
 * each change event. Returns an empty map when storage is unavailable.
 */
export function listDrafts(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !isDraftKey(key)) continue;
      const text = localStorage.getItem(key);
      if (text !== null) out.set(key.slice(PREFIX.length), text);
    }
  } catch {
    /* ignore (private mode) */
  }
  return out;
}

/** How many words of a draft the fleet strip shows. */
const PREVIEW_WORDS = 6;

/**
 * A draft's opening words, whitespace collapsed, with "…" when there is more.
 * "" for a whitespace-only draft, which the strip does not count: there is
 * nothing in it to come back for.
 */
export function draftPreview(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const head = words.slice(0, PREVIEW_WORDS).join(" ");
  return words.length > PREVIEW_WORDS ? `${head}…` : head;
}

/** One chat holding an unsent draft, as the fleet strip lists them. */
export interface DraftedChat {
  /** The draft's id — see {@link draftId}. */
  id: string;
  /** The chat's session id, or null for a workspace's pending new chat. */
  sessionId: string | null;
  /** Workspace key; the root's is `""`. */
  projectSlug: string;
  /** {@link draftPreview} of the text. */
  preview: string;
}

/**
 * Resolve saved drafts against the chats the client knows about, most recent
 * activity first.
 *
 * `drafts` is draft id -> preview. `chats` is session id -> { workspace key,
 * last activity in epoch ms }, and `workspaces` is every known workspace key.
 * A session draft is kept only when its session id is in `chats`; a
 * "new:<slug>" draft only when `slug` is in `workspaces`. Anything else
 * belongs to a chat this client cannot place — deleted elsewhere, or not yet
 * loaded — and the strip could not link to it.
 *
 * Pending new-chat drafts have no activity time, so they sort last. Ties
 * break on the draft id so the order is stable across renders.
 */
export function draftedChats(
  drafts: ReadonlyMap<string, string>,
  chats: ReadonlyMap<string, { slug: string; at: number }>,
  workspaces: ReadonlySet<string>,
): DraftedChat[] {
  const out: (DraftedChat & { at: number })[] = [];
  for (const [id, preview] of drafts) {
    if (!preview) continue;
    if (id.startsWith("new:")) {
      const slug = id.slice("new:".length);
      if (workspaces.has(slug)) {
        out.push({ id, sessionId: null, projectSlug: slug, preview, at: -Infinity });
      }
      continue;
    }
    const chat = chats.get(id);
    if (chat) out.push({ id, sessionId: id, projectSlug: chat.slug, preview, at: chat.at });
  }
  out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.map(({ at: _at, ...d }) => d);
}
