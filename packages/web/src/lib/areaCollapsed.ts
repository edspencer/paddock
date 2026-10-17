import { useCallback, useSyncExternalStore } from "react";

// Per-browser memory of which area sections (a project's `group`) are folded up.
//
// One store, two readers: the sidebar's group headings and the `/projects`
// grid's section headers share the SAME key, so folding "Homelab" in one folds
// it in the other. Both are mounted at once (the grid renders inside the
// shell), so a per-component `useState` seeded from localStorage would let them
// disagree until the next reload — this module keeps a listener set and every
// write notifies it, and the `storage` event carries a write from another tab.
//
// A client pref like `paddock:chatsCollapsed:` (ARCHITECTURE §3, storage class
// 2), not server state. The key and the "1"/"0" values predate the sidebar
// using them (they were the grid's own), so existing folds survive the upgrade.
// Corruption-tolerant: anything but "1" reads as expanded, which hides nothing.

const PREFIX = "paddock:area-collapsed:";

/** Storage key for an area. Unsorted's slug is `""`, stored as "unsorted". */
export function areaCollapsedKey(slug: string): string {
  return PREFIX + (slug || "unsorted");
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** Whether an area is collapsed. False when unset, corrupt or unavailable. */
export function readAreaCollapsed(slug: string): boolean {
  try {
    return localStorage.getItem(areaCollapsedKey(slug)) === "1";
  } catch {
    return false;
  }
}

/** Persist an area's collapsed state and tell every mounted reader. */
export function writeAreaCollapsed(slug: string, collapsed: boolean): void {
  try {
    localStorage.setItem(areaCollapsedKey(slug), collapsed ? "1" : "0");
  } catch {
    /* ignore — private mode / quota; the fold just won't outlive the page */
  }
  notify();
}

/**
 * Subscribe to collapse changes, in this tab or another. The `storage` event
 * fires only in OTHER tabs, so it never double-notifies this one's writes.
 */
export function subscribeAreaCollapsed(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    // `key === null` is a `localStorage.clear()` in another tab.
    if (e.key === null || e.key.startsWith(PREFIX)) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * An area's collapsed state, live: re-renders when ANY reader (this component,
 * the sidebar, the grid, another tab) changes it. Default expanded.
 */
export function useAreaCollapsed(slug: string): [boolean, () => void] {
  const collapsed = useSyncExternalStore(
    subscribeAreaCollapsed,
    () => readAreaCollapsed(slug),
    () => false,
  );
  // Reads the store rather than the render's `collapsed`, so two toggles inside
  // one event can't both flip from the same stale value.
  const toggle = useCallback(() => writeAreaCollapsed(slug, !readAreaCollapsed(slug)), [slug]);
  return [collapsed, toggle];
}
