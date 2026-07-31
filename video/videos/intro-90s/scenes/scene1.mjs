/**
 * scene1.mjs — Scene 1: "The problem, and the reveal" (0:00–0:12)
 *
 * Records each SHOT as its own clip rather than one long take. Assembly then
 * becomes concatenation instead of frame-accurate trimming, and any single shot
 * can be re-taken without re-recording the scene.
 *
 * Every shot does goto -> settle(LEAD_IN) -> action. Post-processing trims the
 * first LEAD_IN_TRIM seconds, which covers the blank-frame page load that
 * Playwright unavoidably captures.
 */
import { record } from "../../../lib/record.mjs";
import {
  moveCursor,
  humanHover,
  smoothScroll,
  dwell,
  settle,
  placeCursor,
} from "../../../lib/cinematics.mjs";

const BASE = process.env.QC_BASE || "https://5015.dev.projects.valfenda.net";
const LEAD_IN = 2200;

/** Load, settle, and park the cursor offscreen-ish so it doesn't jump on first move. */
async function open(page, path = "/") {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await settle(page, LEAD_IN);
  await placeCursor(page, 960, 620);
}

const shots = {
  // SHOT 1.2 — the reveal. Hard cut lands here from the terminal shot.
  // Hold still and let the whole layout read. No cursor movement: the cut
  // itself is the statement.
  async reveal(page) {
    await open(page);
    await dwell(page, 3000);
  },

  // SHOT 1.3 — the sidebar project list, with its real chat counts.
  // This replaced the "grouped into areas" shot: no area data exists, and the
  // counts (252 / 35 / 15) are the more persuasive frame anyway.
  async projects(page) {
    await open(page);
    await moveCursor(page, 143, 140, 700);
    await dwell(page, 600);
    // Drift down the project list, pausing on the two with the biggest counts.
    await moveCursor(page, 143, 277, 900); // Paddock — 252
    await dwell(page, 1100);
    await moveCursor(page, 143, 239, 600); // herdctl — 35
    await dwell(page, 900);
    await moveCursor(page, 143, 200, 600); // Warren
    await dwell(page, 1400);
  },

  // SHOT 1.4 — close on a row as unread / running indicators tick over.
  // Zoomed via CSS transform so 1080p doesn't waste pixels on empty chrome.
  async badges(page) {
    await open(page);
    await page.evaluate(() => {
      const el = document.querySelector("aside, nav, [class*='sidebar']");
      if (el) {
        el.style.transform = "scale(1.9)";
        el.style.transformOrigin = "top left";
      }
    }).catch(() => {});
    await settle(page, 800);
    await moveCursor(page, 300, 400, 800);
    await dwell(page, 2600);
  },
};

const only = process.argv[2];
const names = only ? [only] : Object.keys(shots);

for (const name of names) {
  if (!shots[name]) {
    console.error(`no such shot: ${name} (have: ${Object.keys(shots).join(", ")})`);
    process.exit(1);
  }
  const out = await record(`s1-${name}`, shots[name]);
  console.log(`OK s1-${name} -> ${out.path} (${out.ms}ms)`);
}
