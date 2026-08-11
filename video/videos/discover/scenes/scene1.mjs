/**
 * scene1.mjs — "Discover": the first screen a new instance shows.
 *
 * Serves the 0.68 What's New entry, which currently has no image at all.
 * Discover is a PROCESS — scan, list, choose, import, projects appear with
 * their conversations — which is the thing a still cannot carry.
 *
 * ⛔ SHOT ORDER IS LOAD-BEARING. Import is ONE-WAY: it consumes the candidates,
 * and after it runs /discover has nothing left to list. So the two
 * non-destructive shots (`land`, `choose`) MUST be recorded before `import`,
 * and a retake of either means re-running seed-discover.mjs first. Recording
 * them in the wrong order does not fail — it silently yields an empty list.
 *
 * ⛔ DO NOT TOUCH the "Also offer directories outside /home/mara (3 hidden)"
 * toggle. The hidden three are earlier seed attempts still sitting under the
 * rig's real /data path; flipping it puts host paths on screen in the largest
 * text on the page. It is left visible deliberately — it is real UI, and its
 * OFF state is honest — but the cursor never goes near it.
 *
 * The candidate paths read /home/mara/code/… rather than a host path because
 * the rig's HOME really is /home/mara. See launch-discover.sh: symlinking a
 * pretty path does not work, because Paddock canonicalises for display and the
 * leak masker then blanks what it resolves to.
 */
import { record } from "../../../lib/record.mjs";
import { humanClick, dwell, settle, placeCursor } from "../../../lib/cinematics.mjs";

const BASE = process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:5069";
const W = 1280;
const H = 800;
const LEAD_IN = 2200;

/** Foundation, dark, hue: null, tint: 0 — the out-of-box default. */
const PIN = () => {
  try {
    if (localStorage.getItem("__pinned_appearance")) return;
    localStorage.setItem("paddock:theme", "dark");
    localStorage.setItem(
      "paddock:appearance",
      JSON.stringify({ theme: "foundation", hue: null, tint: 0 }),
    );
    localStorage.removeItem("paddock:appearance-cache");
    localStorage.setItem("__pinned_appearance", "1");
  } catch {}
};

async function open(page, path) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await settle(page, LEAD_IN);
  await placeCursor(page, 700, 640);
}

/** Fail loudly rather than filming an empty list. */
async function assertCandidates(page, n) {
  const txt = await page.evaluate(() => document.body.innerText);
  const m = txt.match(/Import (\d+) project/);
  if (!m) throw new Error("no Import button — /discover has no candidates; re-run seed-discover.mjs");
  if (Number(m[1]) !== n) throw new Error(`expected ${n} candidates, found ${m[1]}`);
}

const shots = {
  // BEATS 1-2 — land on Discover. The list, the counts and the last-active
  // dates are the whole statement; no cursor movement, let it read.
  async land(page) {
    await open(page, "/discover");
    await assertCandidates(page, 3);
    await dwell(page, 4000);
  },

  // BEAT 3 — choosing. The storyboard said "tick two"; in the shipping UI all
  // candidates arrive ALREADY ticked, so the honest demonstration of the same
  // control is to UNtick one and watch the action button count down to 2.
  async choose(page) {
    await open(page, "/discover");
    await assertCandidates(page, 3);
    await dwell(page, 800);
    await humanClick(page, 'input[type=checkbox] >> nth=2');
    await dwell(page, 2600);
  },

  // BEATS 4-5 — the import itself, then the result with the new projects live
  // in the sidebar. DESTRUCTIVE: consumes the candidates.
  //
  // The untick is REPEATED here even though `choose` already showed it, and it
  // is then trimmed out of the cut. Selection is client state, so a fresh
  // browser context arrives with all three ticked again — without this the film
  // cuts from "Import 2 projects" straight to a result reading "3 projects,
  // 9 conversations", and the count visibly jumps back up across the join.
  // Re-doing the action off-camera is what makes the two shots one story.
  async import(page) {
    await open(page, "/discover");
    await page.locator("input[type=checkbox]").nth(2).click();
    await settle(page, 900);
    await humanClick(page, 'button:has-text("Import")', { moveMs: 800 });
    await settle(page, 1500);
    await dwell(page, 4000);
  },

  // BEAT 6 — the imported conversations are really there, not just the folder.
  async chat(page) {
    await open(page, "/projects/harbour-charts");
    await dwell(page, 3600);
  },
};

const only = process.argv[2];
const names = only ? [only] : Object.keys(shots);

for (const name of names) {
  if (!shots[name]) {
    console.error(`no such shot: ${name} (have: ${Object.keys(shots).join(", ")})`);
    process.exit(1);
  }
  const out = await record(`discover-${name}`, shots[name], {
    width: W,
    height: H,
    onPage: (page) => page.addInitScript(PIN),
  });
  console.log(`OK discover-${name} -> ${out.path} (${out.ms}ms)`);
}
