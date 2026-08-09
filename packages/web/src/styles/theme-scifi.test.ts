/**
 * The contrast guard, for the `scifi` theme.
 *
 * `tokens.test.ts` parses `tokens.css` and therefore only ever certifies the
 * FOUNDATION palette — a runtime theme swaps every one of those values behind a
 * `[data-theme]` selector the guard never reads. So a theme that ships as its
 * own file has to bring its own guard, or it is an opinion again.
 *
 * Same assertions, same floors, same measured-not-asserted style: every
 * text-on-surface pairing the app can produce, in both modes, plus the two
 * things this theme does differently from the rest and could therefore get
 * wrong on its own — a fill that carries DARK type, and the promise that the
 * hue picker cannot wash the plate out.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, inSrgbGamut, resolveColor, toHex } from "../lib/color";

const SRC = resolve(process.cwd(), "src");
const css = readFileSync(join(SRC, "styles/theme-scifi.css"), "utf-8");

/**
 * Declarations of one top-level block, by exact selector.
 *
 * `parseTokenCss` builds its regex from the selector and only knows `:root` /
 * `.dark`; these selectors carry brackets, quotes and a `:not()`, so they are
 * matched literally instead.
 */
function block(selector: string): Record<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = stripped.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no ${selector} block in theme-scifi.css`);
  const body = stripped.slice(at + selector.length + 2, stripped.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const name = decl.slice(0, i).trim();
    if (name.startsWith("--")) out[name] = decl.slice(i + 1).trim();
  }
  return out;
}

const base = block('[data-theme="scifi"]');
const MODES = {
  light: block('[data-theme="scifi"]:not(.dark)'),
  dark: block('[data-theme="scifi"].dark'),
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
function describeRatio(mode: "light" | "dark", fg: string, bg: string): string {
  const vars = MODES[mode];
  const f = toHex(resolveColor(`var(${fg})`, vars));
  const b = toHex(resolveColor(`var(${bg})`, vars));
  return `${mode}: ${fg} (${f}) on ${bg} (${b}) = ${ratio(mode, fg, bg).toFixed(2)}:1`;
}

describe.each(["light", "dark"] as const)("scifi token contrast — %s mode", (mode) => {
  it("declares every token in BOTH mode blocks", () => {
    // The generated themes merge light under dark so the dark block is
    // self-contained; this file is hand-written, so the equivalent invariant is
    // asserted rather than produced. A token present in only one block falls
    // through to FOUNDATION's value for the other mode — two directions mixed.
    expect(Object.keys(MODES.dark).sort()).toEqual(Object.keys(MODES.light).sort());
  });

  it.each(FOREGROUNDS.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))(
    "%s on %s clears 4.5:1",
    (fg, bg) => {
      expect(ratio(mode, fg, bg), describeRatio(mode, fg, bg)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(HUES)("%s reads on every surface it is used on", (hue) => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken", `--${hue}-soft`]) {
      expect(
        ratio(mode, `--${hue}-text`, bg),
        describeRatio(mode, `--${hue}-text`, bg),
      ).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it.each(HUES)("%s foreground reads on its own solid fill", (hue) => {
    expect(
      ratio(mode, `--${hue}-fg`, `--${hue}-solid`),
      describeRatio(mode, `--${hue}-fg`, `--${hue}-solid`),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("the dark type on the lit accent plate reads, at rest and hovered", () => {
    // This theme's distinguishing move. `--accent-fg` is ink, not white, so the
    // pairing that fails first is not the one the other themes worry about.
    expect(
      ratio(mode, "--accent-fg", "--accent-solid"),
      describeRatio(mode, "--accent-fg", "--accent-solid"),
    ).toBeGreaterThanOrEqual(AA_BODY);
    // The craft floor: hover INCREASES contrast. Here that is a property of the
    // derivation (a mix toward white), not of the solver's repair pass.
    expect(ratio(mode, "--accent-fg", "--accent-solid-hover")).toBeGreaterThan(
      ratio(mode, "--accent-fg", "--accent-solid"),
    );
  });

  it("border-strong is a visible control boundary (3:1) on every surface", () => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken"]) {
      expect(
        ratio(mode, "--border-strong", bg),
        describeRatio(mode, "--border-strong", bg),
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it("the hairline is the structure: --border out-reads the surface ladder", () => {
    // The one assertion that is about IDENTITY rather than about legibility.
    // If a future edit lifts `--surface-raised` toward `--surface-hover`, or
    // softens `--border`, this theme quietly becomes one of the other five.
    const ladder = ratio(mode, "--surface-raised", "--surface");
    const hairline = ratio(mode, "--border", "--surface");
    expect(ladder).toBeGreaterThan(1.02); // still a ladder, just a shallow one
    expect(ladder).toBeLessThan(1.2);
    expect(hairline, `${mode} hairline ${hairline.toFixed(2)} vs ladder ${ladder.toFixed(3)}`)
      .toBeGreaterThan(1.8);
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
  const BRANDED = {
    "--accent": "20 80 160",
    "--accent-600": "17 69 138",
    "--accent-700": "14 57 114",
  };
  it.each(["light", "dark"] as const)("%s: accent tokens follow an injected brand colour", (mode) => {
    const branded = { ...MODES[mode], ...BRANDED };
    for (const token of [
      "--accent-color",
      "--accent-solid",
      "--accent-solid-hover",
      "--accent-text",
      "--accent-soft",
      "--accent-border",
    ]) {
      expect(
        toHex(resolveColor(`var(${token})`, branded)),
        `${token} ignored the injected brand accent`,
      ).not.toBe(toHex(resolveColor(`var(${token})`, MODES[mode])));
    }
  });

  it("declares the three channel variables in channel form, in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const name of ["--accent", "--accent-600", "--accent-700"]) {
        expect(MODES[mode][name], `${mode} ${name} must stay space-separated sRGB channels`).toMatch(
          /^\d+\s+\d+\s+\d+$/,
        );
      }
    }
  });
});

describe("the theme's own shape", () => {
  it("is square", () => {
    for (const rung of ["sm", "md", "lg", "xl", "2xl", "3xl"]) {
      expect(base[`--radius-${rung}`], `--radius-${rung}`).toBe("0");
    }
  });

  it("names its faces and nothing else's", () => {
    expect(base["--font-sans"]).toContain("Saira");
    expect(base["--font-mono"]).toContain("Martian Mono");
  });

  it("gates every rule it adds on its own selector", () => {
    // Three of us merge into one branch. A rule that escaped the gate would
    // re-voice every other theme in the build.
    const rules = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Blank out `(…)` first: a functional pseudo-class such as
      // `:is(h1, h2, h3, h4)` carries commas that are not selector separators.
      .replace(/\(([^()]*)\)/g, (m) => m.replace(/,/g, " "))
      .split("}")
      .map((chunk) => chunk.split("{")[0].trim())
      .filter(Boolean);
    const escaped = rules.filter((sel) =>
      sel.split(",").some((s) => !s.trim().startsWith('[data-theme="scifi"]')),
    );
    expect(escaped, "every selector must start with [data-theme=\"scifi\"]").toEqual([]);
  });
});
