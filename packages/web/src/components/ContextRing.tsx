// A tiny circular context-window gauge for the chat list (issue #77).
//
// Mirrors the in-chat ContextMeter's math (pct = tokens / limit, amber at ≥80%)
// but renders as a small SVG donut so a chat's context fill reads at a glance
// next to its title. Renders nothing when a chat has no usage data yet, so the
// list stays clean for never-run chats.
//
// #115: the ring doubles as the "response in-flight" indicator. When `working`
// is set the donut *spins* (an indeterminate rotation) while keeping its
// context-fill arc, so it reads as "a spinner with a fill level". A streaming
// chat with no usage data yet (a brand-new chat) still renders — as a plain
// indeterminate spinner arc — so activity is visible before the first usage
// value arrives. This replaces the separate pulsing streaming dot.

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// The arc length shown when spinning without real usage data — a quarter turn
// reads clearly as a spinner rather than an empty ring.
const INDETERMINATE_DASH = 0.25 * CIRCUMFERENCE;

export function ContextRing({
  tokens,
  limit,
  size = 14,
  working = false,
}: {
  /** Context tokens used as of the last completed turn. */
  tokens?: number;
  /** The model's context-window size. */
  limit?: number;
  /** Rendered width/height in px (viewBox is fixed at 20×20). */
  size?: number;
  /** When the chat is streaming: spin the ring (keeping any fill arc). */
  working?: boolean;
}) {
  const hasUsage = tokens != null && limit != null && limit > 0;

  // Nothing to show only when the chat is idle *and* has no usage yet. A
  // streaming chat always renders so the row visibly indicates activity.
  if (!hasUsage && !working) return null;

  const pct = hasUsage ? Math.min(100, Math.max(0, (tokens! / limit!) * 100)) : 0;
  const warn = hasUsage && pct >= 80;
  const dash = hasUsage ? (pct / 100) * CIRCUMFERENCE : INDETERMINATE_DASH;

  const used = hasUsage ? Math.round(tokens! / 1000) : 0;
  const cap = hasUsage ? Math.round(limit! / 1000) : 0;

  const title = working
    ? hasUsage
      ? `Streaming a response… — context window ${Math.round(pct)}% full (${tokens!.toLocaleString()} / ${limit!.toLocaleString()} tokens)`
      : "Streaming a response…"
    : `Context window ${Math.round(pct)}% full as of the last completed turn (${tokens!.toLocaleString()} / ${limit!.toLocaleString()} tokens)`;

  const label = working
    ? hasUsage
      ? `Streaming a response… (context ${Math.round(pct)}% full)`
      : "Streaming a response…"
    : `Context ${Math.round(pct)}% full (${used}k of ${cap}k tokens)`;

  return (
    <span className="inline-flex shrink-0 items-center" title={title} aria-label={label}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        // Spin while working; otherwise render the static gauge with its arc
        // starting at 12 o'clock (-90°).
        className={working ? "animate-spin" : "-rotate-90"}
        role="img"
        aria-hidden="true"
      >
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          className="stroke-paddock-200 dark:stroke-paddock-700"
        />
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
          className={warn ? "stroke-amber-500" : "stroke-accent"}
        />
      </svg>
    </span>
  );
}
