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
// Keyed identically to lib/draft.ts / lib/queued.ts: a brand-new chat has no
// session id yet, so it's keyed by its project slug ("new:<slug>"); once the chat
// establishes a real session id, that id is used. Writing an empty list removes
// the key, so clearing the tray (e.g. on send) forgets the stored refs for free.
//
// Cheap, try/catch-guarded for private mode / quota / malformed JSON, never throws.
import type { AttachmentKind, AttachmentRef } from "./types";

const PREFIX = "paddock:attachments:";

/**
 * The localStorage key for a chat's staged attachment refs. `sessionId` is the
 * established Claude session id once known; before that a chat is keyed by its
 * slug as "new:<slug>" (the keeper is per-project, so this disambiguates the
 * pending new chat from saved ones).
 */
export function attachmentRefsKey(sessionId: string | null | undefined, slug: string): string {
  return PREFIX + (sessionId ?? `new:${slug}`);
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
