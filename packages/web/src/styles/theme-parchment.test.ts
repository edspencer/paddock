/**
 * The contrast guard for the `parchment` theme.
 *
 * `tokens.test.ts` parses `tokens.css` — the foundation palette — and nothing
 * else, so a runtime theme is not covered by it. This is the same suite of
 * assertions pointed at this theme's own blocks, plus the two things that are
 * particular to it:
 *
 *   - the WINE CHROME scope. The sidebar redeclares the token set to a wine
 *     ramp, so every foreground in that column is sitting on a surface no other
 *     theme has. Untested, that is exactly where an unreadable label hides.
 *   - the CARD-ON-CANVAS separation. `main` shipped 1.08:1 between a card and
 *     the page behind it, which is why the app reads flat. This theme claims a
 *     real separation, so the claim is asserted rather than admired.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, inSrgbGamut, resolveColor, rgbToOklch, toHex } from "../lib/color";

const SRC = resolve(process.cwd(), "src");
const css = readFileSync(join(SRC, "styles/theme-parchment.css"), "utf-8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * Read one selector's declarations. Deliberately not `parseTokenCss`: that one
 * regex-escapes only `.`, and these selectors carry brackets, quotes and
 * `:not()`. Takes the FIRST matching block — the base selector appears twice
 * (tokens at the top, the numerals rule at the bottom) and only the first
 * carries custom properties.
 */
function block(selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  if (!m) throw new Error(`no \`${selector}\` block in theme-parchment.css`);
  const out: Record<string, string> = {};
  for (const decl of m[1].split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const name = decl.slice(0, i).trim();
    if (name.startsWith("--")) out[name] = decl.slice(i + 1).trim();
  }
  return out;
}

const base = block('[data-theme="parchment"]');
const MODES = {
  light: { ...base, ...block('[data-theme="parchment"]:not(.dark)') },
  dark: { ...base, ...block('[data-theme="parchment"].dark') },
} as const;

/**
 * The sidebar scope, resolved per mode: the same rule, but with the wine ramp
 * mapped onto the semantic names exactly as the CSS does it.
 */
const CHROME = block('[data-theme="parchment"] aside');
const chromeVars = (mode: "light" | "dark") => ({ ...MODES[mode], ...CHROME });

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

function ratio(vars: Record<string, string>, fg: string, bg: string): number {
  return contrastRatio(resolveColor(`var(${fg})`, vars), resolveColor(`var(${bg})`, vars));
}
function label(vars: Record<string, string>, fg: string, bg: string): string {
  const f = toHex(resolveColor(`var(${fg})`, vars));
  const b = toHex(resolveColor(`var(${bg})`, vars));
  return `${fg} (${f}) on ${bg} (${b}) = ${ratio(vars, fg, bg).toFixed(2)}:1`;
}

describe.each(["light", "dark"] as const)("parchment — %s", (mode) => {
  const vars = MODES[mode];

  it.each(FOREGROUNDS.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))(
    "%s on %s clears 4.5:1",
    (fg, bg) => {
      expect(ratio(vars, fg, bg), label(vars, fg, bg)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(HUES)("%s reads on every surface it is used on", (hue) => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken", `--${hue}-soft`]) {
      expect(
        ratio(vars, `--${hue}-text`, bg),
        label(vars, `--${hue}-text`, bg),
      ).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it.each(HUES)("%s foreground reads on its own solid fill", (hue) => {
    expect(
      ratio(vars, `--${hue}-fg`, `--${hue}-solid`),
      label(vars, `--${hue}-fg`, `--${hue}-solid`),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("the wine button carries its foreground", () => {
    for (const fill of ["--accent-solid", "--accent-solid-hover"]) {
      expect(
        ratio(vars, "--accent-fg", fill),
        label(vars, "--accent-fg", fill),
      ).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it("border-strong is a visible control boundary (3:1) on every surface", () => {
    for (const bg of ["--surface", "--surface-raised", "--surface-sunken"]) {
      expect(
        ratio(vars, "--border-strong", bg),
        label(vars, "--border-strong", bg),
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  /* The headline claim of this direction: a card is an OBJECT on the field, not
     a hairline on it.
     Measured as a PERCEPTUAL lightness gap, not a WCAG ratio. A ratio is the
     wrong instrument for two adjacent surfaces in dark mode — the +0.05 term
     dominates down there, so the same visible step scores ~1.18 dark and ~1.32
     light and the assertion would be about the mode rather than about the
     design. `main` ships a 0.027 gap (#fff on #f7f6f1), which is why the app
     reads flat; this asks for roughly double that, in both modes. */
  it("a parchment card is genuinely separated from the ground", () => {
    const gap =
      rgbToOklch(resolveColor("var(--surface-raised)", vars)).L -
      rgbToOklch(resolveColor("var(--surface)", vars)).L;
    expect(gap, `card-on-canvas lightness gap = ${gap.toFixed(3)}`).toBeGreaterThanOrEqual(0.05);
  });

  it("the surface ladder is ordered and separable", () => {
    const c = (n: string) => resolveColor(`var(${n})`, vars);
    expect(contrastRatio(c("--surface-sunken"), c("--surface"))).toBeGreaterThan(1.02);
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

  /* ------------------------------------------------------- the wine column -- */
  describe("the wine chrome (the sidebar's redeclared scope)", () => {
    const vars = chromeVars(mode);
    const CHROME_SURFACES = [
      "--surface",
      "--surface-raised",
      "--surface-hover",
      "--surface-active",
      "--surface-selected",
    ] as const;

    it.each(
      (["--text", "--text-muted", "--text-subtle", "--accent-text"] as const).flatMap((fg) =>
        CHROME_SURFACES.map((bg) => [fg, bg] as const),
      ),
    )("%s on the wine's %s clears 4.5:1", (fg, bg) => {
      expect(ratio(vars, fg, bg), label(vars, fg, bg)).toBeGreaterThanOrEqual(AA_BODY);
    });

    it("border-strong stays a visible boundary on the wine", () => {
      for (const bg of ["--surface", "--surface-raised"]) {
        expect(
          ratio(vars, "--border-strong", bg),
          label(vars, "--border-strong", bg),
        ).toBeGreaterThanOrEqual(AA_LARGE);
      }
    });
  });
});

describe("the runtime-brandable accent seam (#34)", () => {
  const BRANDED = {
    "--accent": "20 80 160",
    "--accent-600": "17 69 138",
    "--accent-700": "14 57 114",
  };

  it.each(["light", "dark"] as const)("%s: accent tokens follow an injected brand", (mode) => {
    const bare = MODES[mode];
    const branded = { ...bare, ...BRANDED };
    for (const token of [
      "--accent-color",
      "--accent-solid",
      "--accent-text",
      "--accent-soft",
      "--accent-border",
    ]) {
      expect(
        toHex(resolveColor(`var(${token})`, branded)),
        `${token} ignored the injected brand accent`,
      ).not.toBe(toHex(resolveColor(`var(${token})`, bare)));
    }
  });

  it("declares the three channel variables in channel form, in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const name of ["--accent", "--accent-600", "--accent-700"]) {
        expect(MODES[mode][name], `${mode} ${name} must stay space-separated sRGB`).toMatch(
          /^\d+\s+\d+\s+\d+$/,
        );
      }
    }
  });

  /* The picker hands the theme a HUE and the solver keeps the theme's chroma.
     The sidebar's selected row mixes that accent into the wine, so a hue the
     theme never saw must still leave the row's label readable. */
  it("the wine column survives an accent hue that is not the wine", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const [name, channels] of Object.entries({
        forest: "26 92 54",
        sky: "24 72 150",
        amber: "128 96 12",
      })) {
        const vars = { ...chromeVars(mode), "--accent": channels };
        for (const bg of ["--surface-selected", "--accent-soft"]) {
          expect(
            ratio(vars, "--text", bg),
            `${mode}/${name}: ${label(vars, "--text", bg)}`,
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
      }
    }
  });
});
