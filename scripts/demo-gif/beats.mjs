/**
 * beats.mjs — the storyboard, and the single source of truth for it.
 *
 * Both shoot.mjs (what to capture) and build.mjs (how long to hold each frame)
 * read this list, so the two can never drift out of sync. Reordering the demo
 * means reordering this array and nothing else.
 *
 * `hold` is seconds on screen. Glance beats (a layout you take in at once) get
 * less; read beats (a diff, nested sub-agent steps) get more, because the viewer
 * is actually parsing text.
 */
export const BEATS = [
  {
    id: "home",
    hold: 1.9,
    caption: "Root Home — everything running or waiting, across every project",
  },
  {
    id: "projects",
    hold: 1.9,
    caption: "Projects grid — each project a directory with its own agent",
  },
  {
    id: "chat",
    hold: 2.2,
    caption: "A chat: streamed reply, collapsed tool calls, live context + cost",
  },
  {
    id: "subagent",
    hold: 2.4,
    caption: "A finished sub-agent, expanded to its own nested steps",
  },
  {
    id: "diff",
    hold: 2.4,
    caption: "An Edit rendered as an inline red/green diff",
  },
  {
    id: "image",
    hold: 2.1,
    caption: "A Read of a PNG rendered inline",
  },
  {
    id: "triggers",
    hold: 2.1,
    caption: "Triggers — schedules and events that run an agent turn",
  },
  {
    id: "changes",
    hold: 2.3,
    caption: "Changes — the real git diff, ready to commit and push",
  },
];

/** Crossfade length between consecutive beats, in seconds. */
export const XFADE = 0.3;

/** Total loop length implied by the storyboard. */
export function totalDuration(beats = BEATS, xfade = XFADE) {
  return beats.reduce((s, b) => s + b.hold, 0) - xfade * (beats.length - 1);
}
