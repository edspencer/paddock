#!/usr/bin/env node
/**
 * build.mjs — assemble the captured stills into the demo GIF (and video).
 *
 *   node scripts/demo-gif/build.mjs [--out DIR] [--width 1200] [--fps 10]
 *                                   [--colors 64] [--no-video]
 *
 * Crossfades the beats together with ffmpeg's `xfade`, then quantises to a
 * palette. Also emits MP4/WebM of the same timeline, because a GIF is a poor
 * container for 14 seconds of UI: the video files are ~10x smaller at better
 * quality, and suit a `<video autoplay muted loop playsinline>` on a web page.
 * The GIF remains the artifact for the README, where GitHub will not play a
 * committed video file inline.
 *
 * ── Size levers, measured on this footage, biggest first ────────────────────
 *  1. `XFADE` (beats.mjs). By far the largest. The beats themselves are static,
 *     so they cost almost nothing to hold — every byte is in the transitions,
 *     where each frame changes every pixel. Measured at 1200x750/10fps/96col:
 *     0.4s → 2.6 MB, 0.3s → 1.9 MB, 0.25s → 1.6 MB. Shorten this before
 *     anything else.
 *  2. `--fps` — for the same reason: it multiplies the transition frame count.
 *     10fps is smooth enough for a cross-dissolve between static screens.
 *  3. `--colors` — a dark, flat UI needs nowhere near 256, but do not starve it:
 *     at 64 the palette swatches in the Read beat visibly shift hue (green went
 *     grey). 200 is accurate and costs little once dithering is off.
 *  4. `--dither` — set to `none`, which is both SMALLER and better here. Bayer
 *     dithering exists to hide banding in gradients; this footage is flat UI
 *     colour, so all it adds is per-pixel noise that defeats inter-frame
 *     compression. Measured at 200 colours: bayer 2.2 MB vs none 1.7 MB, and
 *     the crossfades show no banding without it. Revisit only if a future beat
 *     introduces a real gradient.
 *  Downscaling below ~1100px is a last resort: this footage is 12px UI text,
 *  and it stops being legible before it stops being large.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BEATS, XFADE, totalDuration } from "./beats.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const OUT = path.resolve(arg("out", "/tmp/paddock-demo"));
const WIDTH = Number(arg("width", "1200"));
const HEIGHT = Number(arg("height", "750"));
const FPS = Number(arg("fps", "10"));
const COLORS = Number(arg("colors", "200"));
const DITHER = arg("dither", "none");
const SHOTS = path.join(OUT, "stills");
const DIST = path.join(OUT, "dist");

const log = (...a) => console.log("[build]", ...a);
const ff = (args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
const sizeOf = (f) => fs.statSync(f).size;
const human = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

const stills = BEATS.map((b) => {
  const f = path.join(SHOTS, `${b.id}.png`);
  if (!fs.existsSync(f)) {
    throw new Error(`missing still for beat "${b.id}" (${f})\nRun: node scripts/demo-gif/shoot.mjs`);
  }
  return f;
});
fs.mkdirSync(DIST, { recursive: true });

/**
 * The xfade chain. Each transition's `offset` is when the fade STARTS on the
 * accumulated timeline, which is the previous offset plus the previous beat's
 * hold minus one crossfade — not `n * hold`, because every fade overlaps two
 * beats and so removes `XFADE` seconds from the running total.
 */
function filterChain() {
  const parts = BEATS.map(
    (_, i) => `[${i}:v]setsar=1,scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=${FPS}[v${i}]`,
  );
  let prev = "v0";
  let offset = 0;
  for (let i = 1; i < BEATS.length; i++) {
    offset += BEATS[i - 1].hold - XFADE;
    const out = i === BEATS.length - 1 ? "faded" : `x${i}`;
    parts.push(
      `[${prev}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${out}]`,
    );
    prev = out;
  }
  return parts;
}

const inputs = BEATS.flatMap((b, i) => ["-loop", "1", "-t", String(b.hold), "-i", stills[i]]);
const chain = filterChain();

// ── GIF ─────────────────────────────────────────────────────────────────────
// `stats_mode=diff` weights the palette toward the pixels that actually CHANGE
// (the crossfades) rather than the large static areas of chrome. See the header
// note on `--dither`: dithering is off by default because on flat UI colour it
// costs ~30% file size and buys nothing.
const gif = path.join(DIST, "paddock-demo.gif");
log(`assembling ${BEATS.length} beats → ${WIDTH}x${HEIGHT} @ ${FPS}fps, ${COLORS} colours`);
ff([
  ...inputs,
  "-filter_complex",
  [
    ...chain,
    "[faded]split[a][b]",
    `[a]palettegen=stats_mode=diff:max_colors=${COLORS}[p]`,
    `[b][p]paletteuse=dither=${DITHER}:diff_mode=rectangle[out]`,
  ].join(";"),
  "-map",
  "[out]",
  "-loop",
  "0",
  gif,
]);
log(`GIF   ${human(sizeOf(gif))}  ${gif}`);

// ── video ───────────────────────────────────────────────────────────────────
if (!has("no-video")) {
  const mp4 = path.join(DIST, "paddock-demo.mp4");
  ff([
    ...inputs,
    "-filter_complex",
    // yuv420p + even dimensions: required for the file to play in Safari/iOS.
    [...chain, "[faded]format=yuv420p[out]"].join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-crf",
    "23",
    "-preset",
    "veryslow",
    // Start with a keyframe and keep them frequent, so a looping <video> does
    // not flash a smeared frame on wrap.
    "-g",
    String(FPS * 2),
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    mp4,
  ]);
  log(`MP4   ${human(sizeOf(mp4))}  ${mp4}`);

  const webm = path.join(DIST, "paddock-demo.webm");
  ff([
    ...inputs,
    "-filter_complex",
    [...chain, "[faded]format=yuv420p[out]"].join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "34",
    "-b:v",
    "0",
    "-row-mt",
    "1",
    webm,
  ]);
  log(`WebM  ${human(sizeOf(webm))}  ${webm}`);
}

const probe = execFileSync("ffprobe", [
  "-v",
  "error",
  "-select_streams",
  "v:0",
  "-show_entries",
  "stream=width,height,nb_frames",
  "-of",
  "csv=p=0",
  gif,
])
  .toString()
  .trim();
log(`gif stream: ${probe}  (~${totalDuration().toFixed(1)}s loop)`);
