/**
 * fixtures.mjs — the synthetic world the demo is shot in.
 *
 * EVERYTHING HERE IS INVENTED. No production data, no real repositories, no
 * credentials, no customer names. That is a hard constraint, not a nicety: the
 * output of this pipeline is published on a marketing page and in the README.
 * If you extend these fixtures, keep them fictional.
 *
 * The cast is a plausible homelab/side-project setup — enough projects to fill
 * the sidebar and the grid, one project ("Lumen CLI", a terminal colour-theme
 * generator) deep enough to carry the transcript beats.
 */

export const ROOT_WORKSPACE = {
  name: "Workshop",
  status: "active",
  summary: "The instance root — quick one-off chats and everything not yet a project.",
  overview: [
    "# Workshop",
    "",
    "The root workspace. Anything that doesn't belong to a project yet starts",
    "here: one-off questions, scratch investigations, and the odd job that only",
    "needs doing once.",
    "",
    "Projects graduate out of here once they earn a directory of their own.",
  ].join("\n"),
  changelog: [
    "# Changelog — Workshop",
    "",
    "## This week",
    "- Moved the tile-packing notes into Trail Atlas now that it's a real project.",
    "- Drafted the Lumen CLI 0.9.2 release note.",
  ].join("\n"),
};

export const PROJECTS = [
  {
    slug: "lumen-cli",
    name: "Lumen CLI",
    status: "active",
    group: "side-projects",
    domain: ["tooling", "terminal"],
    started: "2026-05-02",
    summary:
      "A tiny terminal colour-theme generator: one seed colour in, a balanced 16-colour theme out.",
    // Repo-backed so the Changes tab has a real diff to render.
    git: true,
    model: "claude-opus-5",
    files: {
      "README.md": [
        "# Lumen",
        "",
        "> One seed colour in, a whole terminal theme out.",
        "",
        "```sh",
        "lumen --seed '#c2603c' --format sh > theme.sh",
        "```",
        "",
        "## Features",
        "",
        "- Truecolor (24-bit) output with a 256-colour fallback.",
        "- WCAG AA contrast checking on every foreground/background pair.",
        "- A preview grid for the generated palette.",
        "",
      ].join("\n"),
      "OVERVIEW.md": [
        "# Lumen CLI — Overview",
        "",
        "Lumen turns a single seed colour into a balanced 16-colour terminal theme",
        "and emits it for your shell, editor, or `tmux`. It targets truecolor",
        "terminals and degrades gracefully to the 256-colour cube when truecolor",
        "isn't available.",
        "",
        "## Current state",
        "",
        "- `src/render.ts` emits ANSI escapes; the truecolor path is stable.",
        "- The 256-colour fallback landed this week (nearest-cube quantiser).",
        "- Contrast is checked against WCAG AA (4.5:1) for every pair.",
        "",
        "## Next",
        "",
        "- Ship the `--preview` grid as a PNG for the docs.",
        "- Add a `--format tmux` writer.",
      ].join("\n"),
      "CHANGELOG.md": [
        "# Changelog — Lumen CLI",
        "",
        "## 0.9.2",
        "",
        "- Added a 256-colour fallback for terminals without truecolor.",
        "- Verified WCAG AA contrast on the default palette.",
        "- Fixed a rounding bug in the contrast ratio calculation.",
      ].join("\n"),
    },
    triggers: {
      "nightly-triage": {
        trigger: { type: "schedule", cron: "0 7 * * *" },
        run: {
          promptFile: "nightly-triage.md",
          session: "new",
          tools: ["Read", "Glob", "Grep", "WebFetch"],
          maxTurns: 30,
        },
        enabled: true,
      },
      "release-digest": {
        trigger: { type: "schedule", cron: "0 9 * * 1" },
        run: {
          promptFile: "release-digest.md",
          session: "new",
          tools: ["Read", "Glob", "Grep", "Write"],
          maxTurns: 20,
        },
        enabled: true,
      },
      // An event trigger's field is `on`, and its value must be one of the known
      // TRIGGER_EVENTS ("onArchive" | "afterTurn") — anything else fails schema
      // validation and the trigger is dropped from the table SILENTLY.
      "archive-note": {
        trigger: { type: "event", on: "onArchive" },
        run: {
          prompt: "Note the archived chat's outcome in CHANGELOG.md.",
          session: "new",
          tools: ["Read", "Write"],
        },
        enabled: false,
      },
    },
    triggerPrompts: {
      "nightly-triage.md": [
        "# Nightly triage",
        "",
        "Check for issues opened in the last 24 hours. Label each one by area",
        "(`render`, `contrast`, `cli`, `docs`), and post a two-line summary of",
        "anything that looks like a regression.",
      ].join("\n"),
      "release-digest.md": [
        "# Weekly release digest",
        "",
        "Summarise the last 7 days of CHANGELOG.md entries into a short digest",
        "suitable for the release notes. Keep it to five bullets.",
      ].join("\n"),
    },
  },
  {
    slug: "trail-atlas",
    name: "Trail Atlas",
    status: "active",
    group: "side-projects",
    domain: ["maps", "outdoors"],
    started: "2026-01-20",
    summary: "Offline topographic maps and elevation profiles for backcountry hikes.",
    files: {
      "OVERVIEW.md": [
        "# Trail Atlas",
        "",
        "Packs vector tiles and elevation data into offline bundles you can carry",
        "into places with no signal. Zoom 10–14 keeps a corridor under 60 MB.",
      ].join("\n"),
    },
  },
  {
    slug: "ledger-lite",
    name: "Ledger Lite",
    status: "idea",
    group: "side-projects",
    domain: ["finance"],
    started: "2026-06-28",
    summary: "A single-file plain-text accounting helper with monthly rollups.",
    files: {
      "OVERVIEW.md": "# Ledger Lite\n\nPlain-text accounting, one file, monthly rollups.\n",
    },
  },
  {
    slug: "beacon",
    name: "Beacon",
    status: "active",
    group: "homelab",
    domain: ["monitoring"],
    started: "2026-02-09",
    summary: "Uptime checks and a public status page for everything self-hosted here.",
    files: {
      "OVERVIEW.md": [
        "# Beacon",
        "",
        "Probes each service every 30s from two vantage points and publishes a",
        "status page. Alerts only after two consecutive failures, which is what",
        "stopped the 3am pages.",
      ].join("\n"),
    },
  },
  {
    slug: "tapedeck",
    name: "Tapedeck",
    status: "active",
    group: "homelab",
    domain: ["backups"],
    started: "2026-04-02",
    summary: "Offsite backup orchestration, with restore drills that actually get run.",
    files: {
      "OVERVIEW.md": [
        "# Tapedeck",
        "",
        "Nightly snapshots to two destinations, and a monthly restore drill that",
        "fails loudly if a dataset can't be brought back.",
      ].join("\n"),
    },
  },
  {
    slug: "switchboard",
    name: "Switchboard",
    status: "paused",
    group: "homelab",
    domain: ["networking"],
    started: "2026-03-18",
    summary: "DNS, reverse-proxy routes, and certificate renewal in one place.",
    files: {
      "OVERVIEW.md": "# Switchboard\n\nInternal DNS, proxy routes, and cert renewal.\n",
    },
  },
];

/**
 * `src/render.ts` in two states: the committed baseline (truecolor only) and the
 * working-tree version (with the 256-colour fallback). The difference is what
 * the Changes tab renders as an uncommitted diff, and it is deliberately the
 * SAME change the seeded chat's Edit block shows — so the two beats corroborate
 * each other instead of telling unrelated stories.
 */
export const RENDER_TS_BASELINE = `import type { RGB, Layer } from "./types.js";

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

/** Emit the ANSI escape that sets \`rgb\` on the given layer. */
export function emitColor(rgb: RGB, layer: Layer): string {
  const [r, g, b] = rgb;
  // 24-bit truecolor only
  const lead = layer === "fg" ? 38 : 48;
  return \`\\x1b[\${lead};2;\${r};\${g};\${b}m\`;
}

export function reset(): string {
  return "\\x1b[0m";
}
`;

export const RENDER_TS_WORKING = `import type { RGB, Layer } from "./types.js";

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

/** Emit the ANSI escape that sets \`rgb\` on the given layer. */
export function emitColor(rgb: RGB, layer: Layer): string {
  const [r, g, b] = rgb;
  const lead = layer === "fg" ? 38 : 48;
  if (supportsTruecolor()) {
    return \`\\x1b[\${lead};2;\${r};\${g};\${b}m\`;
  }
  // 256-colour fallback: quantise to the nearest 6x6x6 cube entry.
  const idx = 16 + 36 * cubeChannel(r) + 6 * cubeChannel(g) + cubeChannel(b);
  return \`\\x1b[\${lead};5;\${idx}m\`;
}

/** Nearest 6-step cube channel (0..5) for one 8-bit colour component. */
function cubeChannel(v: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_STEPS.length; i++) {
    if (Math.abs(CUBE_STEPS[i] - v) < Math.abs(CUBE_STEPS[best] - v)) best = i;
  }
  return best;
}

function supportsTruecolor(): boolean {
  return process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";
}

export function reset(): string {
  return "\\x1b[0m";
}
`;

/** The hunks shown by the Edit tool block — the same change as above. */
export const RENDER_TS_HUNKS = [
  {
    oldStart: 5,
    oldLines: 8,
    newStart: 5,
    newLines: 14,
    lines: [
      " /** Emit the ANSI escape that sets `rgb` on the given layer. */",
      " export function emitColor(rgb: RGB, layer: Layer): string {",
      "   const [r, g, b] = rgb;",
      "-  // 24-bit truecolor only",
      "-  const lead = layer === \"fg\" ? 38 : 48;",
      "-  return `\\x1b[${lead};2;${r};${g};${b}m`;",
      "+  const lead = layer === \"fg\" ? 38 : 48;",
      "+  if (supportsTruecolor()) {",
      "+    return `\\x1b[${lead};2;${r};${g};${b}m`;",
      "+  }",
      "+  // 256-colour fallback: quantise to the nearest 6x6x6 cube entry.",
      "+  const idx = 16 + 36 * cubeChannel(r) + 6 * cubeChannel(g) + cubeChannel(b);",
      "+  return `\\x1b[${lead};5;${idx}m`;",
      " }",
    ],
  },
  {
    oldStart: 13,
    oldLines: 3,
    newStart: 19,
    newLines: 16,
    lines: [
      " ",
      "+/** Nearest 6-step cube channel (0..5) for one 8-bit colour component. */",
      "+function cubeChannel(v: number): number {",
      "+  let best = 0;",
      "+  for (let i = 1; i < CUBE_STEPS.length; i++) {",
      "+    if (Math.abs(CUBE_STEPS[i] - v) < Math.abs(CUBE_STEPS[best] - v)) best = i;",
      "+  }",
      "+  return best;",
      "+}",
      "+",
      "+function supportsTruecolor(): boolean {",
      "+  return process.env.COLORTERM === \"truecolor\" || process.env.COLORTERM === \"24bit\";",
      "+}",
      "+",
      " export function reset(): string {",
      "   return \"\\x1b[0m\";",
      " }",
    ],
  },
];

/**
 * Replies for the fake `claude` binary, keyed by prompt. Used for the live turns
 * the shoot drives (see shoot.mjs) so even those are deterministic prose rather
 * than whatever a real model would say.
 */
export const FAKE_SCRIPT = {
  // Typed on camera in the motion beat. The key must match the prompt
  // `shoot.mjs` types EXACTLY — the fake binary looks replies up by whole-prompt
  // equality, and a miss makes it echo the prompt back instead.
  "Add a --no-truecolor flag for the tests.":
    "Added. `--no-truecolor` sets the same internal flag `COLORTERM` detection would, so the 256-colour path is exercised end to end rather than stubbed.\n\nIt's deliberately not the inverse of a `--truecolor` flag — forcing truecolor ON in a terminal that can't render it produces garbage, and there's no test worth writing for that.",
  "Why is the follow reconnect storming?":
    "It's a fixed retry with no jitter.\n\n`--follow` reconnects on a flat 1s timer, so when the log endpoint drops every client comes back in the same tick and the server sees a synchronised thundering herd. Under a rolling restart that's ~200 reconnects landing inside the same second.\n\nThe fix is exponential backoff with full jitter — `min(cap, base * 2^n)` multiplied by a random factor in [0,1). That spreads the retries and costs nothing when the endpoint is healthy, since the first retry still fires at ~1s.",
  "Pack a tile bundle for the north corridor and tell me how big it comes out.":
    "Packed — 54.8 MB for the north corridor.\n\nThat's zoom 10–14 over a 40-mile strip, 3,812 tiles, WebP at quality 82. Zoom 15 would add another 190 MB, which isn't worth it for a trail map: at z14 the path is already legible and the elevation overlay carries the detail that matters.",
};

/**
 * The two files Claude hands over in the send_file beat.
 *
 * Deliberately a diagram and a document rather than the fuller set of renderers
 * (code / PDF / video) that also exist: dark-mode syntax highlighting is very
 * low-contrast and reads as monochrome once quantised to a GIF palette, a PDF
 * renders as Chromium's grey viewer chrome, and a video is a black rectangle in
 * a still frame. These two photograph well and carry the same point.
 */
export const SENT_DIAGRAM = [
  // Sized on purpose. A tall top-down chart renders at natural size and
  // overflows the card; a long left-right one scales down to fit the width
  // and takes its labels with it. This shape lands around 900x400, which
  // fills the card at full size and still leaves the document below visible.
  "flowchart LR",
  "  A[seed colour] --> B[buildPalette]",
  "  B --> C{clears AA?}",
  "  C -->|no| D[nudge lightness]",
  "  D --> B",
  "  C -->|yes| E[emitColor]",
  "  E --> F{{truecolor?}}",
  "  F -->|yes| G[24-bit escape]",
  "  F -->|no| H[nearest cube entry]",
].join("\n");

export const SENT_DOC = [
  "# How a seed colour becomes a theme",
  "",
  "One colour in, sixteen out. The pipeline is deliberately linear so any step",
  "can be replaced without touching the others.",
  "",
  "## The rules that never bend",
  "",
  "1. **Contrast wins over fidelity.** If a generated pair misses WCAG AA the",
  "   lightness is nudged and the palette is rebuilt — the hue is never changed",
  "   to fix contrast, because that is what makes a theme stop looking like the",
  "   colour you asked for.",
  "2. **The fallback is a rendering concern, not a palette one.** Quantising to",
  "   the 6x6x6 cube happens in `emitColor`, after contrast has been verified,",
  "   so both colour paths are guaranteed to have cleared the same checks.",
  "3. **Order is stable.** Swatches are always emitted in ANSI order, so a theme",
  "   regenerated from the same seed is byte-identical.",
  "",
  "## What is still open",
  "",
  "- A `--format tmux` writer.",
  "- Whether AAA should be opt-in or the default for the bright variants.",
].join("\n");
