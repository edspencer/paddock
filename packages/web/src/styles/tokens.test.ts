/**
 * The contrast guard.
 *
 * This is the test that makes four different visual directions trustworthy
 * rather than four opinions: it parses the REAL `tokens.css` and asserts every
 * text-on-surface pairing the app can actually produce clears WCAG AA, in both
 * modes. Change a token to something pretty but illegible and this fails.
 *
 * It also holds the three "never again" lint rules from docs/DESIGN.md, because
 * the pre-token codebase reached 1017 raw palette-step uses and 200 arbitrary
 * font sizes purely by nobody counting.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, inSrgbGamut, parseTokenCss, resolveColor, toHex } from "../lib/color";

// vitest runs with cwd = packages/web; `import.meta.url` is not a file URL under
// its transform, so paths are resolved from the package root.
const SRC = resolve(process.cwd(), "src");
const tokenCss = readFileSync(join(SRC, "styles/tokens.css"), "utf-8");
const MODES = parseTokenCss(tokenCss);

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

function ratio(mode: "light" | "dark", fg: string, bg: string): number {
  const vars = MODES[mode];
  return contrastRatio(resolveColor(`var(${fg})`, vars), resolveColor(`var(${bg})`, vars));
}

function describeRatio(mode: "light" | "dark", fg: string, bg: string): string {
  const vars = MODES[mode];
  const f = toHex(resolveColor(`var(${fg})`, vars));
  const b = toHex(resolveColor(`var(${bg})`, vars));
  return `${mode}: ${fg} (${f}) on ${bg} (${b}) = ${ratio(mode, fg, bg).toFixed(2)}:1`;
}

describe.each(["light", "dark"] as const)("token contrast — %s mode", (mode) => {
  it.each(FOREGROUNDS.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))(
    "%s on %s clears 4.5:1",
    (fg, bg) => {
      expect(describeRatio(mode, fg, bg)).toBe(describeRatio(mode, fg, bg)); // keeps the label in failures
      expect(ratio(mode, fg, bg)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(HUES)("%s reads on every surface it is used on", (hue) => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken", `--${hue}-soft`]) {
      const r = ratio(mode, `--${hue}-text`, bg);
      expect(`${hue} ${bg} ${r.toFixed(2)}`).toBe(`${hue} ${bg} ${r.toFixed(2)}`);
      expect(r, describeRatio(mode, `--${hue}-text`, bg)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it.each(HUES)("%s foreground reads on its own solid fill", (hue) => {
    expect(
      ratio(mode, `--${hue}-fg`, `--${hue}-solid`),
      describeRatio(mode, `--${hue}-fg`, `--${hue}-solid`),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("accent foreground reads on the accent fill", () => {
    expect(
      ratio(mode, "--accent-fg", "--accent-solid"),
      describeRatio(mode, "--accent-fg", "--accent-solid"),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("border-strong is a visible control boundary (3:1) on every surface", () => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken"]) {
      expect(
        ratio(mode, "--border-strong", bg),
        describeRatio(mode, "--border-strong", bg),
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it("the surface ladder is ordered and separable", () => {
    const vars = MODES[mode];
    const lum = (n: string) => resolveColor(`var(${n})`, vars);
    const raised = contrastRatio(lum("--surface-raised"), lum("--surface"));
    const sunken = contrastRatio(lum("--surface-sunken"), lum("--surface"));
    // Adjacent surfaces are deliberately close (they are separated by a border
    // and a shadow, not by brightness) but must not be identical, or "raised"
    // stops meaning anything.
    expect(raised).toBeGreaterThan(1.02);
    expect(sunken).toBeGreaterThan(1.02);
  });

  it("every oklch() token is inside the sRGB gamut", () => {
    const bad: string[] = [];
    for (const [name, value] of Object.entries(MODES[mode])) {
      const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
      if (!m) continue;
      if (!inSrgbGamut(Number(m[1]), Number(m[2]), Number(m[3]))) bad.push(`${name}: ${value}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("the runtime-brandable accent seam (#34)", () => {
  // packages/server/src/brand.ts injects `:root{--accent:R G B;--accent-600:…;
  // --accent-700:…}` for PADDOCK_BRAND_ACCENT. Everything accent-flavoured must
  // still resolve when it does — if a token stopped deriving from these three,
  // per-instance branding would silently stop applying to it.
  const BRANDED = { "--accent": "20 80 160", "--accent-600": "17 69 138", "--accent-700": "14 57 114" };

  it.each(["light", "dark"] as const)("%s: accent tokens follow an injected brand colour", (mode) => {
    const base = MODES[mode];
    const branded = { ...base, ...BRANDED };
    for (const token of ["--accent-color", "--accent-solid", "--accent-text", "--accent-soft", "--accent-border"]) {
      const before = toHex(resolveColor(`var(${token})`, base));
      const after = toHex(resolveColor(`var(${token})`, branded));
      expect(after, `${token} ignored the injected brand accent`).not.toBe(before);
    }
  });

  it("declares the three channel variables the server overrides, in channel form", () => {
    for (const name of ["--accent", "--accent-600", "--accent-700"]) {
      expect(MODES.light[name], `${name} must stay space-separated sRGB channels`).toMatch(
        /^\d+\s+\d+\s+\d+$/,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Lint rules — see the "Reject this" section of docs/DESIGN.md                */
/* -------------------------------------------------------------------------- */

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(join(dir, e.name), rel);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}
const sources = walk(".").map((file) => ({ file, text: readFileSync(join(SRC, file), "utf-8") }));

/** `lib/brand.ts` mirrors the server's default accent hex; that one is the seam. */
const HEX_ALLOWED = new Set(["lib/brand.ts"]);

describe("colour discipline", () => {
  it("no component states a colour literally", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      if (HEX_ALLOWED.has(file)) continue;
      for (const [i, line] of text.split("\n").entries()) {
        // Skip issue references (`#708`) and hash routes; a colour hex is 3 or
        // 6 hex digits inside a string or an arbitrary Tailwind value.
        if (/["'[]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
        if (/\brgba?\(\s*\d/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(offenders, "use a semantic token from styles/tokens.css").toEqual([]);
  });

  it("no component addresses a raw palette step", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const [i, line] of text.split("\n").entries()) {
        if (/-paddock-\d{2,3}\b/.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders, "use a semantic token (bg-surface, text-fg-muted, …)").toEqual([]);
  });

  it("the migration compat palette has been removed from index.css", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf-8");
    expect(css, "delete the MIGRATION COMPAT @theme block once src/ is clean").not.toContain(
      "--color-paddock-",
    );
  });

  it("no component invents a font size", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const [i, line] of text.split("\n").entries()) {
        if (/\btext-\[[\d.]+(px|rem)\]/.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders, "use a rung of the type scale (text-3xs … text-3xl)").toEqual([]);
  });

  it("no component uses `transition-all` or a bare outline focus ring", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const [i, line] of text.split("\n").entries()) {
        if (/\btransition-all\b/.test(line)) offenders.push(`${file}:${i + 1} transition-all`);
        if (/\bfocus:outline\b(?!-none)/.test(line)) offenders.push(`${file}:${i + 1} outline ring`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
