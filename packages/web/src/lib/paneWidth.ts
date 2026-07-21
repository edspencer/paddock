// Per-browser persisted widths for the resizable desktop panes (#374): the app
// side-nav and the per-project chat-list pane. Mirrors the localStorage helper
// style in lib/draft.ts / lib/itemHeight.ts — cheap, try/catch-guarded (private
// mode / quota), never throws. Persisted per-browser so a laptop and a desktop
// can each settle at their own width. Only applied on desktop (see usePaneWidth);
// the mobile drawer layout keeps its CSS widths.

const PREFIX = "paddock:panewidth:";

/** A resizable pane's identity + its default and clamp bounds (in CSS px). */
export interface PaneSpec {
  /** Stable localStorage key segment (e.g. "sidenav", "chatlist"). */
  key: string;
  /** Default width when nothing is persisted — matches the Tailwind class width. */
  def: number;
  min: number;
  max: number;
}

/** The app-wide left side-nav (`w-72` = 288px default). */
export const SIDENAV_PANE: PaneSpec = { key: "sidenav", def: 288, min: 200, max: 480 };
/** The per-project chat-list pane (`w-64` = 256px default). */
export const CHATLIST_PANE: PaneSpec = { key: "chatlist", def: 256, min: 220, max: 520 };

/** Media query that gates the resize affordance to desktop (matches Tailwind `lg`). */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** Clamp a width to a pane's [min, max]. */
export function clampWidth(spec: PaneSpec, px: number): number {
  return Math.min(Math.max(px, spec.min), spec.max);
}

/**
 * The new width for a drag: the drag's start width plus the horizontal delta,
 * clamped to the pane's bounds. Extracted so the arithmetic is unit-testable
 * without a real pointer / layout (mirrors ResizableBox's `nextHeight`).
 */
export function nextWidth(startWidth: number, deltaX: number, spec: PaneSpec): number {
  return clampWidth(spec, startWidth + deltaX);
}

/** Read a pane's persisted width (clamped), or null if none/unavailable. */
export function readPaneWidth(spec: PaneSpec): number | null {
  try {
    const raw = localStorage.getItem(PREFIX + spec.key);
    if (raw == null) return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? clampWidth(spec, n) : null;
  } catch {
    return null;
  }
}

/** Persist a pane's width (clamped first so a bad value can't be stored). */
export function writePaneWidth(spec: PaneSpec, px: number): void {
  try {
    localStorage.setItem(PREFIX + spec.key, String(clampWidth(spec, px)));
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Forget a pane's persisted width (e.g. on double-click reset). */
export function clearPaneWidth(spec: PaneSpec): void {
  try {
    localStorage.removeItem(PREFIX + spec.key);
  } catch {
    /* ignore */
  }
}
