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

/** Compact token count: 523 → "523", 340_000 → "340K", 1_250_000 → "1.25M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${Math.round(n)}`;
}

/** A ballpark USD figure: 4.1 → "$4.10", 0.004 → "<$0.01", 0 → "$0.00". */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** The cumulative token/cost fields shared by ChatUsage (see lib/types.ts). */
export interface SessionUsageParts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

/**
 * Narrow an object carrying the (possibly optional/absent) cumulative usage
 * fields — a `Chat` or a `ChatUsage` — to a concrete {@link SessionUsageParts},
 * or `undefined` when there's no usage data yet (`totalTokens` absent). Lets the
 * ring call sites pass `usage={sessionUsageOf(chat)}` uniformly.
 */
export function sessionUsageOf(
  x?: Partial<SessionUsageParts> | null,
): SessionUsageParts | undefined {
  if (!x || x.totalTokens == null) return undefined;
  return {
    inputTokens: x.inputTokens ?? 0,
    outputTokens: x.outputTokens ?? 0,
    cacheReadTokens: x.cacheReadTokens ?? 0,
    cacheCreationTokens: x.cacheCreationTokens ?? 0,
    totalTokens: x.totalTokens,
    costUsd: x.costUsd ?? null,
  };
}

/**
 * A one-line summary of a chat's cumulative token consumption, e.g.
 * "1.25M tokens · 910K in / 340K out · ~$4.10 at API rates". The dollar clause is
 * dropped when the model has no known pricing (`costUsd == null`). "in" folds the
 * input-side classes (fresh input + cache read + cache write) together.
 */
export function formatSessionUsage(u: SessionUsageParts): string {
  const inSide = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const base = `${formatTokens(u.totalTokens)} tokens · ${formatTokens(inSide)} in / ${formatTokens(u.outputTokens)} out`;
  return u.costUsd == null ? base : `${base} · ~${formatUsd(u.costUsd)} at API rates`;
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

// ── Compaction / slash-command transcript artifacts (issue #106) ────────────
//
// Claude Code writes several `type:"user"` transcript entries that the human
// never actually typed. @herdctl/core's parser drops the ones flagged
// `isMeta:true` (the `<local-command-caveat>`, injected "Continue from where you
// left off." etc.), but two survive with `isMeta` unset and, exposed to us only
// as a plain `role:"user"` string, would otherwise render as the user's own chat
// bubbles — making a compacted chat look corrupted (it can even end on one):
//
//   1. the `/compact` (or any) slash-command echo, an XML blob, and
//   2. the post-compaction continuation summary CC injects on resume.
//
// We detect both from their content so the renderer can show a clean marker
// instead of a raw bubble. Detection is intentionally forgiving of leading
// whitespace.

/** CC's post-compaction continuation preamble; stable across manual/auto compaction. */
const COMPACT_CONTINUATION_PREFIX =
  "This session is being continued from a previous conversation";

/**
 * True when a `role:"user"` message is CC's post-`/compact` continuation summary
 * ("This session is being continued from a previous conversation…"). Rendered as
 * a "conversation compacted" boundary rather than a user bubble (issue #106).
 */
export function isCompactContinuation(content: string): boolean {
  return content.trimStart().startsWith(COMPACT_CONTINUATION_PREFIX);
}

/**
 * If a `role:"user"` message is a slash-command echo CC writes as
 * `<command-name>/compact</command-name><command-message>…</command-message>…`,
 * return the command (e.g. "/compact"); otherwise null. Used to render a compact
 * command chip instead of the raw XML as a user bubble (issue #106).
 */
export function slashCommandEcho(content: string): string | null {
  const m = /^\s*<command-name>([^<]*)<\/command-name>/.exec(content);
  if (!m) return null;
  const name = m[1].trim();
  return name.length > 0 ? name : null;
}

// ── Background-agent task notifications (issue #181) ─────────────────────────
//
// When a background agent (Task/Agent tool) stops or completes, the Claude Code
// harness injects a `<task-notification>` block as a synthetic `role:"user"`
// transcript entry (`origin.kind:"task-notification"`). It is internal harness
// metadata — not something the human typed — but it isn't flagged `isMeta:true`,
// so it survives @herdctl/core's parser and, exposed to us only as a plain
// `role:"user"` string, would otherwise render as a raw-XML user bubble
// (`<task-notification>…</task-notification>`). We detect it from its content and
// surface a subtle system-status line with the human-readable `<summary>` instead
// of the raw XML (issue #181). Detection is forgiving of leading whitespace.

/** True when a `role:"user"` message is an internal `<task-notification>` block. */
export function isTaskNotification(content: string): boolean {
  return content.trimStart().startsWith("<task-notification>");
}

/**
 * The human-readable one-line summary from a `<task-notification>` block (its
 * `<summary>…</summary>` text, e.g. `Agent "…" finished`). Falls back to a
 * generic label when the tag is absent or empty. See {@link isTaskNotification}.
 */
export function taskNotificationSummary(content: string): string {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(content);
  const summary = m?.[1]?.trim();
  return summary && summary.length > 0 ? summary : "Background agent updated";
}
