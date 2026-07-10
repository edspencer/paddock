// Per-transcript-item embed-height persistence.
//
// A long sent-file code/text/markdown embed is given a bounded height with an
// internal scroll and a drag handle (issue #136). When a user resizes one, that
// height should stick — across chat switches (ChatPane remounts) and page
// reloads. We persist the chosen height per item in localStorage, keyed on the
// stable, reload-safe `turn.id` (issue #135), and restore it when the item
// mounts. It's device-sticky (localStorage, not server state) on purpose: an
// embed height is a viewing preference, not shared chat content.
//
// Mirrors the helper style in lib/draft.ts (cheap, try/catch-guarded for private
// mode / quota, never throws).

const PREFIX = "paddock:itemHeight:";

/** The localStorage key for an item's persisted embed height. */
export function itemHeightKey(id: string): string {
  return PREFIX + id;
}

/**
 * Read an item's persisted embed height in px, or null if unset, invalid, or
 * localStorage is unavailable. A stored non-positive / non-finite value is
 * treated as "no preference".
 */
export function readItemHeight(id: string): number | null {
  try {
    const raw = localStorage.getItem(itemHeightKey(id));
    if (raw == null) return null;
    const px = Number(raw);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}

/**
 * Persist (or, when `px` is non-positive / NaN, forget) an item's embed height.
 * Storing a bad value removes the key so it reverts to the default bounding.
 */
export function writeItemHeight(id: string, px: number): void {
  try {
    const key = itemHeightKey(id);
    if (Number.isFinite(px) && px > 0) localStorage.setItem(key, String(Math.round(px)));
    else localStorage.removeItem(key);
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Forget an item's persisted embed height (e.g. on double-click reset). */
export function clearItemHeight(id: string): void {
  try {
    localStorage.removeItem(itemHeightKey(id));
  } catch {
    /* ignore */
  }
}
