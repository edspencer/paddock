/**
 * Colour maths for the design-token contrast guard.
 *
 * `src/styles/tokens.css` is authored in OKLCH; WCAG 2 contrast is defined on
 * sRGB relative luminance. This module converts between the two and resolves the
 * small subset of CSS colour syntax the token file actually uses, so
 * `tokens.test.ts` can assert ratios against the REAL shipped stylesheet rather
 * than against a duplicated table that could drift from it.
 *
 * Deliberately dependency-free and deliberately narrow: it understands
 * `oklch()`, `rgb()`, `#hex`, `white`/`black`/`transparent`, `var(--x)` and
 * `color-mix(in oklab, …)`. Anything else throws, which is the correct outcome —
 * a token written in syntax the guard cannot evaluate is a token whose contrast
 * nobody is checking.
 */

/** A colour as premultiply-free sRGB components in 0–1 plus alpha in 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** OKLab triple (L 0–1, a, b). */
interface Oklab {
  L: number;
  a: number;
  b: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB transfer function (linear -> encoded). */
function encodeSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Inverse sRGB transfer function (encoded -> linear). */
function decodeSrgb(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function oklabToLinearSrgb({ L, a, b }: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearSrgbToOklab(lr: number, lg: number, lb: number): Oklab {
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** `oklch(L C H)` -> sRGB in 0–1 (gamut-clipped per channel). */
export function oklchToRgb(L: number, C: number, H: number, a = 1): Rgba {
  const h = (H * Math.PI) / 180;
  const lin = oklabToLinearSrgb({ L, a: C * Math.cos(h), b: C * Math.sin(h) });
  const [r, g, b] = lin.map((c) => clamp01(encodeSrgb(c)));
  return { r, g, b, a };
}

/** True when an `oklch()` triple lands inside the sRGB gamut without clipping. */
export function inSrgbGamut(L: number, C: number, H: number): boolean {
  const h = (H * Math.PI) / 180;
  return oklabToLinearSrgb({ L, a: C * Math.cos(h), b: C * Math.sin(h) })
    .map(encodeSrgb)
    .every((c) => c >= -0.0015 && c <= 1.0015);
}

/** `#rrggbb` for an sRGB colour (alpha dropped). */
export function toHex({ r, g, b }: Rgba): string {
  const to = (x: number) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** WCAG 2 relative luminance of an opaque sRGB colour. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const [lr, lg, lb] = [r, g, b].map(decodeSrgb);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** Composite `fg` (which may be translucent) over an opaque `bg`. */
export function flatten(fg: Rgba, bg: Rgba): Rgba {
  if (fg.a >= 1) return fg;
  const k = fg.a;
  return {
    r: fg.r * k + bg.r * (1 - k),
    g: fg.g * k + bg.g * (1 - k),
    b: fg.b * k + bg.b * (1 - k),
    a: 1,
  };
}

/**
 * WCAG 2 contrast ratio between two colours. A translucent `fg` is composited
 * over `bg` first, which is what a browser actually paints.
 */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const f = relativeLuminance(flatten(fg, bg));
  const b = relativeLuminance(bg);
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}

/* -------------------------------------------------------------------------- */
/* CSS value parsing                                                           */
/* -------------------------------------------------------------------------- */

const NAMED: Record<string, Rgba> = {
  white: { r: 1, g: 1, b: 1, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/** Split a comma-separated argument list, respecting nested parentheses. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Body of `name(...)` if `value` is exactly that call, else null. */
function callBody(value: string, name: string): string | null {
  if (!value.startsWith(`${name}(`) || !value.endsWith(")")) return null;
  return value.slice(name.length + 1, -1);
}

function num(token: string): number {
  const n = token.endsWith("%") ? Number(token.slice(0, -1)) / 100 : Number(token);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${token}`);
  return n;
}

/**
 * Resolve a CSS colour value to sRGB, following `var()` references through
 * `vars`. `vars` is the flattened custom-property map for the mode being
 * evaluated (see `parseTokenCss`).
 */
export function resolveColor(value: string, vars: Record<string, string>, depth = 0): Rgba {
  if (depth > 24) throw new Error(`var() cycle resolving ${value}`);
  const v = value.trim();

  if (NAMED[v]) return NAMED[v];

  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6) throw new Error(`bad hex: ${v}`);
    const n = parseInt(h, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }

  const varBody = callBody(v, "var");
  if (varBody !== null) {
    const [name, ...fallback] = splitArgs(varBody);
    const next = vars[name] ?? fallback.join(",");
    if (!next) throw new Error(`undefined custom property: ${name}`);
    return resolveColor(next, vars, depth + 1);
  }

  const oklchBody = callBody(v, "oklch");
  if (oklchBody !== null) {
    const [comps, alpha] = oklchBody.split("/");
    const parts = comps.trim().split(/\s+/);
    if (parts.length !== 3) throw new Error(`bad oklch(): ${v}`);
    return oklchToRgb(num(parts[0]), num(parts[1]), num(parts[2]), alpha ? num(alpha.trim()) : 1);
  }

  const rgbBody = callBody(v, "rgb") ?? callBody(v, "rgba");
  if (rgbBody !== null) {
    // `rgb(var(--accent))` — the channel-list form the brand seam uses.
    const inner = rgbBody.trim();
    const innerVar = callBody(inner, "var");
    if (innerVar !== null) {
      const [name] = splitArgs(innerVar);
      const channels = vars[name];
      if (!channels) throw new Error(`undefined custom property: ${name}`);
      return resolveColor(`rgb(${channels})`, vars, depth + 1);
    }
    const [comps, alpha] = inner.split("/");
    const parts = comps.trim().split(/[\s,]+/);
    if (parts.length < 3) throw new Error(`bad rgb(): ${v}`);
    return {
      r: num(parts[0]) / 255,
      g: num(parts[1]) / 255,
      b: num(parts[2]) / 255,
      a: alpha ? num(alpha.trim()) : 1,
    };
  }

  const mixBody = callBody(v, "color-mix");
  if (mixBody !== null) {
    const [space, first, second] = splitArgs(mixBody);
    const spaceName = space.trim();
    if (spaceName !== "in oklab" && spaceName !== "in srgb") {
      throw new Error(`only \`in oklab\` and \`in srgb\` color-mix are supported, got: ${space}`);
    }
    const one = splitPercent(first);
    const two = splitPercent(second);
    let p1 = one.pct;
    let p2 = two.pct;
    if (p1 === null && p2 === null) (p1 = 0.5), (p2 = 0.5);
    else if (p1 === null) p1 = 1 - (p2 as number);
    else if (p2 === null) p2 = 1 - p1;
    const total = (p1 as number) + (p2 as number);
    const w = (p1 as number) / total;
    const ca = resolveColor(one.color, vars, depth + 1);
    const cb = resolveColor(two.color, vars, depth + 1);
    return spaceName === "in srgb" ? mixSrgb(ca, cb, w) : mixOklab(ca, cb, w);
  }

  throw new Error(`unsupported colour value: ${v}`);
}

/** `"<color> 30%"` -> `{ color, pct: 0.3 }`; a missing percentage yields null. */
function splitPercent(s: string): { color: string; pct: number | null } {
  const m = /\s+(-?[\d.]+)%$/.exec(s.trim());
  if (!m) return { color: s.trim(), pct: null };
  return { color: s.trim().slice(0, m.index).trim(), pct: Number(m[1]) / 100 };
}

/**
 * Interpolate two colours in gamma-encoded sRGB, `w` being the weight of `a`.
 *
 * Not a worse OKLab — a DIFFERENT answer, and sometimes the one being asked for.
 * `color-mix(in srgb, X 10%, Y)` is what an alpha-composited `bg-X/10` over `Y`
 * evaluates to, so a token restoring a pre-token UI's translucent fill has to
 * mix here to land on the same pixel. The two spaces disagree by enough to see:
 * the sub-agent strip's fill differs by ~3 in each channel between them.
 */
function mixSrgb(a: Rgba, b: Rgba, w: number): Rgba {
  return {
    r: a.r * w + b.r * (1 - w),
    g: a.g * w + b.g * (1 - w),
    b: a.b * w + b.b * (1 - w),
    a: a.a * w + b.a * (1 - w),
  };
}

/** Interpolate two colours in OKLab, `w` being the weight of `a`. */
function mixOklab(a: Rgba, b: Rgba, w: number): Rgba {
  const la = linearSrgbToOklab(decodeSrgb(a.r), decodeSrgb(a.g), decodeSrgb(a.b));
  const lb = linearSrgbToOklab(decodeSrgb(b.r), decodeSrgb(b.g), decodeSrgb(b.b));
  const mixed: Oklab = {
    L: la.L * w + lb.L * (1 - w),
    a: la.a * w + lb.a * (1 - w),
    b: la.b * w + lb.b * (1 - w),
  };
  const [r, g, bl] = oklabToLinearSrgb(mixed).map((c) => clamp01(encodeSrgb(c)));
  return { r, g, b: bl, a: a.a * w + b.a * (1 - w) };
}

/** sRGB (0–1) -> OKLCH. The inverse of `oklchToRgb`; hue is 0–360. */
export function rgbToOklch({ r, g, b }: Rgba): { L: number; C: number; H: number } {
  const { L, a, b: bb } = linearSrgbToOklab(decodeSrgb(r), decodeSrgb(g), decodeSrgb(b));
  const C = Math.hypot(a, bb);
  // Hue is meaningless at zero chroma; report 0 rather than an artefact of
  // floating-point noise, so a grey never pretends to have an opinion.
  const H = C < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { L, C, H };
}

/**
 * Pull the `:root` and `.dark` custom-property blocks out of a stylesheet.
 *
 * Returns one flattened map per mode: `dark` inherits every `:root` declaration
 * it does not itself override, which mirrors the cascade (both selectors match
 * `<html>`, `.dark` wins on specificity).
 */
export function parseTokenCss(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const read = (selector: string): Record<string, string> => {
    const re = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`);
    const m = re.exec(stripped);
    if (!m) throw new Error(`no ${selector} block in token stylesheet`);
    const out: Record<string, string> = {};
    for (const decl of m[1].split(";")) {
      const i = decl.indexOf(":");
      if (i === -1) continue;
      const name = decl.slice(0, i).trim();
      if (!name.startsWith("--")) continue;
      out[name] = decl.slice(i + 1).trim();
    }
    return out;
  };
  const light = read(":root");
  return { light, dark: { ...light, ...read(".dark") } };
}
