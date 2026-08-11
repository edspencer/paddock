/**
 * leakscan.mjs — DOM leak scan for every route the accent-picker film visits.
 *
 * `strings foo.mp4` is NOT a leak check: rendered text is pixel data, so a clip
 * showing a live host path greps clean. The only two checks that work are
 * scanning the DOM at the states the camera sees, and watching the finished
 * clip. This is the first of those; the second is done by eye.
 *
 * Same regex family as tools/docs-media/capture.mjs, and PADDOCK_LEAK_EXTRA is
 * appended rather than hard-coded — putting a private domain in a committed
 * file in order to detect it publishes the string it guards.
 *
 * WHY THIS REPORTS VISIBILITY RATHER THAN JUST MATCHING
 * -----------------------------------------------------
 * `capture.mjs` can afford a whole-document scan because it MASKS what it finds
 * and then re-frames. Video cannot be masked after the fact, so the question is
 * narrower and more exact: is the string inside the recorded viewport rect at a
 * moment the camera is rolling? A /config page legitimately contains the data
 * dir in its Advanced (read-only) section, hundreds of pixels below the fold —
 * that is not a leak in a clip that never scrolls, and reporting it as one
 * trains you to ignore the output.
 *
 * So both numbers are printed. ONSCREEN must be zero. OFFSCREEN is recorded so
 * that anyone adding a scroll to this film knows exactly what a scroll would
 * bring into frame.
 */
import { chromium } from "playwright";
import { resolveChromium } from "../../lib/record.mjs";

const BASE = process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:5068";
const W = 1280;
const H = 800;

const LEAK = new RegExp(
  [
    String.raw`/data/`,
    String.raw`/var/lib/`,
    String.raw`127\.0\.0\.1`,
    String.raw`0\.0\.0\.0`,
    String.raw`10\.\d+\.\d+\.\d+`,
    String.raw`192\.168\.`,
    String.raw`172\.(1[6-9]|2\d|3[01])\.`,
    String.raw`@[\w-]+\.(net|com|org)`,
    ...(process.env.PADDOCK_LEAK_EXTRA ? [process.env.PADDOCK_LEAK_EXTRA] : []),
  ].join("|"),
);

const scan = async (page, label) => {
  const res = await page.evaluate(
    ([src, vw, vh]) => {
      const re = new RegExp(src, "g");
      const on = [];
      const off = [];
      // Deepest matching node only, so a match is attributed to the element
      // that actually paints it rather than to every ancestor.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.nodeValue ?? "";
        if (!t.trim()) continue;
        seen.push(t);
        const hits = [...t.matchAll(re)].map((m) => m[0]);
        if (!hits.length) continue;
        const el = n.parentElement;
        const r = el?.getBoundingClientRect();
        const style = el ? getComputedStyle(el) : null;
        const painted =
          r &&
          r.width > 0 &&
          r.height > 0 &&
          style?.visibility !== "hidden" &&
          style?.display !== "none";
        const inView = painted && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
        (inView ? on : off).push({
          hits: [...new Set(hits)],
          where: `${el?.tagName?.toLowerCase()} @ y=${Math.round(r?.top ?? -1)}`,
        });
      }
      // Attributes render as tooltips only on hover; this film hovers nothing
      // that carries one, but they are reported as offscreen for completeness.
      for (const el of document.querySelectorAll("[title],[aria-label],[alt],[href]")) {
        const v = ["title", "aria-label", "alt", "href"]
          .map((a) => el.getAttribute(a) ?? "")
          .join(" ");
        const hits = [...v.matchAll(re)].map((m) => m[0]);
        if (hits.length) off.push({ hits: [...new Set(hits)], where: `@${el.tagName.toLowerCase()}[attr]` });
      }
      return { on, off, control: seen.join(" ").includes("Paddock") };
    },
    [LEAK.source, W, H],
  );
  if (!res.control) throw new Error(`${label}: control string "Paddock" missed — scanner is broken`);
  const onHits = [...new Set(res.on.flatMap((x) => x.hits))];
  const offHits = [...new Set(res.off.flatMap((x) => x.hits))];
  console.log(
    `${onHits.length ? "LEAK " : "clean"} ${label.padEnd(24)} onscreen=[${onHits.join(", ")}] offscreen=[${offHits.join(", ")}]`,
  );
  for (const o of res.on) console.log(`        ONSCREEN ${o.where}: ${o.hits.join(", ")}`);
  return onHits.length;
};

const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("paddock:theme", "dark");
    localStorage.setItem(
      "paddock:appearance",
      JSON.stringify({ theme: "foundation", hue: null, tint: 0 }),
    );
    localStorage.removeItem("paddock:appearance-cache");
  } catch {}
});
const page = await ctx.newPage();

let bad = 0;
for (const route of ["/discover", "/projects/harbour-charts", "/"]) {
  await page.goto(BASE + route, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  bad += await scan(page, route);
}

await browser.close();
console.log(bad ? `\n${bad} ONSCREEN LEAKS — do not ship` : "\nno onscreen leaks in any filmed state");
process.exit(bad ? 1 : 0);
