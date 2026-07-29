// How the chat list is rendered: nested vs flat, and whether it is filtered to
// the chats running right now. Two booleans, one toolbar button each. Browser
// preferences (ARCHITECTURE §3, storage class 2), same read/write + try-catch
// shape as `collapsedChats.ts`.
//
// GLOBAL, not per-project — deliberately, for two reasons:
//
//  1. "How I like to read a list" is not a per-project fact. Per-project keys
//     would silently forget the choice every time you switch projects, which
//     reads as the toggle being broken.
//  2. The root workspace's key is the EMPTY STRING, so every slug-keyed pref is
//     one `if (!slug)` away from the falsy-key bug class. No slug, no hazard.
//
// Every value is corruption-tolerant and falls back to the setting that HIDES
// NOTHING: nesting on (the current behaviour) and the running filter off. A
// half-written localStorage value must never be able to make chats disappear.

const NESTED_KEY = "paddock:chatView:nested";
const RUNNING_ONLY_KEY = "paddock:chatView:runningOnly";

/** Read a stored boolean; `fallback` on unset, corrupt, or unavailable storage. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    // Only the two values we write are trusted. Treating "anything but 1" as
    // false would let a corrupt value turn nesting OFF — the fallback exists
    // precisely so a bad read can never change what the list shows.
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

/** Persist a boolean. Best effort (private mode / quota), never throws. */
function writeFlag(key: string, value: boolean, fallback: boolean): void {
  try {
    // Storing only the non-default keeps the key absent for the common case, so
    // a cleared profile and a deliberately-default profile look the same.
    if (value === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Nest chats under the chat that created them. Default on — today's behaviour. */
export function readNestedChats(): boolean {
  return readFlag(NESTED_KEY, true);
}

export function writeNestedChats(value: boolean): void {
  writeFlag(NESTED_KEY, value, true);
}

/** Show only chats with a live turn. Default off — a filter must be opt-in. */
export function readRunningOnly(): boolean {
  return readFlag(RUNNING_ONLY_KEY, false);
}

export function writeRunningOnly(value: boolean): void {
  writeFlag(RUNNING_ONLY_KEY, value, false);
}
