/**
 * assemble.mjs — manifest-driven timeline builder.
 *
 * Takes a list of segments:
 *   { clip, trimStart, duration, caption?, captionDelay?, captionDuration? }
 * and emits final.mp4 (H.264 / yuv420p / faststart) plus final.gif, with a
 * per-segment duration report so the cut can be read against a 90s target.
 *
 * DESIGN NOTES THAT MATTER
 * ------------------------
 * 1. ONE encode generation, not N. Every source is decoded and encoded exactly
 *    once, into a normalised intermediate (same codec, size, fps, pix_fmt, SAR).
 *    Hard cuts are then joined with the concat DEMUXER and `-c copy`, so the
 *    join costs zero additional recompression. Naively re-encoding the
 *    concatenation is what stacks artefacts, and at Playwright's 1 Mbit VP8
 *    source bitrate there is no detail left to spend.
 *    The `--crossfade` path is the one exception and is documented below.
 *
 * 2. Duration is frame-exact, not "roughly right". Each segment is cut with
 *    `-frames:v round(duration * fps)`, which is a hard frame count rather than
 *    a timestamp ffmpeg may round. Sum of segments == final duration, and
 *    assemble verifies that by probing the output.
 *
 * 3. Trimming uses input `-ss`. Recorded clips carry ~2.2s of page-load
 *    lead-in; that is the `trimStart` a manifest should be cutting off.
 *    If trimStart+duration overruns the source, the last frame is cloned (so
 *    the render still completes) and a LOUD warning is printed — a silent
 *    short segment would desync every caption after it.
 *
 * 4. Captions never enter the filter-graph string. caption.mjs rasterises them
 *    to a full-frame RGBA PNG; here they are just `overlay=0:0` with an alpha
 *    fade envelope. See caption.mjs for why.
 *
 * CLI:
 *   env -u NODE_ENV node video/lib/assemble.mjs <manifest.(json|mjs)> [options]
 *     --out DIR          output dir (default $PADDOCK_VIDEO_OUT — see paths.mjs)
 *     --name NAME        basename for outputs (default "final")
 *     --crossfade SECS   crossfade between every segment (default 0 = hard cut)
 *     --no-gif           skip the gif
 *     --gif-width PX     default 960
 *     --gif-fps N        default 12
 *     (intermediate segments are always kept in <out>/<name>-segments/)
 *     --target SECS      duration target to report against (default 90)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderCaption } from "./caption.mjs";
import { OUT_DIR } from "./paths.mjs";
import { probe } from "./postprocess.mjs";

const run = promisify(execFile);

export const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 25,
  /** Intermediates are cut deliberately fine-grained; the join is lossless. */
  segmentCrf: 16,
  finalCrf: 18,
  preset: "medium",
  crossfade: 0,
  target: 90,
  gif: { width: 960, fps: 12, colors: 128 },
};

const STILL_RE = /\.(png|jpe?g|webp|bmp|tiff?)$/i;

function fmt(n, d = 3) { return Number(n).toFixed(d); }
function tc(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${fmt(s - m * 60, 2).padStart(5, "0")}`;
}

async function ffmpeg(args, label) {
  try {
    return await run("ffmpeg", args, { maxBuffer: 1 << 28 });
  } catch (e) {
    const tail = String(e.stderr || e.message).trim().split("\n").slice(-14).join("\n");
    throw new Error(`ffmpeg failed (${label}):\n${tail}\n\nargs: ${args.join(" ")}`);
  }
}

/** Exact frame count without decoding the whole file (uses the container index). */
async function frameCount(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-count_packets", "-show_entries", "stream=nb_read_packets",
    "-of", "csv=p=0", file,
  ]);
  return Number(stdout.trim());
}

/** Load a manifest from .json or an ES module with a default export. */
export async function loadManifest(file) {
  const abs = path.resolve(file);
  let raw;
  if (/\.json$/i.test(abs)) raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  else raw = (await import(pathToFileURL(abs).href)).default;
  const segments = Array.isArray(raw) ? raw : raw.segments;
  if (!Array.isArray(segments) || !segments.length) {
    throw new Error(`manifest ${abs} has no segments`);
  }
  const opts = Array.isArray(raw) ? {} : { ...raw, segments: undefined };
  return { segments, opts, dir: path.dirname(abs) };
}

function normaliseSegment(seg, i, dir, cfg) {
  const clip = path.resolve(dir, seg.clip);
  if (!fs.existsSync(clip)) throw new Error(`segment ${i}: clip not found: ${clip}`);
  const duration = Number(seg.duration);
  if (!(duration > 0)) throw new Error(`segment ${i}: duration must be > 0 (got ${seg.duration})`);
  const still = STILL_RE.test(clip);
  const trimStart = still ? 0 : Number(seg.trimStart ?? 0);
  if (!(trimStart >= 0)) throw new Error(`segment ${i}: trimStart must be >= 0`);

  const caption = seg.caption ?? null;
  const captionDelay = caption ? Number(seg.captionDelay ?? 0.35) : 0;
  const captionDuration = caption
    ? Number(seg.captionDuration ?? Math.max(1.2, duration - captionDelay - 0.25))
    : 0;
  if (caption && captionDelay + captionDuration > duration + 1e-6) {
    throw new Error(
      `segment ${i} ("${caption}"): captionDelay ${captionDelay} + captionDuration ` +
      `${captionDuration} = ${captionDelay + captionDuration}s exceeds segment duration ${duration}s`,
    );
  }
  return {
    index: i, clip, still, trimStart, duration, caption, captionDelay, captionDuration,
    frames: Math.round(duration * cfg.fps),
    captionStyle: seg.captionStyle ?? null,
  };
}

/** Build one normalised, captioned intermediate. */
async function renderSegment(seg, cfg, captionPng, workDir) {
  const out = path.join(workDir, `seg-${String(seg.index).padStart(2, "0")}.mp4`);
  const inputs = [];

  if (seg.still) {
    inputs.push("-loop", "1", "-framerate", String(cfg.fps), "-t", fmt(seg.duration + 0.5), "-i", seg.clip);
  } else {
    if (seg.trimStart > 0) inputs.push("-ss", fmt(seg.trimStart));
    inputs.push("-i", seg.clip);
  }
  if (captionPng) {
    inputs.push("-loop", "1", "-framerate", String(cfg.fps), "-t", fmt(seg.duration + 0.5), "-i", captionPng);
  }

  // Base chain: force CFR, letterbox to the target frame, square pixels, and
  // clone the tail if the source runs out (see design note 3).
  const base =
    `[0:v]fps=${cfg.fps},` +
    `scale=${cfg.width}:${cfg.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${cfg.width}:${cfg.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,tpad=stop_mode=clone:stop_duration=${fmt(seg.duration + 1)},` +
    `format=yuv420p,setpts=PTS-STARTPTS[base]`;

  let graph, mapLabel;
  if (captionPng) {
    const fi = cfg.captionFadeIn, fo = cfg.captionFadeOut;
    const inAt = seg.captionDelay;
    const outAt = seg.captionDelay + seg.captionDuration - fo;
    // fade holds the "faded" state OUTSIDE its window, so a single always-present
    // caption stream with fade-in at `inAt` and fade-out ending at inAt+dur gives
    // the exact envelope with no PTS shifting and no `enable=` expression.
    graph =
      `${base};` +
      `[1:v]format=rgba,setpts=PTS-STARTPTS,` +
      `fade=t=in:st=${fmt(inAt)}:d=${fmt(fi)}:alpha=1,` +
      `fade=t=out:st=${fmt(Math.max(inAt, outAt))}:d=${fmt(fo)}:alpha=1[cap];` +
      `[base][cap]overlay=0:0:format=yuv420:eof_action=pass[v]`;
    mapLabel = "[v]";
  } else {
    graph = base;
    mapLabel = "[base]";
  }

  await ffmpeg([
    "-y", "-v", "error", "-nostdin",
    ...inputs,
    "-filter_complex", graph,
    "-map", mapLabel,
    "-frames:v", String(seg.frames),     // hard frame count => exact duration
    "-c:v", "libx264", "-preset", cfg.preset, "-crf", String(cfg.segmentCrf),
    "-pix_fmt", "yuv420p", "-r", String(cfg.fps), "-vsync", "cfr",
    "-x264-params", "keyint=25:min-keyint=25:scenecut=0", // aligned GOPs => clean concat
    "-an", "-movflags", "+faststart",
    out,
  ], `segment ${seg.index}`);

  const got = await frameCount(out);
  if (got !== seg.frames) {
    throw new Error(`segment ${seg.index}: wanted ${seg.frames} frames, encoder produced ${got}`);
  }
  return out;
}

/** Hard-cut join: no re-encode at all. */
async function concatCopy(files, out, workDir) {
  const list = path.join(workDir, "concat.txt");
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  await ffmpeg([
    "-y", "-v", "error", "-nostdin",
    "-f", "concat", "-safe", "0", "-i", list,
    "-c", "copy", "-movflags", "+faststart", "-fflags", "+genpts",
    out,
  ], "concat");
  return out;
}

/**
 * Crossfade join. This is the ONE place a second encode generation happens:
 * xfade has to blend decoded frames, so the whole timeline is re-encoded.
 * Sources are the CRF-16 intermediates, so the loss is negligible, but it is
 * why hard cut is the default.
 */
async function concatXfade(files, out, cfg, segs) {
  const d = cfg.crossfade;
  const inputs = files.flatMap((f) => ["-i", f]);
  const parts = [];
  files.forEach((_, i) => parts.push(`[${i}:v]setpts=PTS-STARTPTS,format=yuv420p[x${i}]`));
  let cur = "[x0]";
  let acc = segs[0].duration;
  for (let i = 1; i < files.length; i++) {
    const label = i === files.length - 1 ? "[v]" : `[m${i}]`;
    parts.push(`${cur}[x${i}]xfade=transition=fade:duration=${fmt(d)}:offset=${fmt(acc - d)}${label}`);
    acc = acc - d + segs[i].duration;
    cur = label;
  }
  await ffmpeg([
    "-y", "-v", "error", "-nostdin", ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", "[v]",
    "-c:v", "libx264", "-preset", cfg.preset, "-crf", String(cfg.finalCrf),
    "-pix_fmt", "yuv420p", "-r", String(cfg.fps),
    "-an", "-movflags", "+faststart",
    out,
  ], "xfade concat");
  return out;
}

/** GIF with a per-clip adaptive palette. One pass via `split`. */
export async function makeGif(src, out, gif = DEFAULTS.gif) {
  await ffmpeg([
    "-y", "-v", "error", "-nostdin", "-i", src,
    "-filter_complex",
    `fps=${gif.fps},scale=${gif.width}:-2:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=${gif.colors}:stats_mode=diff[p];` +
    `[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    "-loop", "0", out,
  ], "gif");
  return out;
}

/**
 * Build a timeline.
 * @param {string} manifestFile
 * @param {object} cliOpts
 */
export async function assemble(manifestFile, cliOpts = {}) {
  const { segments: rawSegs, opts: manifestOpts, dir } = await loadManifest(manifestFile);
  const cfg = {
    ...DEFAULTS,
    captionFadeIn: 0.35,
    captionFadeOut: 0.35,
    ...manifestOpts,
    ...cliOpts,
    gif: { ...DEFAULTS.gif, ...(manifestOpts.gif || {}), ...(cliOpts.gif || {}) },
  };
  const outDir = path.resolve(cliOpts.outDir ?? manifestOpts.outDir ?? OUT_DIR);
  const name = cliOpts.name ?? manifestOpts.name ?? "final";
  const workDir = path.join(outDir, `${name}-segments`);
  fs.mkdirSync(workDir, { recursive: true });

  const segs = rawSegs.map((s, i) => normaliseSegment(s, i, dir, cfg));

  // --- pre-flight: does every non-still source actually contain the cut? ----
  const warnings = [];
  for (const s of segs) {
    if (s.still) continue;
    const p = await probe(s.clip);
    s.sourceDuration = p.durationSec;
    s.sourceFps = p.fps;
    const need = s.trimStart + s.duration;
    if (need > p.durationSec + 1e-3) {
      warnings.push(
        `segment ${s.index} (${path.basename(s.clip)}): needs ${fmt(need)}s ` +
        `(trimStart ${fmt(s.trimStart)} + duration ${fmt(s.duration)}) but the clip is only ` +
        `${fmt(p.durationSec)}s — the final ${fmt(need - p.durationSec)}s will be a FROZEN last frame`,
      );
    }
  }

  // --- captions ------------------------------------------------------------
  const capFiles = new Map();
  for (const s of segs) {
    if (!s.caption) continue;
    const key = JSON.stringify([s.caption, s.captionStyle]);
    if (!capFiles.has(key)) {
      const r = await renderCaption(s.caption, {
        videoWidth: cfg.width, videoHeight: cfg.height, ...(s.captionStyle || {}),
      });
      capFiles.set(key, r.file);
      for (const w of r.warnings) warnings.push(`segment ${s.index} caption: ${w}`);
    }
    s.captionPng = capFiles.get(key);
  }

  // --- render + join -------------------------------------------------------
  const files = [];
  for (const s of segs) {
    process.stdout.write(`  rendering segment ${s.index} (${path.basename(s.clip)})…\r`);
    files.push(await renderSegment(s, cfg, s.captionPng, workDir));
  }
  process.stdout.write(" ".repeat(72) + "\r");
  if (!process.stdout.isTTY) process.stdout.write("\n");

  const mp4 = path.join(outDir, `${name}.mp4`);
  if (cfg.crossfade > 0 && files.length > 1) await concatXfade(files, mp4, cfg, segs);
  else await concatCopy(files, mp4, workDir);

  let gifPath = null;
  if (cfg.gifEnabled !== false) {
    gifPath = path.join(outDir, `${name}.gif`);
    await makeGif(mp4, gifPath, cfg.gif);
  }

  // --- report --------------------------------------------------------------
  const sumDurations = segs.reduce((a, s) => a + s.duration, 0);
  const expected = cfg.crossfade > 0 && segs.length > 1
    ? sumDurations - cfg.crossfade * (segs.length - 1)
    : sumDurations;
  const finalProbe = await probe(mp4);
  const finalFrames = await frameCount(mp4);

  const report = {
    segments: [], sumDurations, expectedDuration: expected,
    actualDuration: finalProbe.durationSec, actualFrames: finalFrames,
    mp4, gif: gifPath, warnings, probe: finalProbe, target: cfg.target,
    crossfade: cfg.crossfade,
  };
  let t = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const start = cfg.crossfade > 0 ? t : t;
    report.segments.push({
      index: s.index, clip: path.basename(s.clip), still: s.still,
      trimStart: s.trimStart, duration: s.duration, frames: s.frames,
      timelineIn: start, timelineOut: start + s.duration,
      caption: s.caption,
      captionIn: s.caption ? start + s.captionDelay : null,
      captionOut: s.caption ? start + s.captionDelay + s.captionDuration : null,
      file: files[i],
    });
    t += s.duration - (cfg.crossfade > 0 && i < segs.length - 1 ? cfg.crossfade : 0);
  }

  return report;
}

export function printReport(r) {
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log("");
  console.log(pad("#", 3) + pad("clip", 32) + lpad("trim", 7) + lpad("dur", 8) + lpad("frames", 8) + "  " + pad("in→out", 20) + "caption");
  console.log("-".repeat(118));
  for (const s of r.segments) {
    console.log(
      pad(s.index, 3) + pad(s.clip + (s.still ? " [still]" : ""), 32) +
      lpad(fmt(s.trimStart, 2), 7) + lpad(fmt(s.duration, 2) + "s", 8) + lpad(s.frames, 8) + "  " +
      pad(`${tc(s.timelineIn)}→${tc(s.timelineOut)}`, 20) +
      (s.caption ? `"${s.caption}" @${fmt(s.captionIn, 2)}–${fmt(s.captionOut, 2)}` : "—"),
    );
  }
  console.log("-".repeat(118));
  console.log(`sum of segment durations : ${fmt(r.sumDurations)}s`);
  if (r.crossfade > 0) console.log(`crossfade overlap        : -${fmt(r.crossfade * (r.segments.length - 1))}s (${fmt(r.crossfade)}s x ${r.segments.length - 1})`);
  console.log(`expected total           : ${fmt(r.expectedDuration)}s`);
  console.log(`ACTUAL final.mp4         : ${fmt(r.actualDuration)}s  (${r.actualFrames} frames)`);
  const delta = r.actualDuration - r.expectedDuration;
  console.log(`delta                    : ${delta >= 0 ? "+" : ""}${fmt(delta)}s  ${Math.abs(delta) <= 0.041 ? "OK (<=1 frame)" : "*** MISMATCH ***"}`);
  console.log(`vs ${r.target}s target          : ${r.actualDuration <= r.target ? "under by " : "OVER by "}${fmt(Math.abs(r.target - r.actualDuration))}s`);
  console.log("");
  console.log(`mp4: ${r.mp4}`);
  if (r.gif) console.log(`gif: ${r.gif}`);
  if (r.warnings.length) {
    console.log("\nWARNINGS:");
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
}

// ---------------------------------------------------------------------- CLI --
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const manifest = args.find((a) => !a.startsWith("--"));
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  if (!manifest) {
    console.error("usage: node video/lib/assemble.mjs <manifest.(json|mjs)> [--out DIR] [--name final] [--crossfade 0.4] [--no-gif] [--target 90]");
    process.exit(1);
  }
  const opts = {};
  if (flag("out")) opts.outDir = flag("out");
  if (flag("name")) opts.name = flag("name");
  if (flag("crossfade")) opts.crossfade = Number(flag("crossfade"));
  if (flag("target")) opts.target = Number(flag("target"));
  if (args.includes("--no-gif")) opts.gifEnabled = false;
  if (flag("gif-width") || flag("gif-fps")) {
    opts.gif = {};
    if (flag("gif-width")) opts.gif.width = Number(flag("gif-width"));
    if (flag("gif-fps")) opts.gif.fps = Number(flag("gif-fps"));
  }
  let r;
  try {
    r = await assemble(manifest, opts);
  } catch (e) {
    console.error(`\nassemble failed: ${e.message}\n`);
    process.exit(1);
  }
  printReport(r);
  fs.writeFileSync(path.join(path.dirname(r.mp4), `${path.basename(r.mp4, ".mp4")}-report.json`), JSON.stringify(r, null, 2));
}
