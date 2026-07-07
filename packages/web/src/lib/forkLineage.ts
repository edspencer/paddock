// Per-chat "forked from" lineage persistence.
//
// When a chat is forked, the child records which chat it came from so the
// composer can show a "Fork of <parent>" back-link even after a reload. The
// child's *title* ("Fork of <parent>") is persisted server-side (a custom name),
// but the parent's session id — needed to link back — isn't, so we keep the
// {sessionId, name} of the parent here, keyed by the child's session id.
//
// Mirrors the helper style in lib/chatModel.ts (cheap, try/catch-guarded for
// private mode / quota, never throws). Same-browser only, which is fine: it's a
// convenience back-link, and the child's name already names the parent.

const PREFIX = "paddock:fork:";

/** The parent a forked chat came from. */
export interface ForkParent {
  sessionId: string;
  name: string;
}

/** Read the parent a chat was forked from, or null if it isn't a fork (locally). */
export function readForkParent(sessionId: string | null | undefined): ForkParent | null {
  if (!sessionId) return null;
  try {
    const raw = localStorage.getItem(PREFIX + sessionId);
    if (!raw) return null;
    const v = JSON.parse(raw) as ForkParent;
    return v && typeof v.sessionId === "string" && typeof v.name === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Record that `childSessionId` was forked from `parent`. */
export function writeForkParent(childSessionId: string, parent: ForkParent): void {
  try {
    localStorage.setItem(PREFIX + childSessionId, JSON.stringify(parent));
  } catch {
    /* ignore (private mode / quota) */
  }
}
