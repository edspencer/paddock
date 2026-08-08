// The chat list's context gauge (issue #77) and streaming indicator (#115).
//
// `instrument` REPLACED THE DONUT WITH THE NUMBER. The export keeps its old name
// so no call site has to move, but it no longer draws a ring when idle — and the
// reason is the whole argument of this direction.
//
// The ring was a 14px SVG donut whose arc encoded context fill. Measured on a
// real chat list, the values in one column were 27%, 46%, 28%, 62%, 25%, 34% —
// and at 14px those arcs are indistinguishable from each other. It was a gauge
// too small to read its own value: it could tell you "nearly full" and nothing
// finer, while costing a whole column of visual noise on the app's densest
// screen. Fifteen near-identical circles reporting six different numbers.
//
// A right-aligned tabular percentage is less ink and strictly more information.
// It gives the coarse read for free (the eye catches the big numbers going down
// a column) AND the exact value, and it is the same grammar the fleet readout
// uses — a lamp for state, a tabular figure for the value. Numbers that align in
// columns without being asked is this direction's whole thesis; a column of
// unreadable donuts was the place it was least true.
//
// The one thing the SVG did that a number cannot is show ACTIVITY. So `working`
// keeps a mark of its own: a steady accent lamp, matching the fleet readout's
// channel lamp exactly. Steady, not spinning — the transcript is already
// streaming in beside it, and a second indeterminate animation on a list that
// can hold hundreds of rows is cost with no message.

import { formatSessionUsage, type SessionUsageParts } from "../lib/format";

/** Context fill at which the figure changes hue. Mirrors the composer's meter. */
const WARN_PCT = 80;
const DANGER_PCT = 92;

export function ContextRing({
  tokens,
  limit,
  usage,
  working = false,
}: {
  /** Context tokens used as of the last completed turn. */
  tokens?: number;
  /** The model's context-window size. */
  limit?: number;
  /**
   * The chat's cumulative token totals + cost (issue #152). When present, a
   * "session so far" line is appended to the tooltip. Absent for a never-run
   * chat or where the caller doesn't have it (e.g. the live streaming lamp).
   */
  usage?: SessionUsageParts;
  /**
   * Accepted and ignored. The old donut took a pixel size; a figure takes its
   * size from the type scale. Kept so call sites that still pass it compile.
   */
  size?: number;
  /** When the chat is streaming: show the activity lamp. */
  working?: boolean;
}) {
  const hasUsage = tokens != null && limit != null && limit > 0;

  // Nothing to show only when the chat is idle *and* has no usage yet — a
  // never-run chat stays clean, exactly as before.
  if (!hasUsage && !working) return null;

  const pct = hasUsage ? Math.min(100, Math.max(0, (tokens! / limit!) * 100)) : 0;
  const rounded = Math.round(pct);

  const used = hasUsage ? Math.round(tokens! / 1000) : 0;
  const cap = hasUsage ? Math.round(limit! / 1000) : 0;

  // Cumulative "session so far" line, appended to the idle tooltip when the
  // caller has the chat's totals (issue #152).
  const sessionLine = usage ? `\nSession so far: ${formatSessionUsage(usage)}` : "";

  const title = working
    ? hasUsage
      ? `Streaming a response… — context window ${rounded}% full (${tokens!.toLocaleString()} / ${limit!.toLocaleString()} tokens)`
      : "Streaming a response…"
    : `Context window ${rounded}% full as of the last completed turn (${tokens!.toLocaleString()} / ${limit!.toLocaleString()} tokens)${sessionLine}`;

  const label = working
    ? hasUsage
      ? `Streaming a response… (context ${rounded}% full)`
      : "Streaming a response…"
    : `Context ${rounded}% full (${used}k of ${cap}k tokens)`;

  const tone =
    rounded >= DANGER_PCT ? "text-danger" : rounded >= WARN_PCT ? "text-warn" : "text-fg-subtle";

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 leading-none"
      title={title}
      aria-label={label}
    >
      {working && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-accent-solid" aria-hidden="true" />
      )}
      {hasUsage && (
        // `text-right` + a fixed measure so a 7 and a 62 end on the same pixel:
        // the column is the point, not the individual figure.
        <span
          className={`w-[3.4ch] text-right font-mono tabular text-3xs ${tone}`}
          aria-hidden="true"
        >
          {rounded}%
        </span>
      )}
    </span>
  );
}
