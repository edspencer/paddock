/**
 * make-test-clips.mjs — synthetic stand-ins for footage that does not exist yet.
 *
 * These deliberately mimic what record.mjs produces so the pipeline is exercised
 * for real: 1920x1080 VP8-in-WebM at exactly 25.000 fps CFR. Each clip also
 * carries a fake ~2.2s "page load lead-in" (a blank/settling section) so that
 * `trimStart` in the manifest has something real to cut off — if trimming
 * regressed, the lead-in would show up in the render.
 *
 * Every clip is a different hue with a large moving frame counter, so a cut is
 * unmistakable and a frozen/duplicated segment is obvious.
 *
 * Run: env -u NODE_ENV node make-test-clips.mjs
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fontEnv } from "../lib/fonts.mjs";
import { FONT_DIR, OUT_DIR } from "../lib/paths.mjs";

const run = promisify(execFile);
const OUT = path.join(OUT_DIR, "testclips");
const FPS = 25;
const LEAD_IN = 2.2; // seconds of "page still loading" before real content

const CLIPS = [
  { name: "t1-dashboard", color: "0x1d3a5f", label: "SCENE 1  dashboard", total: 9 },
  { name: "t2-chat", color: "0x4a2340", label: "SCENE 2  chat", total: 9 },
  { name: "t3-diff", color: "0x1f4034", label: "SCENE 3  diff", total: 8 },
  { name: "t4-triggers", color: "0x5a3410", label: "SCENE 4  triggers", total: 8 },
  { name: "t5-mobile", color: "0x2b2b52", label: "SCENE 5  mobile", total: 8 },
];

fs.mkdirSync(OUT, { recursive: true });

const FONT = path.join(FONT_DIR, "Inter-SemiBold.ttf");

for (const c of CLIPS) {
  const out = path.join(OUT, `${c.name}.webm`);
  // Lead-in: near-black with a faint "loading" pulse. After LEAD_IN the scene
  // colour, a testsrc panel and a running timecode appear.
  const vf = [
    `color=c=${c.color}:s=1920x1080:r=${FPS}:d=${c.total}[bg]`,
    `testsrc2=s=640x360:r=${FPS}:d=${c.total}[ts]`,
    `[bg][ts]overlay=x=1200:y=120:enable='gte(t,${LEAD_IN})'[v0]`,
    `[v0]drawtext=fontfile=${FONT}:text='${c.label}':fontcolor=white:fontsize=84:x=120:y=180:enable='gte(t,${LEAD_IN})'[v1]`,
    `[v1]drawtext=fontfile=${FONT}:text='t\\=%{pts\\:hms}  frame %{n}':fontcolor=0xd97757:fontsize=56:x=120:y=320:enable='gte(t,${LEAD_IN})'[v2]`,
    // Moving bar => motion in every frame, so a frozen segment is visible.
    `[v2]drawbox=x='mod(t*260,1800)':y=560:w=110:h=110:color=0xd97757@0.95:t=fill:enable='gte(t,${LEAD_IN})'[v3]`,
    // The lead-in itself: a dim "loading" plate that MUST be trimmed away.
    `[v3]drawtext=fontfile=${FONT}:text='(page loading — this must be trimmed)':fontcolor=0x555555:fontsize=48:x=(w-tw)/2:y=(h-th)/2:enable='lt(t,${LEAD_IN})'[v4]`,
    `[v4]drawbox=x=0:y=0:w=1920:h=1080:color=black@0.93:t=fill:enable='lt(t,${LEAD_IN})'[v]`,
  ].join(";");

  await run("ffmpeg", [
    "-y", "-v", "error", "-nostdin",
    "-filter_complex", vf, "-map", "[v]",
    "-c:v", "libvpx", "-b:v", "1M", "-crf", "10",
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-vsync", "cfr",
    "-t", String(c.total),
    out,
  ], { env: fontEnv(), maxBuffer: 1 << 28 });
  console.log(`wrote ${out}  (${c.total}s, lead-in ${LEAD_IN}s)`);
}
console.log(`\n${CLIPS.length} synthetic clips in ${OUT}`);
