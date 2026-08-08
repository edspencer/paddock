/**
 * postprocess.mjs — ffprobe + webm->mp4 conversion helpers.
 *
 * Playwright always emits VP8-in-WebM at a hard-coded 25fps and only
 * `-b:v 1M`, which is a LOW bitrate for 1080p. Re-encoding to H.264 cannot
 * recover the lost detail, but it does make the file usable in editors
 * (Resolve/Premiere/FCP choke on VP8) and playable everywhere.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

/** Full ffprobe summary for a media file. */
export async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries",
    "stream=codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,pix_fmt:format=duration,size,bit_rate",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
  return {
    file,
    codec: v.codec_name,
    width: Number(v.width),
    height: Number(v.height),
    fps: v.r_frame_rate,
    avgFps: v.avg_frame_rate,
    pixFmt: v.pix_fmt,
    durationSec: Number(j.format?.duration),
    bytes: Number(j.format?.size),
    bitrate: Number(j.format?.bit_rate),
  };
}

/** Exact decoded frame count (slow-ish; decodes the whole file). */
export async function countFrames(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file,
  ]);
  return Number(stdout.trim());
}

/**
 * Convert to H.264 mp4.
 * @param {string} src .webm from record()
 * @param {object} [opts]
 * @param {string} [opts.out]      defaults to src with .mp4
 * @param {number} [opts.crf=18]   visually lossless-ish relative to the source
 * @param {number} [opts.fps]      output fps (omit = keep source 25)
 */
export async function toMp4(src, opts = {}) {
  const { out = src.replace(/\.webm$/i, ".mp4"), crf = 18, fps, preset = "slow" } = opts;
  const args = [
    "-y", "-v", "error", "-i", src,
    ...(fps ? ["-r", String(fps)] : []),
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    // yuv420p + even dimensions => plays in QuickTime/browsers/social.
    "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-movflags", "+faststart",
    out,
  ];
  await run("ffmpeg", args, { maxBuffer: 1 << 26 });
  return out;
}

// CLI: node postprocess.mjs <file.webm> [--mp4]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node postprocess.mjs <file.webm> [--mp4]");
    process.exit(1);
  }
  console.log(await probe(file));
  console.log("frames:", await countFrames(file));
  if (process.argv.includes("--mp4")) {
    const out = await toMp4(file);
    console.log("mp4:", out);
    console.log(await probe(out));
  }
}
