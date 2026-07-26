// Per-project, per-browser memory of which chat-tree parents are folded up.
//
// Mirrors the `paddock:lastTab:` / `paddock:pane:` client-pref pattern (see
// ARCHITECTURE §3, storage class 2): a browser preference, deliberately NOT
// server state — collapsing a noisy fan-out on a laptop shouldn't fold it on a
// phone. Corruption-tolerant: any unreadable value reads back as "nothing
// collapsed", which is the safe default because it hides no chats.

const PREFIX = "paddock:chatsCollapsed:";

/** Read the collapsed set for a project; empty when unset/corrupt/unavailable. */
export function readCollapsedChats(slug: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(PREFIX + slug);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/** Persist the collapsed set for a project. Best effort (private mode / quota). */
export function writeCollapsedChats(slug: string, ids: ReadonlySet<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(PREFIX + slug);
    else localStorage.setItem(PREFIX + slug, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}
