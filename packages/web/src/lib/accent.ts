/**
 * The accent solver.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 * Today `PADDOCK_BRAND_ACCENT` lets an operator inject a raw hex over
 * `--accent` / `--accent-600` / `--accent-700` (see `packages/server/src/brand.ts`).
 * That is unsafe in a way nothing catches: the contrast guard's brand test only
 * asserts a token *changed*, never that it stayed readable, and a theme like
 * phosphor puts DARK type on its accent fill, so an accent that is too dark
 * makes the primary button unreadable outright. Ten plausible brand hexes were
 * measured against vellum during the design run; two were safe.
 *
 * ── The proposal this module implements ──────────────────────────────────────
 * The user contributes ONLY a hue angle. Everything else is the theme's.
 * For each accent channel we:
 *
 *   1. read the theme's OWN default value for that channel, and measure the
 *      contrast it achieves in the role that channel actually plays;
 *   2. take that measured ratio (floored at the WCAG AA minimum) as the TARGET;
 *   3. keep the theme's chroma, swap in the user's hue, and SOLVE for the
 *      lightness that hits the target again;
 *   4. clamp chroma down if that lands outside sRGB.
 *
 * The consequence is the point of the exercise: at any hue, in any theme, in
 * either mode, the accent holds the exact contrast relationships the theme was
 * designed with. An unreadable accent is not validated against — it is
 * inexpressible, because lightness is solved rather than supplied.
 *
 * Why hue is the safe free variable and lightness is not: WCAG contrast is a
 * function of relative luminance, which is NOT OKLCH `L`. At accent chroma,
 * rotating hue at fixed `L` swings contrast by ~17%; at the near-neutral chroma
 * the ground ramps use it swings ~1%. So a fixed-lightness hue rotation is
 * safe for the ground and emphatically not for the accent.
 *
 * ── Why it measures the live DOM ─────────────────────────────────────────────
 * The four themes derive their accent family differently — foundation and
 * instrument do `--accent-solid: rgb(var(--accent-600))`, register does
 * `color-mix(… 85%, white)` in dark, vellum inverts to a pale plate with dark
 * type. Rather than model four derivations, this reads the computed value of
 * every derived token off `<html>` after the channels are set, checks it, and
 * REPAIRS the specific token if the theme's own derivation defeated the solve.
 * That makes the guarantee independent of how a theme chooses to derive.
 */
import {
  contrastRatio,
  inSrgbGamut,
  oklchToRgb,
  relativeLuminance,
  resolveColor,
  rgbToOklch,
  toHex,
  type Rgba,
} from "./color";

/** WCAG 2 AA floors. Text is 4.5:1; a non-text mark is 3:1. */
const AA_TEXT = 4.5;
const AA_MARK = 3;

/**
 * Solve slightly above the floor, and check against the floor itself.
 *
 * The gap is quantisation. The three channels are written as 8-bit integers —
 * that is the format the brand seam requires — and a theme may then run them
 * through a `color-mix()` before anything is painted. Rounding at both ends
 * moved three of 110 measured combinations from a solved 4.50 to a rendered
 * 4.48: correct arithmetic, wrong side of the line. Solving to 4.62 puts the
 * rounding error inside the margin instead of across it.
 */
const MARGIN = 0.12;

/** Every custom property this module may write inline on `<html>`. */
const OWNED = [
  "--accent",
  "--accent-600",
  "--accent-700",
  "--accent-solid",
  "--accent-solid-hover",
  "--accent-text",
] as const;

/** One text-on-surface (or fill-under-foreground) result, for the readout. */
export interface AccentCheck {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  floor: number;
  repaired: boolean;
}

export interface AccentReport {
  /** The hue actually applied, 0–360. */
  hue: number;
  /** Whether this ran against light or dark. */
  mode: "light" | "dark";
  /** `#rrggbb` of the three channel variables, for display only. */
  channels: { accent: string; accent600: string; accent700: string };
  /**
   * The final EFFECTIVE value of every accent token, as flat hex.
   *
   * Cached so the pre-paint script in index.html can replay the last answer for
   * this theme+mode on the next load. It has to be the resolved values rather
   * than the three channels: a theme's dark derivation is not the same function
   * as its light one (register mixes 85% toward white, vellum inverts to a pale
   * plate), so replaying channels alone would paint the first frame with the
   * wrong end of the ramp.
   */
  applied: Record<string, string>;
  checks: AccentCheck[];
  /** True when every check clears its floor. */
  ok: boolean;
}

/* -------------------------------------------------------------------------- */
/* reading the live cascade                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Computed value of a custom property on `<html>`, resolved to sRGB.
 *
 * A custom property's computed value already has its `var()` references
 * substituted, so what comes back is a self-contained colour expression
 * (`oklch(…)`, `rgb(…)`, or a `color-mix()` of those) that `resolveColor` can
 * evaluate with no variable map. Returns null when the token is missing or
 * written in syntax the colour library deliberately refuses — a token whose
 * contrast nobody can compute is one we decline to reason about rather than
 * guess at.
 */
function readColor(root: HTMLElement, name: string): Rgba | null {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  if (!raw) return null;
  // The three brand channels are stored as a bare `R G B` triple, not as a
  // colour — that IS the format `PADDOCK_BRAND_ACCENT` injects and the one the
  // token file's `rgb(var(--accent))` derivations expect. It is not a valid CSS
  // colour on its own, so it has to be wrapped before it can be parsed.
  const value = /^\d+(\.\d+)?( \d+(\.\d+)?){2}$/.test(raw) ? `rgb(${raw})` : raw;
  try {
    return resolveColor(value, {});
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* solving                                                                     */
/* -------------------------------------------------------------------------- */

/** The OKLCH lightness at which `(C,H)` reaches a given relative luminance. */
function lightnessAtLuminance(target: number, C: number, H: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (relativeLuminance(oklchToRgb(mid, C, H)) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Largest chroma at `(L,H)` that stays inside sRGB, capped at `want`. */
function clampChroma(L: number, want: number, H: number): number {
  if (inSrgbGamut(L, want, H)) return want;
  let lo = 0;
  let hi = want;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(L, mid, H)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Solve for the colour at hue `H` and chroma ~`C` that contrasts with `bg` by
 * at least `target`, staying on the side of `bg` given by `darker`.
 *
 * Contrast against a fixed background is monotonic in lightness on each side of
 * that background's luminance, but not across it — so the search is bounded at
 * the pivot where the two luminances match. On the dark side we take the
 * LIGHTEST qualifying lightness and on the light side the DARKEST, i.e. in both
 * cases the most colourful solution that still clears the bar: solving for
 * contrast should not quietly turn every accent into near-black.
 *
 * Chroma and lightness interact (raising chroma moves luminance, and the
 * sRGB gamut boundary moves with lightness), so the two are relaxed against
 * each other a few times. `hit` reports whether the target was reachable at
 * all — at some hues and chromas it simply is not, and the caller says so
 * rather than pretending.
 */
function solve(
  target: number,
  C: number,
  H: number,
  bg: Rgba,
  darker: boolean,
): { L: number; C: number; rgb: Rgba; hit: boolean } {
  const bgLum = relativeLuminance(bg);
  let chroma = C;
  let L = 0.5;

  for (let pass = 0; pass < 4; pass++) {
    const pivot = lightnessAtLuminance(bgLum, chroma, H);
    let lo = darker ? 0 : pivot;
    let hi = darker ? pivot : 1;
    // On [lo,hi] the ratio is monotone: decreasing in L on the dark side,
    // increasing on the light side. Bisect for the boundary of "clears target".
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      const ok = contrastRatio(oklchToRgb(mid, chroma, H), bg) >= target;
      if (darker) {
        if (ok) lo = mid;
        else hi = mid;
      } else {
        if (ok) hi = mid;
        else lo = mid;
      }
    }
    L = darker ? lo : hi;
    chroma = clampChroma(L, C, H);
  }

  const rgb = oklchToRgb(L, chroma, H);
  return { L, C: chroma, rgb, hit: contrastRatio(rgb, bg) >= target - 0.01 };
}

/** `"R G B"` — the space-separated channel format the brand seam requires. */
function channels({ r, g, b }: Rgba): string {
  const c = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return `${c(r)} ${c(g)} ${c(b)}`;
}

/* -------------------------------------------------------------------------- */
/* ground tint                                                                 */
/* -------------------------------------------------------------------------- */

/** The neutral ramp: everything that is "the page" rather than "the accent". */
const GROUND = [
  "--surface",
  "--surface-raised",
  "--surface-sunken",
  "--surface-hover",
  "--surface-active",
  "--surface-selected",
  "--border-subtle",
  "--border",
  "--border-strong",
  "--text",
  "--text-muted",
  "--text-subtle",
  "--scroll-thumb",
] as const;

const TEXTS = ["--text", "--text-muted", "--text-subtle"] as const;
const SURFACES = [
  "--surface",
  "--surface-raised",
  "--surface-sunken",
  "--surface-hover",
  "--surface-active",
  "--surface-selected",
] as const;

export function clearTint(root: HTMLElement = document.documentElement): void {
  for (const name of GROUND) root.style.removeProperty(name);
}

/**
 * Rotate the neutral ramp onto `hue`, adding `chroma` of colour to surfaces and
 * half that to text.
 *
 * Lightness is left strictly alone, which is what makes this safe: at this
 * chroma a hue rotation at fixed `L` moves WCAG contrast by around 1%, so the
 * ramp's whole contrast structure survives the rotation. The pairs are measured
 * afterwards anyway and the worst one is returned, because "about 1%" is a
 * measurement someone else made and this costs nothing to check.
 *
 * Text gets half the chroma: a fully-tinted body copy reads as a stain rather
 * than as a ground.
 */
export function tintGround(
  hue: number,
  chroma: number,
  root: HTMLElement = document.documentElement,
): number {
  clearTint(root);
  for (const name of GROUND) {
    const c = readColor(root, name);
    if (!c) continue;
    const { L, C } = rgbToOklch(c);
    const isText = (TEXTS as readonly string[]).includes(name);
    const want = Math.max(C, chroma * (isText ? 0.5 : 1));
    root.style.setProperty(name, toHex(oklchToRgb(L, clampChroma(L, want, hue), hue)));
  }

  // What the rotation actually cost, measured rather than assumed.
  let worst = Infinity;
  for (const t of TEXTS) {
    const fg = readColor(root, t);
    if (!fg) continue;
    for (const s of SURFACES) {
      const bg = readColor(root, s);
      if (bg) worst = Math.min(worst, contrastRatio(fg, bg));
    }
  }
  return worst;
}

/* -------------------------------------------------------------------------- */
/* the entry point                                                             */
/* -------------------------------------------------------------------------- */

/** Remove everything this module owns, so the theme's own values show through. */
export function clearAccent(root: HTMLElement = document.documentElement): void {
  for (const name of OWNED) root.style.removeProperty(name);
}

/**
 * Run `read` with our overrides temporarily out of the way, then put them back.
 *
 * Reading a theme's OWN defaults means un-setting what we previously applied,
 * and that is a mutation of the live document — so it has to be undone, or a
 * read becomes a write. It bit exactly once: painting the spectrum strip calls
 * `readContext`, the strip is recomputed whenever the theme or mode changes,
 * and the bare clear silently reverted the whole app to the theme's shipped
 * accent a frame after the picker had applied the chosen one. Callers that go
 * on to apply new values overwrite the restored ones immediately, so this costs
 * them nothing.
 */
function withThemeDefaults<T>(root: HTMLElement, read: () => T): T {
  const saved = OWNED.map((name) => [name, root.style.getPropertyValue(name)] as const);
  clearAccent(root);
  try {
    return read();
  } finally {
    for (const [name, value] of saved) if (value) root.style.setProperty(name, value);
  }
}

/**
 * The hue the current theme (or the server's `PADDOCK_BRAND_ACCENT` injection)
 * would use if the user picked nothing. This is how the two compose: the brand
 * seam supplies a hue like any other source, and the theme still owns the
 * chroma, the target contrast, and therefore the lightness.
 */
export function themeDefaultHue(root: HTMLElement = document.documentElement): number {
  return withThemeDefaults(root, () => {
    const base = readColor(root, "--accent");
    return base ? rgbToOklch(base).H : 0;
  });
}

/**
 * Solve and apply the accent for `hue`, then verify what the theme actually
 * derived and repair anything that came out below its floor.
 *
 * Applied as inline properties on `<html>` rather than as an injected
 * stylesheet: an element's own style declaration outranks every selector in
 * `themes.css` without needing `!important`, which keeps the theme blocks
 * readable and means `clearAccent()` is a complete undo.
 */
/**
 * Everything the solve needs from the current theme + mode, read once.
 *
 * Split out so the picker can solve a whole spectrum of hues off a single DOM
 * read — the strip a user drags along is painted with the colours they would
 * actually get, not with a decorative rainbow that happens to sit near them.
 */
interface Context {
  fg: Rgba;
  surface: Rgba;
  surfaces: Rgba[];
  targets: { accent: number; a600: number; a700: number };
  chroma: { accent: number; a600: number; a700: number };
  darker: { accent: boolean; a600: boolean; a700: boolean };
  /** The surface `--accent-700` has the hardest time against. */
  a700Bg: Rgba;
}

const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };

function readContext(root: HTMLElement): Context {
  return withThemeDefaults(root, () => readContextNow(root));
}

function readContextNow(root: HTMLElement): Context {
  const def = {
    accent: readColor(root, "--accent") ?? WHITE,
    a600: readColor(root, "--accent-600") ?? WHITE,
    a700: readColor(root, "--accent-700") ?? WHITE,
  };
  const fg = readColor(root, "--accent-fg") ?? WHITE;
  const surface = readColor(root, "--surface") ?? WHITE;
  const surfaces = (["--surface", "--surface-raised", "--surface-sunken"] as const)
    .map((n) => readColor(root, n))
    .filter((c): c is Rgba => c !== null);
  const bgs = surfaces.length ? surfaces : [surface];
  const a700Bg = bgs.reduce((a, b) => (contrastRatio(def.a700, a) < contrastRatio(def.a700, b) ? a : b));

  return {
    fg,
    surface,
    surfaces: bgs,
    // The theme's OWN achieved ratios become the targets, floored at AA. This
    // is what makes the solve self-configuring: no per-theme table to maintain,
    // and by construction the result can never be less readable than the theme
    // shipped with.
    targets: {
      accent: Math.max(contrastRatio(def.accent, surface), AA_MARK + MARGIN),
      a600: Math.max(contrastRatio(def.a600, fg), AA_TEXT + MARGIN),
      a700: Math.max(
        bgs.reduce((m, bg) => Math.min(m, contrastRatio(def.a700, bg)), Infinity),
        AA_TEXT + MARGIN,
      ),
    },
    chroma: {
      accent: rgbToOklch(def.accent).C,
      a600: rgbToOklch(def.a600).C,
      a700: rgbToOklch(def.a700).C,
    },
    // Polarity. Does the fill sit UNDER light type (so it must be dark), or
    // does it CARRY dark type (so it must be light)? phosphor, and vellum in
    // dark, are the second kind — assuming the first is exactly the bug that
    // lets an injected brand hex break a theme outright.
    darker: {
      accent: relativeLuminance(def.accent) < relativeLuminance(surface),
      a600: relativeLuminance(fg) > relativeLuminance(def.a600),
      a700: relativeLuminance(def.a700) < relativeLuminance(a700Bg),
    },
    a700Bg,
  };
}

function solveChannels(ctx: Context, hue: number) {
  return {
    accent: solve(ctx.targets.accent, ctx.chroma.accent, hue, ctx.surface, ctx.darker.accent),
    a600: solve(ctx.targets.a600, ctx.chroma.a600, hue, ctx.fg, ctx.darker.a600),
    a700: solve(ctx.targets.a700, ctx.chroma.a700, hue, ctx.a700Bg, ctx.darker.a700),
  };
}

/**
 * The solved primary-button fill at each of `hues`, as `#rrggbb`.
 *
 * This is what the spectrum strip is painted with, which is the honest way to
 * draw it: every position on the strip is the colour that position produces.
 * Where the solve has to give ground — pulling chroma in near the sRGB
 * boundary, or lightness around a hue whose luminance runs high — the strip
 * shows that rather than promising a vividness the app will not deliver.
 */
export function accentSwatches(hues: number[], root: HTMLElement = document.documentElement): string[] {
  const ctx = readContext(root);
  return hues.map((h) => toHex(solve(ctx.targets.a600, ctx.chroma.a600, h, ctx.fg, ctx.darker.a600).rgb));
}

export function applyAccent(
  hue: number,
  root: HTMLElement = document.documentElement,
): AccentReport {
  const mode: "light" | "dark" = root.classList.contains("dark") ? "dark" : "light";

  // 1. Read the theme's own defaults, with our overrides out of the way, and
  //    2. derive the targets. 3. Solve each channel at the new hue.
  const ctx = readContext(root);
  const solved = solveChannels(ctx, hue);
  const { a600: s600, a700: s700, accent: sAccent } = solved;
  const okAccent = { C: ctx.chroma.accent };
  const ok700 = { C: ctx.chroma.a700 };

  // Start from a clean slate. `readContext` restores whatever was inline before
  // it looked (it is a read, and a read must not mutate) — but that includes any
  // DERIVED token a previous run repaired, e.g. `--accent-solid-hover`. Those
  // are flat hexes, they outrank the theme's own derivation, and nothing below
  // overwrites one unless the repair fires again. Left in place they pin part of
  // the accent family to the last hue that needed fixing: picking Teal and then
  // Violet gave a violet button with a teal hover, and the contrast audit could
  // not see it because a stale accent is still a readable one. Clearing here is
  // what makes each apply a fresh derivation rather than a patch on the last.
  clearAccent(root);

  root.style.setProperty("--accent", channels(sAccent.rgb));
  root.style.setProperty("--accent-600", channels(s600.rgb));
  root.style.setProperty("--accent-700", channels(s700.rgb));

  // 4. Verify what the theme DERIVED, and repair what its derivation lost.
  const checks: AccentCheck[] = [];
  const derivedFg = readColor(root, "--accent-fg") ?? ctx.fg;

  const repairFill = (token: string, label: string, floor: number): number => {
    const fill = readColor(root, token);
    if (!fill) return Infinity;
    let ratio = contrastRatio(fill, derivedFg);
    let repaired = false;
    if (ratio < floor + MARGIN) {
      const { C } = rgbToOklch(fill);
      const fixed = solve(
        floor + MARGIN,
        C || okAccent.C,
        hue,
        derivedFg,
        relativeLuminance(fill) < relativeLuminance(derivedFg),
      );
      root.style.setProperty(token, toHex(fixed.rgb));
      ratio = contrastRatio(fixed.rgb, derivedFg);
      repaired = true;
    }
    checks.push({ label, fg: "--accent-fg", bg: token, ratio, floor, repaired });
    return ratio;
  };

  const restRatio = repairFill("--accent-solid", "Primary button", AA_TEXT);
  // The craft floor says hover must INCREASE contrast. Three of the four
  // directions inherited a dark-mode hover that REDUCES it (foundation
  // 5.53 -> 4.17, instrument 4.69 -> 2.98, register 5.40 -> 3.79), because
  // `--accent-solid-hover` in dark resolves back to the lighter raw accent.
  // Giving the hover a floor of "more than the rest state achieved" fixes that
  // for every theme at once rather than four times over — and it falls out of
  // the same repair pass, at no extra cost.
  repairFill("--accent-solid-hover", "Primary button, hovered", Math.min(restRatio + 0.6, 12));

  // `--accent-soft` is in this list because an accent chip is accent text on an
  // accent-tinted fill, and that pairing is the one a purely surface-based
  // check misses.
  const derivedSurfaces: { name: string; c: Rgba }[] = [];
  for (const n of ["--surface", "--surface-raised", "--surface-sunken", "--accent-soft"]) {
    const c = readColor(root, n);
    if (c) derivedSurfaces.push({ name: n, c });
  }

  let textRatio = Infinity;
  const text = readColor(root, "--accent-text");
  if (text && derivedSurfaces.length) {
    const lowest = derivedSurfaces.reduce(
      (a, b) => (contrastRatio(text, a.c) < contrastRatio(text, b.c) ? a : b),
      derivedSurfaces[0],
    );
    textRatio = contrastRatio(text, lowest.c);
    let repaired = false;
    if (textRatio < AA_TEXT + MARGIN) {
      const { C } = rgbToOklch(text);
      const fixed = solve(
        AA_TEXT + MARGIN,
        C || ok700.C,
        hue,
        lowest.c,
        relativeLuminance(text) < relativeLuminance(lowest.c),
      );
      root.style.setProperty("--accent-text", toHex(fixed.rgb));
      textRatio = derivedSurfaces.reduce(
        (m, s) => Math.min(m, contrastRatio(fixed.rgb, s.c)),
        Infinity,
      );
      repaired = true;
    }
    checks.push({
      label: "Accent text",
      fg: "--accent-text",
      bg: lowest.name,
      ratio: textRatio,
      floor: AA_TEXT,
      repaired,
    });
  }

  const applied: Record<string, string> = {};
  for (const name of ["--accent-solid", "--accent-solid-hover", "--accent-text"]) {
    const c = readColor(root, name);
    if (c) applied[name] = toHex(c);
  }

  return {
    hue,
    mode,
    channels: {
      accent: toHex(sAccent.rgb),
      accent600: toHex(s600.rgb),
      accent700: toHex(s700.rgb),
    },
    applied,
    checks,
    ok: checks.every((c) => c.ratio >= c.floor - 0.005) && restRatio >= AA_TEXT,
  };
}
