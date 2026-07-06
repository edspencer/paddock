// Small formatting helpers shared across the UI.

/** A bare calendar date with no time component, e.g. "2026-06-21". */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Human "time ago" for an ISO timestamp or date string.
 *
 * Date-only values (`YYYY-MM-DD`, how project.yaml stores `started`/`updated`)
 * have no time component, so `new Date("2026-06-21")` parses as midnight UTC —
 * which would render a misleading hour-precise "5h ago" for a project touched
 * today. For those we fall back to a calendar-relative label computed in the
 * viewer's local timezone (today / yesterday / Nd ago).
 */
export function relativeTime(iso?: string): string {
  if (!iso) return "";

  if (DATE_ONLY_RE.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    const then = new Date(y, m - 1, d); // local midnight
    if (Number.isNaN(then.getTime())) return iso;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((startOfToday.getTime() - then.getTime()) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days}d ago`;
    if (days < 35) return `${Math.round(days / 7)}w ago`;
    if (days < 365) return `${Math.round(days / 30)}mo ago`;
    return `${Math.round(days / 365)}y ago`;
  }

  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** Format a duration in ms compactly (e.g. 74ms, 1.3s, 12s, 3m 32s). */
export function formatDuration(ms?: number): string | null {
  if (ms == null || Number.isNaN(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
