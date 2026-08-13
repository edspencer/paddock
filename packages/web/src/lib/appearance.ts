/**
 * Appearance: which theme, which accent hue, how much ground tint.
 *
 * Scope model, which deliberately mirrors light/dark rather than inventing a
 * second one:
 *
 *   per-device override   localStorage, instant, no reload    <- implemented
 *   instance default      paddock.config.yaml / env           <- stubbed
 *
 * The instance-default half is a stub on this branch. `PADDOCK_BRAND_ACCENT`
 * already exists and already composes correctly: with no per-device hue picked,
 * `applyAccent` reads the hue off whatever `--accent` the cascade produced —
 * which is the server's injected brand colour if there is one. So the seam that
 * matters is live; what is missing is a `theme:` key in the config file and a
 * matching `PADDOCK_THEME`, which is server plumbing and a different PR.
 *
 * Storage keys. `paddock:theme` is left exactly as it was — light/dark, read by
 * the pre-paint script in index.html since issue #23. This module adds
 * `paddock:appearance` (the choice) and `paddock:appearance-cache` (the solved
 * channels for the last-rendered theme+mode, so the pre-paint script can put
 * the right accent on screen before React boots instead of flashing the
 * theme's default).
 */
import {
  applyAccent,
  clearAccent,
  clearTint,
  themeDefaultHue,
  tintGround,
  type AccentReport,
} from "./accent";
import { DEFAULT_BRAND, getBrand } from "./brand";
import { resolveColor, rgbToOklch } from "./color";

/**
 * The themes, in the order the picker shows them.
 *
 * The order is deliberate rather than chronological: the neutral base first,
 * then the three that are loud on purpose, in increasing distance from it.
 * That is the axis someone actually scans along — "show me something more
 * different than this" — and it is the reason a bare list does not need
 * grouping. Four swatches in one row are read by appearance, not by name;
 * grouping would add chrome to a control whose whole job is to be looked at
 * rather than read.
 *
 * Four, not eight. The design run produced four further directions —
 * `instrument`, `phosphor`, `vellum`, `register` — which were cut on the
 * grounds that they differ from each other mostly in palette and type, so
 * shipping all four bought variety no one could name. Their work is not lost:
 * the token contract every theme here is written against came out of that run,
 * and the branches (`design/instrument` and siblings) are still on the remote.
 *
 * `blurb` is the tooltip on each card, which is where the one-word labels get
 * their disambiguation.
 */
export const THEMES = [
  {
    id: "foundation",
    label: "Foundation",
    blurb: "The neutral base. Warm ground, terracotta accent.",
  },
  {
    id: "parchment",
    label: "Parchment",
    blurb: "Wine chrome, corner brackets, an old-style serif. A 90s RPG menu.",
  },
  {
    id: "terminal",
    label: "Terminal",
    blurb: "Green phosphor and ANSI in the dark; greenbar and ribbon ink in the light.",
  },
  {
    id: "scifi",
    label: "Sci-Fi",
    blurb: "Deep-space ground and luminous cyan. Hairlines, telemetry, glow.",
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/**
 * The named colours. Hue angles only — the theme supplies chroma and solves
 * lightness, so these names stay true across every theme and both modes
 * rather than being five sets of hexes that each need re-picking.
 *
 * Names are the ones a person reaches for. Nothing here says "hue", "chroma",
 * "OKLCH" or "347 degrees", and nothing needs to: that vocabulary is the
 * implementation's, not the user's.
 */
export const NAMED_HUES = [
  { name: "Ember", hue: 40 },
  { name: "Amber", hue: 75 },
  { name: "Olive", hue: 110 },
  { name: "Forest", hue: 148 },
  { name: "Teal", hue: 190 },
  { name: "Sky", hue: 235 },
  { name: "Indigo", hue: 268 },
  { name: "Violet", hue: 300 },
  { name: "Magenta", hue: 330 },
  { name: "Rose", hue: 12 },
] as const;

/** Ground tint strength. The label is the whole vocabulary the user sees. */
export const TINTS = [
  { level: 0, label: "None" },
  { level: 1, label: "A little" },
  { level: 2, label: "More" },
] as const;

/**
 * The hue to use when the user has picked nothing — i.e. the INSTANCE default,
 * the other half of the two-scope model.
 *
 * If an operator set `PADDOCK_BRAND_ACCENT`, that colour's hue wins; otherwise
 * the active theme's own accent supplies it. Note what this does and does not
 * take from the brand colour: the hue, and nothing else. Its lightness and
 * chroma are discarded and re-solved against the theme, which is precisely the
 * proposal — today `brand.ts` derives its 600/700 steps by multiplying the
 * channels by 0.86 and 0.71, a darkening that has no idea what surface the
 * result will sit on, and `tokens.test.ts` certifies it by asserting only that
 * the token changed. Ten plausible brand hexes were measured against vellum
 * during the design run and two were readable. Under this seam all ten are,
 * because lightness stopped being an input.
 *
 * Read from `window.__PADDOCK_CONFIG__` rather than from the injected `<style>`
 * because the theme blocks outrank a `:root` rule — the style element is still
 * there, it just no longer decides anything.
 */
export function instanceDefaultHue(root: HTMLElement = document.documentElement): number {
  const accent = getBrand().accent;
  if (accent && accent.toLowerCase() !== DEFAULT_BRAND.accent.toLowerCase()) {
    try {
      return rgbToOklch(resolveColor(accent, {})).H;
    } catch {
      /* not a colour we can parse — fall through to the theme's own */
    }
  }
  return themeDefaultHue(root);
}

export interface Appearance {
  theme: ThemeId;
  /** null = use the theme's own accent (or the server's brand colour). */
  hue: number | null;
  tint: 0 | 1 | 2;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "foundation", hue: null, tint: 0 };

const KEY = "paddock:appearance";
const CACHE_KEY = "paddock:appearance-cache";

export function readAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const v = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: THEMES.some((t) => t.id === v.theme) ? (v.theme as ThemeId) : "foundation",
      hue: typeof v.hue === "number" ? ((v.hue % 360) + 360) % 360 : null,
      tint: v.tint === 1 || v.tint === 2 ? v.tint : 0,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* localStorage unavailable — the choice still applies for this session */
  }
}

/**
 * Remember the solved channels so the next boot paints them pre-React.
 * Keyed by theme+mode because the solve is mode-dependent: the same hue needs a
 * different lightness on a dark canvas than on a light one.
 */
function cacheChannels(theme: ThemeId, dark: boolean, report: AccentReport | null): void {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") as Record<string, unknown>;
    const key = `${theme}:${dark ? "dark" : "light"}`;
    if (report) all[key] = { ...report.applied, "--accent": report.channels.accent };
    else delete all[key];
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    /* best-effort: a missing cache costs one frame of the theme's own accent */
  }
}

/**
 * Put an appearance on screen. Called on mount, on every change, and whenever
 * light/dark flips — the accent must be re-solved on a mode change because the
 * surfaces it is solved against are the ones that just swapped.
 */
export function applyAppearance(
  a: Appearance,
  root: HTMLElement = document.documentElement,
): AccentReport | null {
  root.setAttribute("data-theme", a.theme);

  // A null hue is not "no accent" — it is "the hue this instance already had".
  // Running that through the same solve is what makes brand injection safe
  // rather than merely permitted.
  const hue = a.hue ?? instanceDefaultHue(root);

  // Tint FIRST: the accent is solved against the surfaces, so the surfaces have
  // to be their final colour before the solve reads them.
  let groundFloor: number | null = null;
  if (a.tint === 0) clearTint(root);
  else groundFloor = tintGround(hue, TINT_CHROMA[a.tint], root);

  const report = applyAccent(hue, root);
  if (report && groundFloor !== null) {
    report.checks.push({
      label: "Body text on the tinted ground",
      fg: "--text-*",
      bg: "--surface-*",
      ratio: groundFloor,
      floor: 4.5,
      repaired: false,
    });
    report.ok = report.ok && groundFloor >= 4.5;
  }
  warnIfBelowFloor(report);
  cacheChannels(a.theme, root.classList.contains("dark"), report);
  return report;
}

/**
 * Say something when a solved appearance lands below its contrast floor
 * (#813, #816).
 *
 * `solve()` targets an AA floor per role and `repairFill` repairs what the theme
 * derives, but neither can guarantee the floor is reachable for every hue — and
 * until now the verdict was computed into `report.ok` / `report.checks` and then
 * discarded, so the one case worth knowing about was the silent one. The tint's
 * ground check (pushed just above) is the same story: measured, folded into
 * `ok`, never surfaced.
 *
 * Deliberately a dev-only console warning rather than UI, and deliberately not a
 * clamp: refusing or altering the user's colour is a product decision, not a bug
 * fix, and the accent scrub re-applies this sixty times a second while dragging.
 * This makes the failure observable to whoever can act on it without touching a
 * single style or changing what anyone sees.
 */
function warnIfBelowFloor(report: AccentReport | null): void {
  if (!import.meta.env.DEV || !report || report.ok) return;
  const missed = report.checks.filter((c) => c.ratio < c.floor);
  if (missed.length === 0) return;
  console.warn(
    `[paddock] accent hue ${Math.round(report.hue)} (${report.mode}) is below its contrast floor:`,
    missed.map((c) => `${c.label} ${c.ratio.toFixed(2)}:1 < ${c.floor}:1`).join("; "),
  );
}

export function saveAppearance(a: Appearance, root?: HTMLElement): AccentReport | null {
  writeAppearance(a);
  const report = applyAppearance(a, root);
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: report }));
  return report;
}

/** Fired whenever the appearance is (re)applied, carrying the fresh report. */
export const APPEARANCE_EVENT = "paddock:appearance";

/**
 * Apply the saved appearance at boot and keep it correct thereafter.
 *
 * Called from `main.tsx`, not from the picker: the picker is behind a dialog
 * that most sessions never open, and the accent must be solved on every load.
 * The observer is the other half — flipping light/dark changes the surfaces the
 * accent was solved against, so the solve has to run again. That is the one
 * genuinely new coupling this feature introduces, and it is why light/dark is
 * watched rather than merely toggled.
 */
export function initAppearance(): () => void {
  const rerun = () => saveAppearance(readAppearance());
  rerun();
  const observer = new MutationObserver((records) => {
    // Only a change to `dark` matters; `data-theme` changes are our own writes
    // and re-running on them would recurse.
    if (records.some((r) => r.attributeName === "class")) rerun();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/* -------------------------------------------------------------------------- */
/* ground tint                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How much chroma the ground picks up at each strength. Small numbers on
 * purpose: at 0.018 a surface is unmistakably "the blue one" across a room and
 * still reads as a neutral up close, which is the whole trick.
 */
const TINT_CHROMA = [0, 0.008, 0.018];

export { clearAccent, TINT_CHROMA };
