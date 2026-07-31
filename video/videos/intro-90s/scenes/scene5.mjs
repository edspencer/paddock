/**
 * scene5.mjs — Scene 5: the close.
 *
 *   montage — texture: the Files tab, a rendered Mermaid diagram, file browsing
 *   close   — land on the home page, clean and still
 *
 *   env -u NODE_ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node scene5.mjs [shot]
 *
 * The montage is shot at CSS `zoom: 1.4` on #root. Mermaid sizes its SVG to the
 * container width, so at 1x a ten-node left-to-right pipeline renders with ~7px
 * node labels — present on screen but unreadable once the frame has been through
 * a 1 Mbit/s encoder. Zoom is a layout property, so the diagram genuinely
 * re-lays-out bigger rather than being scaled up and softened.
 *
 * It goes on #root, never <body>: the synthetic pointer is a position:fixed div
 * appended to <body>, and zooming the body multiplies the pointer's own
 * transform so the drawn cursor drifts away from what it is pointing at.
 */
import { record, sleep } from "../../../lib/record.mjs";
import {
  moveCursor,
  humanClick,
  smoothScroll,
  dwell,
  settle,
  placeCursor,
} from "../../../lib/cinematics.mjs";

const BASE = process.env.QC_BASE || "https://5015.dev.projects.valfenda.net";
const LEAD_IN = 2200;
const SLUG = "hushpod";

async function open(page, to, settleMs = LEAD_IN) {
  await page.goto(BASE + to, { waitUntil: "networkidle" });
  await settle(page, settleMs);
  await placeCursor(page, 1180, 700);
}

async function zoom(page, z) {
  await page.evaluate((v) => {
    document.getElementById("root").style.zoom = String(v);
  }, z);
  await sleep(600);
}

const shots = {
  // SHOT 5.1 — montage. Files list -> a Mermaid diagram rendered as real SVG ->
  // back out and into a second document. Paced slowly on purpose: at 1 Mbit/s a
  // quick pan over a diagram full of thin strokes turns to mush.
  async montage(page) {
    await open(page, `/projects/${SLUG}/files`);
    await zoom(page, 1.4);
    await placeCursor(page, 1200, 800);
    await moveCursor(page, 1180, 250, 900, { arc: 0.05 });
    await dwell(page, 900);
    await humanClick(page, "text=ARCHITECTURE.md", { moveMs: 700, postClickMs: 900 });
    await settle(page, 1400); // mermaid is a dynamic import; give it a beat to paint
    await dwell(page, 800);
    // Drift left-to-right along the pipeline, the way it reads.
    await moveCursor(page, 780, 560, 1200, { arc: 0.04 });
    await dwell(page, 700);
    await moveCursor(page, 1600, 560, 1800, { arc: 0.03 });
    await dwell(page, 1200);
    await smoothScroll(page, 420, 1500);
    await dwell(page, 1400);
    // Back out to the list and into a second file, so it reads as browsing rather
    // than one static page.
    //
    // The BREADCRUMB "Files" (nth=1), not the tab (nth=0) — and it has to be a
    // client-side route change. An earlier take fell back to `page.goto`, which
    // is a full reload and therefore drops the inline `zoom` off #root: the
    // montage started at 1.4x and silently finished at 1x.
    await humanClick(page, 'button:text-is("Files") >> nth=1', {
      moveMs: 900,
      postClickMs: 800,
    });
    await settle(page, 900);
    await humanClick(page, "text=DEPLOYMENT.md", { moveMs: 800, postClickMs: 800 });
    await settle(page, 900);
    await smoothScroll(page, 500, 1600);
    await dwell(page, 2200);
  },

  // SHOT 5.2 — the close. No cursor movement at all: the last frame of the film
  // should be the product sitting still.
  async close(page) {
    await open(page, "/", 2600);
    await placeCursor(page, 1250, 620);
    await dwell(page, 1800);
    await moveCursor(page, 960, 480, 1400, { arc: 0.04 });
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
  const out = await record(`s5-${name}`, shots[name]);
  console.log(`OK s5-${name} -> ${out.path} (${out.ms}ms)`);
}
