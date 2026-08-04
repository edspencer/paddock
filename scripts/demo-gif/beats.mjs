/**
 * beats.mjs — the storyboard, and the single source of truth for it.
 *
 * Both shoot.mjs (what to capture) and build.mjs (how long to hold each frame)
 * read this list, so the two can never drift out of sync. Reordering the demo
 * means reordering this array and nothing else.
 *
 * `hold` is seconds on screen. Glance beats (a layout you take in at once) get
 * less; read beats (a diff, nested sub-agent steps) get more, because the viewer
 * is actually parsing text. `kind: "clip"` marks a beat backed by a recorded
 * screen capture rather than a still.
 *
 * ── What earns a place here ─────────────────────────────────────────────────
 * The reel should show what Paddock does that a terminal cannot, in roughly the
 * order you'd meet it. Deliberately NOT included, after being considered:
 *
 *  • The projects grid (`/projects`) — the sidebar carries "organised by
 *    project" in every other frame, so a whole beat restates it.
 *  • A static chat screenshot — the motion clip covers the same ground alive.
 *  • A `Read` of an inline PNG — the send_file beat shows richer media, and
 *    two "picture in a chat" beats is one too many.
 *  • Config, the OpenAPI/Swagger surface, voice input, slash commands, the New
 *    Project modal, star/unread toggles. All real; none worth ~2 seconds.
 */
export const BEATS = [
  {
    id: "home",
    hold: 1.8,
    caption: "Root Home — everything running or waiting, across every project",
  },
  {
    // The only moving beat. See recordClip() in shoot.mjs for why it is the only
    // one that runs without `reducedMotion`.
    id: "motion",
    kind: "clip",
    hold: 4.0,
    caption: "A turn, live: type, send, and watch Claude answer",
  },
  {
    id: "subagent",
    hold: 2.2,
    caption: "A finished sub-agent, expanded to its own nested steps",
  },
  {
    id: "diff",
    hold: 2.2,
    caption: "An Edit rendered as an inline red/green diff",
  },
  {
    id: "spawn",
    hold: 2.5,
    caption: "Claude opening its own chats — nested under their parent",
  },
  {
    id: "sendfile",
    hold: 2.5,
    caption: "Files rendered in the conversation: diagrams, documents, code",
  },
  {
    id: "fork",
    hold: 2.0,
    caption: "Fork from any message, or rewind the conversation to it",
  },
  {
    id: "triggers",
    hold: 1.9,
    caption: "Triggers — schedules and events that run an agent turn",
  },
  {
    id: "history",
    hold: 2.0,
    caption: "History — what ran while you were away",
  },
  {
    id: "changes",
    hold: 2.1,
    caption: "Changes — the real git diff, ready to commit and push",
  },
  {
    id: "mobile",
    hold: 2.1,
    caption: "The same instance from a phone",
  },
];

/** Crossfade length between consecutive beats, in seconds. */
export const XFADE = 0.3;

/** Total loop length implied by the storyboard. */
export function totalDuration(beats = BEATS, xfade = XFADE) {
  return beats.reduce((s, b) => s + b.hold, 0) - xfade * (beats.length - 1);
}
