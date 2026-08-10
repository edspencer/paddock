/**
 * The contrast guard, for every RUNTIME THEME.
 *
 * ## The hole this closes
 *
 * `tokens.test.ts` parses `tokens.css`, so it certifies exactly one palette:
 * the foundation defaults at `:root` / `.dark`. Every runtime theme replaces
 * those values behind a `[data-theme="…"]` selector that guard never reads — so
 * for as long as the picker has existed, every theme but the base was
 * uncertified.
 *
 * This walks the REGISTRY rather than a hard-coded list, so a new theme is
 * covered the moment someone adds it to `THEMES` — and a theme added to the
 * registry with no CSS behind it fails here rather than rendering as the
 * foundation palette and looking merely disappointing.
 *
 * ## What it asserts
 *
 * The same contract `tokens.test.ts` holds for the foundation palette, applied
 * to each theme in both modes: every text rung on every surface it may legally
 * sit on, every status hue as text and as a fill, the accent, `--border-strong`
 * as a control boundary, an ordered surface ladder, and sRGB containment.
 *
 * ## How a theme's values are reconstructed
 *
 * Exactly as the cascade produces them, or the numbers would be fiction:
 *
 *   light = tokens.css `:root`  +  `[data-theme=X]`  +  `[data-theme=X]:not(.dark)`
 *   dark  = tokens.css `.dark`  +  `[data-theme=X]`  +  `[data-theme=X].dark`
 *
 * The foundation layer underneath is not decoration: a theme block only has to
 * declare what it changes, and anything it omits genuinely falls through to
 * `:root` / `.dark`. Dropping that base would test a theme against tokens that
 * do not exist; including it is what makes a partial theme legal AND checked.
 *
 * The three per-theme files (`theme-<id>.test.ts`) stay: each carries
 * assertions about what its own theme does differently — a fill that carries
 * dark type, chrome that must not swallow its own border — which are not part
 * of this shared contract. Their overlap with this file is a few duplicated
 * `expect`s and is not worth surgery to remove.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, inSrgbGamut, parseTokenCss, resolveColor, toHex } from "../lib/color";
import { THEMES } from "../lib/appearance";

const SRC = resolve(process.cwd(), "src");
const read = (f: string) => readFileSync(join(SRC, "styles", f), "utf-8");

/** The foundation palette, which every theme block layers on top of. */
const FOUNDATION = parseTokenCss(read("tokens.css"));

/**
 * Every stylesheet a theme block might live in — one per registered theme.
 * Concatenated because a block is found by its selector, and a selector is
 * unique across all of them.
 *
 * A registered theme whose file is missing is NOT skipped here: it falls
 * through to the `themeVars` assertion below, which names it. Silently
 * tolerating an absent file is exactly the failure this guard exists to catch.
 */
const ALL_CSS = THEMES.map((t) => `theme-${t.id}.css`)
  .filter((f) => {
    try {
      read(f);
      return true;
    } catch {
      return false;
    }
  })
  .map(read)
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Custom-property declarations of the block with this exact selector.
 *
 * Matched literally rather than through `parseTokenCss`, whose regex is built
 * from a selector name and does not survive brackets, quotes or `:not()`.
 * Returns null for a selector that is not present, which is a legal state —
 * a theme may carry no mode-independent block.
 */
function block(selector: string): Record<string, string> | null {
  const open = `${selector} {`;
  const at = ALL_CSS.indexOf(open);
  if (at === -1) return null;
  const body = ALL_CSS.slice(at + open.length, ALL_CSS.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const name = decl.slice(0, i).trim();
    if (name.startsWith("--")) out[name] = decl.slice(i + 1).trim();
  }
  return out;
}

function themeVars(id: string, mode: "light" | "dark"): Record<string, string> {
  const base = block(`[data-theme="${id}"]`) ?? {};
  const scoped =
    mode === "light"
      ? block(`[data-theme="${id}"]:not(.dark)`)
      : block(`[data-theme="${id}"].dark`);
  expect(scoped, `no ${mode} block for theme "${id}" — is it in the registry but not in CSS?`).not
    .toBeNull();
  return { ...FOUNDATION[mode], ...base, ...scoped };
}

/** Surfaces any body text may legally sit on. */
const SURFACES = [
  "--surface",
  "--surface-raised",
  "--surface-sunken",
  "--surface-hover",
  "--surface-active",
  "--surface-selected",
] as const;

/** Foregrounds that must be readable on every one of those. */
const FOREGROUNDS = ["--text", "--text-muted", "--text-subtle", "--accent-text"] as const;

const HUES = ["success", "warn", "danger", "info", "lineage"] as const;

/** WCAG 2 AA: 4.5:1 for body text, 3:1 for large text and non-text boundaries. */
const AA_BODY = 4.5;
const AA_LARGE = 3;

const CASES = THEMES.flatMap((t) =>
  (["light", "dark"] as const).map((mode) => [t.id, mode] as const),
);

describe.each(CASES)("%s — %s", (id, mode) => {
  const vars = themeVars(id, mode);
  const at = (name: string) => resolveColor(`var(${name})`, vars);
  const ratio = (fg: string, bg: string) => contrastRatio(at(fg), at(bg));
  // The label carries the hexes so a failure says WHICH colours, not just that
  // a number was too small.
  const label = (fg: string, bg: string) =>
    `${fg} (${toHex(at(fg))}) on ${bg} (${toHex(at(bg))}) = ${ratio(fg, bg).toFixed(2)}:1`;

  it.each(FOREGROUNDS.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))(
    "%s on %s clears 4.5:1",
    (fg, bg) => {
      expect(ratio(fg, bg), label(fg, bg)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(HUES)("%s reads on every surface it is used on", (hue) => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken", `--${hue}-soft`]) {
      expect(ratio(`--${hue}-text`, bg), label(`--${hue}-text`, bg)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it.each(HUES)("%s foreground reads on its own solid fill", (hue) => {
    expect(
      ratio(`--${hue}-fg`, `--${hue}-solid`),
      label(`--${hue}-fg`, `--${hue}-solid`),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("accent foreground reads on the accent fill", () => {
    expect(
      ratio("--accent-fg", "--accent-solid"),
      label("--accent-fg", "--accent-solid"),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  // The pairing this guard was missing, and it cost a real regression: every
  // check above reads a fill in its RESTING state, so a hover fill could drift
  // anywhere and nothing noticed. Foundation's dark hover had gone to the raw
  // accent — 5.53:1 resting, 4.17:1 hovered — i.e. the most-clicked control in
  // the app fell below AA at exactly the moment the pointer was on it.
  //
  // Two assertions, not one, because they fail for different reasons. AA is the
  // floor and is non-negotiable. "Hover does not LOSE contrast" is the craft
  // rule (hover should increase it) stated as the weakest form worth enforcing:
  // a theme may legitimately hold contrast flat and move the border or the
  // shadow instead, but a hover that reads as less legible than rest is always
  // a mistake, whatever the theme intended.
  it("accent foreground reads on the HOVERED accent fill", () => {
    expect(
      ratio("--accent-fg", "--accent-solid-hover"),
      label("--accent-fg", "--accent-solid-hover"),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("hovering the accent fill does not reduce its contrast", () => {
    const rest = ratio("--accent-fg", "--accent-solid");
    const hover = ratio("--accent-fg", "--accent-solid-hover");
    expect(
      hover,
      `hover ${label("--accent-fg", "--accent-solid-hover")} must not be below ` +
        `rest ${label("--accent-fg", "--accent-solid")}`,
    ).toBeGreaterThanOrEqual(rest);
  });

  it("border-strong is a visible control boundary (3:1) on every surface", () => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken"]) {
      expect(
        ratio("--border-strong", bg),
        label("--border-strong", bg),
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it("the surface ladder is ordered and separable", () => {
    // Adjacent surfaces are deliberately close — they are separated by a border
    // and a shadow, not by brightness — but must not be identical, or "raised"
    // stops meaning anything.
    expect(contrastRatio(at("--surface-raised"), at("--surface"))).toBeGreaterThan(1.02);
    expect(contrastRatio(at("--surface-sunken"), at("--surface"))).toBeGreaterThan(1.02);
  });

  // The prose roles. See the long note in `tokens.test.ts`: the inline-code
  // well used to borrow `--surface-active`, and foundation's dark prose card
  // rose to within 1.036:1 of it. Held per theme too, because the borrowing was
  // shared and so is the way it breaks — three of the four themes still alias
  // these back to the ladders, so this is the assertion that notices if one of
  // THEIR surfaces moves next.
  it("the inline-code well is visible on the prose card", () => {
    expect(
      ratio("--code-fill", "--surface-raised"),
      label("--code-fill", "--surface-raised"),
    ).toBeGreaterThanOrEqual(1.15);
  });

  it("code inside that well is readable", () => {
    expect(ratio("--text", "--code-fill"), label("--text", "--code-fill")).toBeGreaterThanOrEqual(
      AA_BODY,
    );
  });

  it("blockquote text reads on every surface prose sits on", () => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken"]) {
      expect(ratio("--quote-text", bg), label("--quote-text", bg)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it("every oklch() token is inside the sRGB gamut", () => {
    const bad: string[] = [];
    for (const [name, value] of Object.entries(vars)) {
      const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
      if (!m) continue;
      if (!inSrgbGamut(Number(m[1]), Number(m[2]), Number(m[3]))) bad.push(`${name}: ${value}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("the registry and the stylesheets agree", () => {
  it("every registered theme has both mode blocks", () => {
    const missing = THEMES.flatMap((t) =>
      [
        block(`[data-theme="${t.id}"]:not(.dark)`) ? null : `${t.id}: light`,
        block(`[data-theme="${t.id}"].dark`) ? null : `${t.id}: dark`,
      ].filter((x): x is string => x !== null),
    );
    expect(missing).toEqual([]);
  });

  it("every theme block in CSS is a registered theme", () => {
    // The other direction: a theme whose CSS ships but whose registry entry was
    // forgotten is unreachable from the picker and would never be noticed.
    const ids = new Set(THEMES.map((t) => t.id as string));
    const orphans = [...ALL_CSS.matchAll(/\[data-theme="([a-z-]+)"\]/g)]
      .map((m) => m[1])
      .filter((id) => !ids.has(id));
    expect([...new Set(orphans)]).toEqual([]);
  });
});
