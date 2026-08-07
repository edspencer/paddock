// Per-chat unsent-composer-attachment persistence (issue #346).
//
// The composer's attachment tray (issue #328) holds files the user has picked/
// dropped/pasted and uploaded to the store, staged until send. That list lived
// only in component-local React state, so a chat switch (ChatPane is keyed by
// chat identity in the parent) or a page refresh silently dropped it — surprising,
// since the unsent composer draft right next to it DOES survive (lib/draft.ts) and
// so does the queued message (lib/queued.ts). This persists the staged attachment
// refs the same way, so they're restored when the pane remounts.
//
// Attachments are uploaded to the server on attach and only the lightweight
// `AttachmentRef` ({ id, filename, kind, size? }) is held client-side — the bytes
// live durably in the server AttachmentStore until the chat is deleted — so
// persisting the tray is just stashing a small JSON array of refs, no bytes.
//
// Once a chat has a session id it keys on that, like lib/draft.ts / lib/queued.ts.
// Writing an empty list removes the key, so clearing the tray (e.g. on send)
// forgets the stored refs for free.
//
// A chat with no session id yet is keyed per NEW-CHAT INSTANCE, not per project
// (#728). Those siblings key on the slug alone ("new:<slug>"), which is one key
// shared by every future new chat in the project: a file staged on a new chat the
// user then abandoned came back pre-staged on the NEXT new chat and rode its first
// message. A draft gets away with that because its text is sitting visibly in the
// composer; a silently restored attachment is easy to miss, and sending a file to
// a conversation you didn't mean to is the data-exposure half of #728.
//
// Cheap, try/catch-guarded for private mode / quota / malformed JSON, never throws.
import type { AttachmentKind, AttachmentRef } from "./types";

const PREFIX = "paddock:attachments:";
/** sessionStorage key holding the current new-chat instance id for a project. */
const INSTANCE_PREFIX = "paddock:newchat-instance:";

/** An opaque, unique-enough instance id. Never parsed, only compared. */
function mintInstanceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `n-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

/**
 * The id of the new chat currently being composed in this project, minting one on
 * first use (#728).
 *
 * Held in **sessionStorage**, which is exactly the lifetime wanted: it survives a
 * reload — so #346's "my staged files came back" still holds for the chat the user
 * is actually looking at — but it is per tab and it is rotated by an explicit
 * "New Chat" ({@link rotateNewChatInstance}), so a *different* new chat never
 * inherits the last one's tray.
 *
 * Falls back to a single shared instance when storage is unavailable (private
 * mode): the pre-#728 behaviour, which is the safe direction for a fallback —
 * the tray still renders its chips, so nothing is attached invisibly.
 */
export function newChatInstanceId(slug: string): string {
  try {
    const k = INSTANCE_PREFIX + slug;
    const existing = sessionStorage.getItem(k);
    if (existing) return existing;
    const id = mintInstanceId();
    sessionStorage.setItem(k, id);
    // Nothing reads the pre-#728 per-project key any more, so an upgrading client
    // would carry it as dead bytes forever. Drop it on the way past.
    try {
      localStorage.removeItem(`${PREFIX}new:${slug}`);
    } catch {
      /* ignore */
    }
    return id;
  } catch {
    return "shared";
  }
}

/**
 * Abandon this project's current new chat: forget its staged refs and mint a fresh
 * instance on the next read. Called from the explicit "New Chat" action — the one
 * place that says "this is a different chat now", as opposed to navigating away
 * from (and back to) the same one.
 */
export function rotateNewChatInstance(slug: string): void {
  try {
    localStorage.removeItem(attachmentRefsKey(null, slug));
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(INSTANCE_PREFIX + slug);
  } catch {
    /* ignore */
  }
}

/**
 * The localStorage key for a chat's staged attachment refs. `sessionId` is the
 * established Claude session id once known; before that a chat is keyed by its
 * slug AND its new-chat instance id ("new:<slug>:<instance>"), so two different
 * new chats in one project never share a tray (#728).
 *
 * Not pure for the pre-session case: it mints the instance id on first use.
 */
export function attachmentRefsKey(sessionId: string | null | undefined, slug: string): string {
  return PREFIX + (sessionId ?? `new:${slug}:${newChatInstanceId(slug)}`);
}

/** Narrow an unknown parsed value to a well-formed AttachmentRef (else null). */
function sanitize(v: unknown): AttachmentRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.filename !== "string" || !o.filename) return null;
  const ref: AttachmentRef = {
    id: o.id,
    filename: o.filename,
    kind: (typeof o.kind === "string" ? o.kind : "file") as AttachmentKind,
  };
  if (typeof o.size === "number" && Number.isFinite(o.size)) ref.size = o.size;
  return ref;
}

/**
 * Read the saved attachment refs for a chat, or `[]` if none/unavailable. Each
 * entry is sanitized defensively (malformed entries are dropped) so a corrupt or
 * outdated stored value can never break the composer on restore. Stale refs whose
 * server file was cleaned up are tolerated by the tray/send path (a broken image
 * falls back to a chip; the server ignores an unknown id), so they aren't pruned
 * here — only structurally-invalid entries are.
 */
export function readAttachmentRefs(
  sessionId: string | null | undefined,
  slug: string,
): AttachmentRef[] {
  try {
    const raw = localStorage.getItem(attachmentRefsKey(sessionId, slug));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitize).filter((r): r is AttachmentRef => r !== null);
  } catch {
    return [];
  }
}

/**
 * Persist (or, when `refs` is empty, forget) a chat's staged attachment refs.
 * Storing an empty array removes the key so a cleared tray leaves no stale refs.
 */
export function writeAttachmentRefs(
  sessionId: string | null | undefined,
  slug: string,
  refs: AttachmentRef[],
): void {
  try {
    const key = attachmentRefsKey(sessionId, slug);
    if (refs.length > 0) localStorage.setItem(key, JSON.stringify(refs));
    else localStorage.removeItem(key);
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Forget a chat's saved attachment refs (e.g. on send). */
export function clearAttachmentRefs(sessionId: string | null | undefined, slug: string): void {
  try {
    localStorage.removeItem(attachmentRefsKey(sessionId, slug));
  } catch {
    /* ignore */
  }
}
