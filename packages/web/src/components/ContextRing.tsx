// A tiny circular context-window gauge for the chat list (issue #77).
//
// Mirrors the in-chat ContextMeter's math (pct = tokens / limit, amber at ≥80%)
// but renders as a small SVG donut so a chat's context fill reads at a glance
// next to its title. Renders nothing when a chat has no usage data yet, so the
// list stays clean for never-run chats.

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextRing({
  tokens,
  limit,
  size = 14,
}: {
  /** Context tokens used as of the last completed turn. */
  tokens?: number;
  /** The model's context-window size. */
  limit?: number;
  /** Rendered width/height in px (viewBox is fixed at 20×20). */
  size?: number;
}) {
  if (tokens == null || limit == null || limit <= 0) return null;

  const pct = Math.min(100, Math.max(0, (tokens / limit) * 100));
  const warn = pct >= 80;
  const used = Math.round(tokens / 1000);
  const cap = Math.round(limit / 1000);
  const dash = (pct / 100) * CIRCUMFERENCE;

  return (
    <span
      className="inline-flex shrink-0 items-center"
      title={`Context window ${Math.round(pct)}% full as of the last completed turn (${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens)`}
      aria-label={`Context ${Math.round(pct)}% full (${used}k of ${cap}k tokens)`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        className="-rotate-90"
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
