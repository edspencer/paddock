#!/usr/bin/env node
/**
 * Generate `packages/web/src/styles/themes.css` from the four design-direction
 * worktrees.
 *
 * WHY THIS EXISTS. The four directions (`design/instrument`, `design/phosphor`,
 * `design/vellum`, `design/register`) each rewrote `tokens.css` and `index.css`
 * wholesale, so they cannot be merged with one another — the files conflict on
 * every line. But the *interesting* part of each direction is data, not code:
 * a set of semantic token values plus a font stack. This script lifts that data
 * out of each worktree and re-emits it as a selector block, so one build can
 * carry all four and switch between them at runtime.
 *
 * WHAT IS AND IS NOT EXTRACTED. Only `tokens.css` (colour + the non-colour
 * scales a direction re-cut there) and the `--font-*` stacks. A direction's
 * STRUCTURAL work — phosphor's rebuilt transcript, register's History pane,
 * instrument's fleet readout — is component code and is deliberately left
 * behind. A runtime theme is tokens + fonts; anything else is a different PR.
 *
 * THE CASCADE, which is the one subtle part. `tokens.css` declares `:root`
 * (light) then `.dark` (dark), both specificity (0,1,0), so `.dark` wins by
 * order. A naive `[data-theme="x"]` block would ALSO be (0,1,0) and, coming
 * later in the file, would beat `.dark` — i.e. picking a theme would silently
 * break dark mode. So each theme emits three blocks:
 *
 *   [data-theme="x"]            (0,1,0)  mode-independent: fonts, scales
 *   [data-theme="x"]:not(.dark) (0,2,0)  light colours
 *   [data-theme="x"].dark       (0,2,0)  dark colours
 *
 * The two colour blocks are mutually exclusive and both outrank `:root`/`.dark`,
 * so all 8 theme x mode combinations resolve unambiguously. (The base block
 * ties with `.dark` on specificity and comes later, but carries no colour, so
 * there is nothing for it to win.)
 *
 * The selectors are deliberately NOT prefixed with `html`: the same blocks then
 * work on any element, which is what lets the picker render a live swatch of a
 * theme it is not currently in — `<div data-theme="vellum" class="dark">` is a
 * real, correctly-cascaded scrap of that theme.
 *
 * The dark block is emitted as the direction's light values MERGED WITH its
 * dark ones, not just the dark ones. A direction's `.dark` block only restates
 * what differs from its own `:root`; if we emitted that alone, any token it
 * omits would fall through to *foundation's* dark value rather than to its own
 * light one, quietly mixing two directions together.
 *
 * Usage:  node scripts/build-themes.mjs [--check]
 *   --check  fail instead of writing if the output would change (for CI)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKTREES = resolve(REPO, "..");
const OUT = join(REPO, "packages/web/src/styles/themes.css");

/**
 * The registry. `fonts` is copied by hand from each direction's `@theme` block
 * in `index.css` (the only non-colour thing any of them changed there — see the
 * diff in the PR body); the matching `@font-face` rules live in `index.css` on
 * this branch, and are lazy, so declaring all four costs nothing until one is
 * actually rendered.
 */
const THEMES = [
  {
    // The foundation palette is already `:root`/`.dark` in tokens.css, so this
    // block is a duplicate — and deliberately so. It means every theme,
    // including the default, is addressable as `[data-theme="…"]`, which is
    // what lets the picker render all five previews the same way instead of
    // special-casing one of them.
    id: "foundation",
    label: "Foundation",
    blurb: "The neutral base — warm ground, terracotta accent.",
    worktree: "wt-design-themes",
    fonts: {
      "--font-sans":
        '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      "--font-display": "var(--font-sans)",
      "--font-mono": '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      "--font-prose": "var(--font-sans)",
    },
  },
  {
    id: "instrument",
    label: "Instrument",
    blurb: "Cool graphite and teal. Dense, technical, tabular.",
    worktree: "wt-design-instrument",
    fonts: {
      "--font-sans":
        '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      "--font-display": "var(--font-sans)",
      "--font-mono": '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
      "--font-prose": "var(--font-sans)",
    },
  },
  {
    id: "phosphor",
    label: "Phosphor",
    blurb: "Hued glass and a lit rose. A window onto a running process.",
    worktree: "wt-design-phosphor",
    fonts: {
      "--font-sans": '"Source Serif 4", Georgia, "Times New Roman", serif',
      "--font-display": "var(--font-sans)",
      "--font-mono": '"Spline Sans Mono", ui-monospace, SFMono-Regular, monospace',
      "--font-prose": "var(--font-sans)",
    },
  },
  {
    id: "vellum",
    label: "Vellum",
    blurb: "Warm paper and deep indigo. A well-made ledger.",
    worktree: "wt-design-vellum",
    fonts: {
      "--font-sans": '"Fira Sans", ui-sans-serif, system-ui, sans-serif',
      "--font-display": "var(--font-sans)",
      "--font-mono": '"Fira Mono", ui-monospace, SFMono-Regular, monospace',
      "--font-prose": '"Literata", ui-serif, Georgia, serif',
    },
  },
  {
    id: "register",
    label: "Register",
    blurb: "Pale sage and a Fraunces masthead. A system of record.",
    worktree: "wt-design-register",
    fonts: {
      "--font-sans":
        '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      "--font-display": '"Fraunces", "Instrument Sans", Georgia, serif',
      "--font-mono": '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      "--font-prose": "var(--font-sans)",
    },
  },
];

/** Strip comments, then pull out every top-level `<selector> { … }` block. */
function blocks(css, selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = new RegExp(`(^|\\})\\s*${selector.replace(".", "\\.")}\\s*\\{([^{}]*)\\}`, "g");
  let m;
  while ((m = re.exec(stripped)) !== null) out.push(m[2]);
  return out;
}

/** `--name: value;` declarations of a block body, in source order. */
function decls(body) {
  const out = [];
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const name = decl.slice(0, i).trim();
    if (!name.startsWith("--")) continue;
    out.push([name, decl.slice(i + 1).trim()]);
  }
  return out;
}

function emit(selector, pairs, note) {
  const lines = [`${selector} {`];
  if (note) lines.push(`  /* ${note} */`);
  for (const [k, v] of pairs) lines.push(`  ${k}: ${v};`);
  lines.push("}");
  return lines.join("\n");
}

const parts = [
  `/*
 * Runtime themes — GENERATED, do not hand-edit.
 *
 * Regenerate with \`node scripts/build-themes.mjs\`; the generator explains the
 * cascade rules and what is deliberately left behind. Each block below is one
 * design direction's token set, lifted out of its own worktree so all four can
 * ship in one build and be switched with a \`data-theme\` attribute on <html>.
 *
 * The default (no \`data-theme\`) is the foundation palette in tokens.css.
 *
 * These blocks outrank \`tokens.css\`'s \`:root\`/\`.dark\` on specificity, and the
 * light/dark split is by \`:not(.dark)\` / \`.dark\` rather than by source order,
 * so light and dark keep working WITHIN each theme — 8 combinations, all
 * unambiguous.
 */`,
];

const manifest = [];

for (const theme of THEMES) {
  const path = join(WORKTREES, theme.worktree, "packages/web/src/styles/tokens.css");
  if (!existsSync(path)) {
    console.error(`missing worktree for ${theme.id}: ${path}`);
    process.exit(1);
  }
  const css = readFileSync(path, "utf-8");
  const roots = blocks(css, ":root");
  const darks = blocks(css, ".dark");
  if (roots.length === 0 || darks.length !== 1) {
    console.error(`${theme.id}: expected one .dark and >=1 :root block`);
    process.exit(1);
  }

  const light = decls(roots[0]);
  // Trailing `:root` blocks are the non-colour scales (radius, type, --measure)
  // a direction re-cut; they are mode-independent by construction.
  const scales = roots.slice(1).flatMap(decls);
  const dark = decls(darks[0]);

  // Merge light under dark so the dark block is self-contained (see header).
  const merged = new Map(light);
  for (const [k, v] of dark) merged.set(k, v);

  parts.push(`
/* ============================================================ ${theme.id} ==
 * ${theme.blurb}
 * Extracted from ${theme.worktree}.
 */`);
  parts.push(
    emit(
      `[data-theme="${theme.id}"]`,
      [...Object.entries(theme.fonts), ...scales],
      "fonts and non-colour scales — the same in both modes",
    ),
  );
  parts.push(emit(`[data-theme="${theme.id}"]:not(.dark)`, light, "light"));
  parts.push(emit(`[data-theme="${theme.id}"].dark`, [...merged], "dark"));

  manifest.push({ id: theme.id, light: light.length, dark: merged.size, scales: scales.length });
}

const out = parts.join("\n") + "\n";

if (process.argv.includes("--check")) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf-8") : "";
  if (cur !== out) {
    console.error("themes.css is stale — run `node scripts/build-themes.mjs`");
    process.exit(1);
  }
  console.log("themes.css is up to date");
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
  for (const m of manifest) {
    console.log(`  ${m.id.padEnd(11)} ${m.light} light · ${m.dark} dark · ${m.scales} scale`);
  }
}
