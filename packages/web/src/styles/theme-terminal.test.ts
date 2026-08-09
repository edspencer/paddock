/**
 * The contrast guard for the `terminal` theme.
 *
 * `tokens.test.ts` parses `tokens.css`'s `:root`/`.dark` and certifies the
 * FOUNDATION palette. It cannot see a runtime theme, so a theme file could ship
 * anything. This is the same assertion set pointed at `theme-terminal.css`, and
 * it exists because the waiver this theme was granted — near-black canvas, one
 * bright acid-green accent — is precisely the aesthetic whose usual failure mode
 * is mid-grey comments at 2:1. The look is waived; the floor is not.
 *
 * Deliberately a SEPARATE file that touches nothing shared: three workers are
 * merging into one branch, so a new theme is a new file plus a registry line.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, inSrgbGamut, resolveColor, toHex } from "../lib/color";

const SRC = resolve(process.cwd(), "src");
const css = readFileSync(join(SRC, "styles/theme-terminal.css"), "utf-8");

/**
 * A small reader rather than `parseTokenCss`, which hard-codes `:root`/`.dark`.
 * Same shape of output: a mode is the theme's base block (fonts, radii) merged
 * with that mode's colour block, which is exactly how the cascade resolves it.
 */
function block(selector: string): Record<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`${selector.replace(/[.[\]"=:()]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(stripped);
  if (!m) throw new Error(`no ${selector} block in theme-terminal.css`);
  const out: Record<string, string> = {};
  for (const decl of m[1].split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const name = decl.slice(0, i).trim();
    if (name.startsWith("--")) out[name] = decl.slice(i + 1).trim();
  }
  return out;
}

const base = block('[data-theme="terminal"]');
const MODES = {
  light: { ...base, ...block('[data-theme="terminal"]:not(.dark)') },
  dark: { ...base, ...block('[data-theme="terminal"].dark') },
};

const SURFACES = [
  "--surface",
  "--surface-raised",
  "--surface-sunken",
  "--surface-hover",
  "--surface-active",
  "--surface-selected",
] as const;
const FOREGROUNDS = ["--text", "--text-muted", "--text-subtle", "--accent-text"] as const;
const HUES = ["success", "warn", "danger", "info", "lineage"] as const;

const AA_BODY = 4.5;
const AA_LARGE = 3;

function ratio(mode: "light" | "dark", fg: string, bg: string): number {
  const vars = MODES[mode];
  return contrastRatio(resolveColor(`var(${fg})`, vars), resolveColor(`var(${bg})`, vars));
}
function label(mode: "light" | "dark", fg: string, bg: string): string {
  const vars = MODES[mode];
  return `${mode}: ${fg} (${toHex(resolveColor(`var(${fg})`, vars))}) on ${bg} (${toHex(
    resolveColor(`var(${bg})`, vars),
  )}) = ${ratio(mode, fg, bg).toFixed(2)}:1`;
}

describe.each(["light", "dark"] as const)("terminal — %s mode", (mode) => {
  it.each(FOREGROUNDS.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))(
    "%s on %s clears 4.5:1",
    (fg, bg) => {
      expect(ratio(mode, fg, bg), label(mode, fg, bg)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(HUES)("%s reads on every surface it is used on", (hue) => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken", `--${hue}-soft`]) {
      expect(
        ratio(mode, `--${hue}-text`, bg),
        label(mode, `--${hue}-text`, bg),
      ).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it.each(HUES)("%s foreground reads on its own solid fill", (hue) => {
    expect(
      ratio(mode, `--${hue}-fg`, `--${hue}-solid`),
      label(mode, `--${hue}-fg`, `--${hue}-solid`),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("accent foreground reads on the accent fill, at rest AND hovered", () => {
    // Reverse video puts the tube's black on a bright green. The hover state is
    // asserted too because the classic terminal-theme bug is a hover that goes
    // brighter under dark type and dimmer under light type.
    for (const bg of ["--accent-solid", "--accent-solid-hover"]) {
      expect(ratio(mode, "--accent-fg", bg), label(mode, "--accent-fg", bg)).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    }
    expect(ratio(mode, "--accent-fg", "--accent-solid-hover")).toBeGreaterThanOrEqual(
      ratio(mode, "--accent-fg", "--accent-solid"),
    );
  });

  it("border-strong is a visible control boundary (3:1) on every surface", () => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken"]) {
      expect(
        ratio(mode, "--border-strong", bg),
        label(mode, "--border-strong", bg),
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it("the surface ladder is ordered and separable", () => {
    const vars = MODES[mode];
    const lum = (n: string) => resolveColor(`var(${n})`, vars);
    expect(contrastRatio(lum("--surface-raised"), lum("--surface"))).toBeGreaterThan(1.02);
    expect(contrastRatio(lum("--surface-sunken"), lum("--surface"))).toBeGreaterThan(1.02);
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

  it("declares the three brandable channel variables in channel form", () => {
    for (const name of ["--accent", "--accent-600", "--accent-700"]) {
      expect(MODES[mode][name], `${name} must stay space-separated sRGB channels`).toMatch(
        /^\d+\s+\d+\s+\d+$/,
      );
    }
  });

  it("every accent-flavoured token follows an injected brand colour (#34)", () => {
    const branded = { ...MODES[mode], "--accent": "20 80 160", "--accent-600": "17 69 138", "--accent-700": "14 57 114" };
    for (const token of ["--accent-color", "--accent-solid", "--accent-text", "--accent-soft", "--accent-border"]) {
      expect(
        toHex(resolveColor(`var(${token})`, branded)),
        `${token} ignored the injected brand accent`,
      ).not.toBe(toHex(resolveColor(`var(${token})`, MODES[mode])));
    }
  });
});

describe("terminal — the theme's own promises", () => {
  it("is monospace in all four type roles", () => {
    for (const role of ["--font-sans", "--font-display", "--font-mono", "--font-prose"]) {
      expect(base[role], `${role} must resolve to the terminal face`).toMatch(
        /Iosevka Terminal|var\(--font-sans\)/,
      );
    }
    expect(base["--font-sans"]).toContain("monospace");
  });

  it("is square at every rung of the radius scale", () => {
    for (const rung of ["sm", "md", "lg", "xl", "2xl", "3xl"]) {
      expect(base[`--radius-${rung}`]).toBe("0px");
    }
  });

  it("puts dark type on the bright fill in dark mode, light type on ink in light mode", () => {
    // The two artefacts, asserted rather than described: the tube reverses
    // video, the line printer does not.
    const tubeFg = resolveColor("var(--accent-fg)", MODES.dark);
    const tubeBg = resolveColor("var(--accent-solid)", MODES.dark);
    expect(tubeFg.r + tubeFg.g + tubeFg.b).toBeLessThan(tubeBg.r + tubeBg.g + tubeBg.b);
    const paperFg = resolveColor("var(--accent-fg)", MODES.light);
    const paperBg = resolveColor("var(--accent-solid)", MODES.light);
    expect(paperFg.r + paperFg.g + paperFg.b).toBeGreaterThan(paperBg.r + paperBg.g + paperBg.b);
  });

  it("does not converge on phosphor: the dark canvas is far darker and green, not cyan", () => {
    // `phosphor` is a muted blue-green GLASS at L 0.283 / hue 194. This is a
    // tube at L 0.158 / hue 152. The guard is here so a later tweak cannot
    // quietly drift the two together.
    const surface = MODES.dark["--surface"];
    const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(surface);
    expect(m, `--surface should be an oklch() literal, got ${surface}`).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(0.2);
    expect(Number(m![3])).toBeGreaterThan(120);
    expect(Number(m![3])).toBeLessThan(175);
  });
});
