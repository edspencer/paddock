/**
 * verify.mjs — objective checks on an assembled timeline. No eyeballing.
 *
 * The core trick: build the SAME manifest twice, once normally and once with
 * every caption stripped. Both renders are frame-locked (identical trims,
 * identical frame counts), so a pixel diff at a given timestamp isolates the
 * caption and nothing else. That lets us assert things eyeballing cannot:
 *
 *   - the caption REGION changes when the caption should be up
 *   - everything OUTSIDE the pill is bit-identical (overlay touches nothing else)
 *   - the frame just before captionDelay is bit-identical (fade-in is gated)
 *   - the frame just after captionDuration is bit-identical (fade-out completes)
 *   - mid-fade differs from both, by less than the fully-on frame (it is a
 *     fade, not a pop)
 *   - the accent colour #d97757 is physically present in the pill
 *   - t=0 is NOT the page-load lead-in plate (the trim actually happened)
 *
 * Run: env -u NODE_ENV node video/test/verify.mjs [manifest]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, loadManifest } from "../lib/assemble.mjs";
import { probe } from "../lib/postprocess.mjs";
import { changedFraction, countNear, meanAbsDiff, readPng } from "../lib/png.mjs";
import { TMP_DIR } from "../lib/paths.mjs";
import { STYLE } from "../lib/caption.mjs";

const run = promisify(execFile);
const FPS = 25;

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
  return ok;
}

/** Extract a single frame at the MIDDLE of the frame containing time `t`. */
async function frameAt(video, t, out) {
  const n = Math.floor(t * FPS);
  const mid = (n + 0.5) / FPS;
  await run("ffmpeg", ["-y", "-v", "error", "-nostdin", "-ss", mid.toFixed(4),
    "-i", video, "-frames:v", "1", "-update", "1", out], { maxBuffer: 1 << 26 });
  return readPng(out);
}

/** moov atom before mdat == progressive download ready (faststart). */
function isFaststart(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(Math.min(1 << 20, fs.statSync(file).size));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const moov = buf.indexOf("moov"), mdat = buf.indexOf("mdat");
  return moov >= 0 && (mdat < 0 || moov < mdat);
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const manifestFile = process.argv[2] || path.join(TEST_DIR, "manifest.test.mjs");
const frameDir = path.join(TMP_DIR, "verify-frames");
fs.rmSync(frameDir, { recursive: true, force: true });
fs.mkdirSync(frameDir, { recursive: true });

console.log(`\n=== VERIFY ${path.basename(manifestFile)} ===\n`);

// --- build the captioned render and a frame-locked caption-free control -----
console.log("building captioned render…");
const rep = await assemble(manifestFile, { name: "test" });

console.log("building caption-free control render…");
const { segments, dir } = await loadManifest(manifestFile);
const stripped = path.join(TMP_DIR, "manifest.nocaption.json");
fs.writeFileSync(stripped, JSON.stringify({
  name: "test-nocap",
  segments: segments.map((s) => {
    const { caption, captionDelay, captionDuration, ...rest } = s;
    return { ...rest, clip: path.resolve(dir, s.clip) };
  }),
}, null, 2));
const repNoCap = await assemble(stripped, { name: "test-nocap", gifEnabled: false });

// ---------------------------------------------------------------- container --
console.log("\n[1] container / stream properties");
const p = await probe(rep.mp4);
console.log(`      ${JSON.stringify(p)}`);
check("codec is h264", p.codec === "h264", p.codec);
check("resolution is 1920x1080", p.width === 1920 && p.height === 1080, `${p.width}x${p.height}`);
check("pix_fmt is yuv420p", p.pixFmt === "yuv420p", p.pixFmt);
check("frame rate is exactly 25/1 CFR", p.fps === "25/1" && p.avgFps === "25/1", `r=${p.fps} avg=${p.avgFps}`);
check("faststart (moov before mdat)", isFaststart(rep.mp4));

// ------------------------------------------------------------------ duration --
console.log("\n[2] duration arithmetic");
check("final duration == sum of segment durations",
  Math.abs(rep.actualDuration - rep.sumDurations) <= 1 / FPS,
  `actual ${rep.actualDuration}s vs sum ${rep.sumDurations}s`);
check("frame count == sum of per-segment frame counts",
  rep.actualFrames === rep.segments.reduce((a, s) => a + s.frames, 0),
  `${rep.actualFrames} frames`);
check("control render is frame-identical in length",
  repNoCap.actualFrames === rep.actualFrames,
  `${repNoCap.actualFrames} vs ${rep.actualFrames}`);

// --------------------------------------------------------------------- trim --
console.log("\n[3] trim actually removed the page-load lead-in");
// The synthetic lead-in is a 93%-black plate. Real content is bright.
const f0 = await frameAt(rep.mp4, 0.06, path.join(frameDir, "t0.png"));
let lum = 0;
for (let i = 0; i < f0.data.length; i += 4) lum += f0.data[i] * 0.299 + f0.data[i + 1] * 0.587 + f0.data[i + 2] * 0.114;
lum /= f0.width * f0.height;
check("first frame is post-lead-in content, not the loading plate", lum > 20, `mean luma ${lum.toFixed(1)} (lead-in plate is ~5)`);

// ----------------------------------------------------------------- captions --
console.log("\n[4] captions are physically present, gated and faded");
const pill = { x: 0, y: STYLE.videoHeight - STYLE.bottomMargin - Math.round(STYLE.size * STYLE.pillHeightRatio) - 8,
               w: STYLE.videoWidth, h: Math.round(STYLE.size * STYLE.pillHeightRatio) + 16 };
const outside = { x: 0, y: 0, w: STYLE.videoWidth, h: pill.y - 4 };
const accentRgb = [0xd9, 0x77, 0x57];

for (const s of rep.segments) {
  if (!s.caption) continue;
  const tag = `s${s.index}`;
  const mid = (s.captionIn + s.captionOut) / 2;
  const before = s.captionIn - 0.16;                       // before fade-in starts
  const after = Math.min(s.timelineOut - 0.06, s.captionOut + 0.16); // after fade-out ends
  const midFade = s.captionIn + STYLE.fadeIn / 2;          // halfway through fade-in

  const [aMid, bMid] = await Promise.all([
    frameAt(rep.mp4, mid, path.join(frameDir, `${tag}-mid-cap.png`)),
    frameAt(repNoCap.mp4, mid, path.join(frameDir, `${tag}-mid-nocap.png`)),
  ]);
  const fracPill = changedFraction(aMid, bMid, pill, 12);
  const diffMid = meanAbsDiff(aMid, bMid, pill);
  const accentPx = countNear(aMid, accentRgb, pill, 40);

  /*
   * NOISE FLOOR. The two renders are separate x264 encodes, so even regions
   * the overlay never touches differ by a fraction of a level: adding a
   * caption later in the GOP changes reference frames and rate-control
   * decisions everywhere. Measured on the photographic still segment that is
   * ~0.03-0.10 meanAbsDiff, vs ~9-15 where a caption actually is — a ~100x
   * margin. So the assertions are stated as signal-vs-noise, not as
   * bit-equality, which would fail for reasons that have nothing to do with
   * captions.
   */
  const noise = meanAbsDiff(aMid, bMid, outside);
  const FLOOR = Math.max(0.5, noise * 8);

  console.log(`\n    segment ${s.index} "${s.caption}"  caption ${s.captionIn.toFixed(2)}–${s.captionOut.toFixed(2)}s`);
  console.log(`      noise floor outside the pill: ${noise.toFixed(3)} meanAbsDiff -> threshold ${FLOOR.toFixed(3)}`);
  check(`  [${tag}] caption region differs while caption is up`, fracPill > 0.02 && diffMid > FLOOR * 4,
    `${(fracPill * 100).toFixed(2)}% of lower-third pixels changed, meanAbsDiff ${diffMid.toFixed(2)} (>${(FLOOR * 4).toFixed(2)})`);
  check(`  [${tag}] overlay is confined to the lower third`, noise < diffMid / 50,
    `outside ${noise.toFixed(3)} vs pill ${diffMid.toFixed(2)} — ${(diffMid / Math.max(noise, 1e-6)).toFixed(0)}x`);
  check(`  [${tag}] accent #d97757 present in the pill`, accentPx > 100, `${accentPx} accent px`);

  const [aBefore, bBefore] = await Promise.all([
    frameAt(rep.mp4, before, path.join(frameDir, `${tag}-before-cap.png`)),
    frameAt(repNoCap.mp4, before, path.join(frameDir, `${tag}-before-nocap.png`)),
  ]);
  const diffBefore = meanAbsDiff(aBefore, bBefore, pill);
  check(`  [${tag}] no caption before captionDelay`, diffBefore < FLOOR,
    `t=${before.toFixed(2)}s pill meanAbsDiff ${diffBefore.toFixed(3)} (<${FLOOR.toFixed(3)})`);

  const [aAfter, bAfter] = await Promise.all([
    frameAt(rep.mp4, after, path.join(frameDir, `${tag}-after-cap.png`)),
    frameAt(repNoCap.mp4, after, path.join(frameDir, `${tag}-after-nocap.png`)),
  ]);
  const diffAfter = meanAbsDiff(aAfter, bAfter, pill);
  check(`  [${tag}] caption gone after captionDuration`, diffAfter < FLOOR,
    `t=${after.toFixed(2)}s pill meanAbsDiff ${diffAfter.toFixed(3)} (<${FLOOR.toFixed(3)})`);

  const [aFade, bFade] = await Promise.all([
    frameAt(rep.mp4, midFade, path.join(frameDir, `${tag}-fade-cap.png`)),
    frameAt(repNoCap.mp4, midFade, path.join(frameDir, `${tag}-fade-nocap.png`)),
  ]);
  const diffFade = meanAbsDiff(aFade, bFade, pill);
  check(`  [${tag}] mid-fade is partial, not a hard pop`, diffFade > FLOOR && diffFade < diffMid * 0.92,
    `mid-fade meanAbsDiff ${diffFade.toFixed(2)}, between floor ${FLOOR.toFixed(2)} and fully-on ${diffMid.toFixed(2)}`);
}

// -------------------------------------------------------------------- stills --
console.log("\n[5] stills");
const stillSeg = rep.segments.find((s) => s.still);
if (stillSeg) {
  const a = await frameAt(rep.mp4, stillSeg.timelineIn + 0.2, path.join(frameDir, "still-a.png"));
  const b = await frameAt(rep.mp4, stillSeg.timelineOut - 0.2, path.join(frameDir, "still-b.png"));
  check("PNG still segment holds a steady frame", meanAbsDiff(a, b) < 1.5,
    `meanAbsDiff across the still ${meanAbsDiff(a, b).toFixed(3)}`);
  check("PNG still segment is not blank", (() => {
    let s = 0; for (let i = 0; i < a.data.length; i += 4) s += a.data[i];
    return s / (a.width * a.height) > 8;
  })());
}

// ----------------------------------------------------------------------- gif --
console.log("\n[6] gif");
if (rep.gif && fs.existsSync(rep.gif)) {
  const g = await probe(rep.gif);
  const mb = fs.statSync(rep.gif).size / 1e6;
  console.log(`      ${JSON.stringify(g)}  ${mb.toFixed(2)} MB`);
  check("gif exists and is 960px wide", g.width === 960, `${g.width}x${g.height}`);
  check("gif duration matches the mp4 within 0.2s", Math.abs(g.durationSec - rep.actualDuration) < 0.2,
    `${g.durationSec}s vs ${rep.actualDuration}s`);
  check("gif size is sane for its length", mb / rep.actualDuration < 0.9, `${(mb / rep.actualDuration).toFixed(2)} MB/s`);
}

// ----------------------------------------------------------------- crossfade --
console.log("\n[7] crossfade join");
const xf = 0.4;
const repX = await assemble(manifestFile, { name: "test-xfade", crossfade: xf, gifEnabled: false });
const expectX = rep.sumDurations - xf * (rep.segments.length - 1);
check("crossfade total == sum - overlap", Math.abs(repX.actualDuration - expectX) <= 2 / FPS,
  `${repX.actualDuration}s vs expected ${expectX.toFixed(3)}s (${rep.segments.length - 1} x ${xf}s overlap)`);
{
  // At a cut boundary the crossfade render must be a BLEND of the two shots,
  // i.e. different from either hard-cut neighbour.
  const b = rep.segments[1].timelineOut;             // hard-cut boundary
  const at = b - xf / 2 - (rep.segments.length > 1 ? xf * 1 : 0); // inside xfade #2
  const fx = await frameAt(repX.mp4, Math.max(0.1, at), path.join(frameDir, "xfade-mid.png"));
  const fh = await frameAt(rep.mp4, Math.max(0.1, at), path.join(frameDir, "xfade-ref.png"));
  check("crossfade render differs from the hard-cut render", meanAbsDiff(fx, fh) > 1,
    `meanAbsDiff ${meanAbsDiff(fx, fh).toFixed(2)}`);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) { console.log("failed:", failures.join("; ")); process.exit(1); }
console.log(`frames written to ${frameDir}`);
