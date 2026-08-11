/**
 * scene1.mjs — "Appearance": the accent picker and the four themes.
 *
 * One clip per shot, per the harness doctrine: a bad take costs a shot, not the
 * film, and assembly is concatenation rather than frame-accurate trimming.
 *
 * WHAT THIS CLIP CLAIMS, AND WHAT IT DELIBERATELY DOES NOT
 * --------------------------------------------------------
 * The subject is "change the accent and the whole UI follows". It is NOT "you
 * cannot pick an unreadable colour". `solve()`'s `hit` is discarded and
 * `report.ok` is never surfaced (#813, #816), so there is no enforced AA
 * guarantee to demonstrate, and no beat here shows a colour being rejected or
 * clamped. If you re-cut this, keep the captions off that claim.
 *
 * FRAMING
 * -------
 * 1280x800 — the same geometry as the other docs clips in website/public/demo/,
 * and the size at which the whole Appearance panel is above the fold: theme
 * cards, the hue strip, the named chips, the tint control and the PREVIEW row
 * (Send / Cancel / A link / accent chip / running) all in one frame, with the
 * accented sidebar down the left. The recolour is legible because five
 * different accented surfaces move at once.
 *
 * `recordVideo.size` must equal the viewport or Playwright pads with grey
 * rather than scaling, so both come from ONE pair of constants below.
 *
 * THEME PINNING
 * -------------
 * Appearance is client-side across three localStorage keys read by a PRE-PAINT
 * inline script (packages/web/index.html). `page.evaluate` after `goto` is too
 * late — you get a flash, or a frame captured mid-swap. So the keys are written
 * in `addInitScript`, which runs before any page script on every navigation.
 *
 * The pin is IDEMPOTENT (guarded by a sentinel key) on purpose: this film's
 * whole point is that the accent changes on camera and survives a route change.
 * An unconditional init script would reset the accent on every navigation and
 * quietly destroy the `persist` shot — which would still look fine, just wrong.
 *
 * `paddock:appearance-cache` is removed rather than left: it is keyed
 * <theme>:<dark|light>, so a stale entry paints the PREVIOUS accent for one
 * frame before React boots, and a shot that starts early catches it.
 */
import { record } from "../../../lib/record.mjs";
import { humanClick, dwell, settle, placeCursor } from "../../../lib/cinematics.mjs";

const BASE = process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:5068";
const W = 1280;
const H = 800;
const LEAD_IN = 2200;

/** Foundation, dark, hue: null, tint: 0 — the verified out-of-box default. */
const PIN = () => {
  try {
    if (localStorage.getItem("__pinned_appearance")) return; // see THEME PINNING
    localStorage.setItem("paddock:theme", "dark");
    localStorage.setItem(
      "paddock:appearance",
      JSON.stringify({ theme: "foundation", hue: null, tint: 0 }),
    );
    localStorage.removeItem("paddock:appearance-cache");
    localStorage.setItem("__pinned_appearance", "1");
  } catch {}
};

/** Load, settle, park the cursor so the first move doesn't teleport. */
async function open(page, path = "/config") {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await settle(page, LEAD_IN);
  await placeCursor(page, 660, 700);
}

/**
 * Assert the pin actually took, rather than trusting it. Do NOT verify a theme
 * by grepping CSS: OKLCH serialises as `oklch(...)` and `--accent` is a bare
 * RGB triple, so a regex reader scores a themed build zero.
 */
async function assertDefaultAppearance(page) {
  const got = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    stored: localStorage.getItem("paddock:appearance"),
  }));
  if (!got.dark) throw new Error(`expected dark mode, got ${JSON.stringify(got)}`);
  if (!/"theme":"foundation"/.test(got.stored ?? "")) {
    throw new Error(`expected foundation, got ${got.stored}`);
  }
  if (!got.accent) throw new Error("no --accent resolved — is this the redesigned build?");
  return got;
}

const hue = (name) => `button:text-is("${name}")`;
const themeCard = (name) => `button[title^="${name} —"]`;

const shots = {
  // BEAT 1 — establish. No cursor movement: let the panel read.
  async open(page) {
    await open(page);
    await assertDefaultAppearance(page);
    await dwell(page, 3200);
  },

  // BEATS 2-3 — three recolours. Every accented surface moves together: the
  // sidebar wordmark, the Config row, the chip borders, the PREVIEW row's
  // Send button, link and running dot. Holds are long because at VP8 1 Mbit/s
  // the still frames are where the detail actually resolves.
  async hues(page) {
    await open(page);
    await assertDefaultAppearance(page);
    await humanClick(page, hue("Teal"));
    await dwell(page, 2200);
    await humanClick(page, hue("Ember"), { moveMs: 520 });
    await dwell(page, 1500);
    await humanClick(page, hue("Violet"), { moveMs: 520 });
    await dwell(page, 2600);
  },

  // BEAT 4 — the accent survives a route change. The pick happens on camera so
  // the state is genuinely produced rather than staged, then the manifest trims
  // in just before the navigation; nothing here is faked, it is only cropped.
  async persist(page) {
    await open(page);
    await assertDefaultAppearance(page);
    await humanClick(page, hue("Violet"));
    await dwell(page, 1200);
    await humanClick(page, 'a:has-text("Tidepool")', { moveMs: 800 });
    await settle(page, 900);
    await dwell(page, 3000);
  },

  // BEATS 5-6 — the four themes. Ground, type and chrome change together, so
  // this is the one shot where the whole frame moves; hold longer still.
  async themes(page) {
    await open(page);
    await assertDefaultAppearance(page);
    await humanClick(page, themeCard("Parchment"));
    await dwell(page, 2400);
    await humanClick(page, themeCard("Terminal"), { moveMs: 520 });
    await dwell(page, 1800);
    await humanClick(page, themeCard("Sci-Fi"), { moveMs: 520 });
    await dwell(page, 3200);
  },
};

const only = process.argv[2];
const names = only ? [only] : Object.keys(shots);

for (const name of names) {
  if (!shots[name]) {
    console.error(`no such shot: ${name} (have: ${Object.keys(shots).join(", ")})`);
    process.exit(1);
  }
  const out = await record(`accent-${name}`, shots[name], {
    width: W,
    height: H,
    onPage: (page) => page.addInitScript(PIN),
  });
  console.log(`OK accent-${name} -> ${out.path} (${out.ms}ms)`);
}
