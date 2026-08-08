/**
 * caption.mjs — render a lower-third caption to a transparent RGBA PNG.
 *
 * WHY A PNG AND NOT drawtext
 * --------------------------
 * ffmpeg's `drawtext` takes its text INSIDE the filter-graph string, where the
 * text shares an escaping namespace with the filter syntax itself. An
 * apostrophe, a colon, a comma or a `\` in the caption silently mangles or
 * kills the filter chain — that is exactly how two caption lines were lost
 * (an `'` and a `·`). Here the text never touches the ffmpeg command line at
 * all: it goes into an SVG document (XML-escaped, one well-defined escaping
 * rule) which librsvg rasterises, and the resulting PNG is composited with
 * `overlay`. `overlay` takes no user strings, so there is nothing left to
 * escape. drawtext's boxes are also square — a rounded pill needs SVG anyway.
 *
 * HOW THE PILL IS SIZED
 * ---------------------
 * Two passes. Pass 1 renders the text alone onto a wide transparent canvas;
 * png.mjs reads back the alpha bounding box, which gives the exact ink extent
 * (and the left side bearing) with no font-metrics library and no assumptions
 * about shaping, kerning or script. Pass 2 draws the pill sized to that ink and
 * places the text so its INK is centred — not its advance box, which would look
 * off-centre for glyphs with asymmetric bearings.
 *
 * The baseline is NOT derived from the caption's own ink. It comes from a
 * per-(font,size,weight) cap-height reference ("H"), so every caption in the
 * film shares one baseline and one pill height regardless of whether the text
 * happens to contain a descender. That is what makes it a system rather than
 * a set of one-offs.
 *
 * CLI:
 *   env -u NODE_ENV node video/lib/caption.mjs "Your caption" [--out FILE] [--size 44]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { alphaBBox, readPng } from "./png.mjs";
import { FAMILY, assertFontsPresent, fontEnv, uncoveredChars } from "./fonts.mjs";
import { CAPTION_CACHE_DIR, TMP_DIR } from "./paths.mjs";

const run = promisify(execFile);

export { CAPTION_CACHE_DIR };

/**
 * The caption design system. Every caption uses these values; per-call
 * overrides exist for escape hatches, not for routine variation.
 */
export const STYLE = {
  // Frame
  videoWidth: 1920,
  videoHeight: 1080,
  /** Distance from the bottom of the FRAME to the bottom of the pill. */
  bottomMargin: 104,

  // Type — Inter SemiBold, matching the product UI.
  family: FAMILY.sans,
  weight: 600,
  size: 44,
  /** Slight negative tracking: Inter is designed for it at display sizes. */
  letterSpacing: -0.4,
  color: "#f5f0ea", // near-white body text

  // Pill
  pillColor: "#14110f",
  // 0.86, not 0.78: at 0.78 over Paddock's near-black UI the content behind the
  // pill (project cards, status pills) reads through and competes with the
  // caption text. Verified by compositing over a real s1-reveal frame.
  pillOpacity: 0.86,
  /** Pill height as a multiple of font size — fixed, so all pills match. */
  pillHeightRatio: 2.05,
  /** Horizontal padding inside the pill, as a multiple of font size. */
  padRatio: 0.72,
  /** 1px hairline so the pill still reads over a pure-black UI. */
  strokeColor: "#f5f0ea",
  strokeOpacity: 0.1,

  // Accent — Paddock's real accent, verified against DEFAULT_ACCENT in
  // packages/server/src/brand.ts and --accent in packages/web/src/index.css.
  // NOT #d97757: that is Anthropic's orange and was specified in error.
  // Captions must match the product they are describing.
  accent: "#c2603c",
  /** Accent bar at the pill's leading edge. Set false to drop it. */
  accentBar: true,
  accentBarWidth: 5,
  accentGap: 16,

  // Timing (seconds) — consumed by assemble.mjs, never a hard pop.
  fadeIn: 0.35,
  fadeOut: 0.35,
};

/** XML text escaping. The ONLY escaping rule in the whole caption path. */
function xml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function styleAttrs(st) {
  return [
    `font-family="${xml(st.family)}"`,
    `font-weight="${st.weight}"`,
    `font-size="${st.size}"`,
    `letter-spacing="${st.letterSpacing}"`,
  ].join(" ");
}

/** Rasterise an SVG string to PNG via ffmpeg's librsvg decoder. */
async function svgToPng(svg, outPng, tag) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const svgFile = path.join(TMP_DIR, `${tag}.svg`);
  fs.writeFileSync(svgFile, svg, "utf8");
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", svgFile,
    "-frames:v", "1", "-update", "1",
    "-pix_fmt", "rgba",
    outPng,
  ], { env: fontEnv(), maxBuffer: 1 << 26 });
  return outPng;
}

const measureCache = new Map();

/**
 * Pass 1: ink bounding box of `text`, plus the cap-height reference.
 * @returns {{inkW:number, inkH:number, bearing:number, capH:number}}
 *   bearing = ink left edge relative to the text anchor (can be negative).
 */
async function measure(text, st) {
  const key = JSON.stringify([text, st.family, st.weight, st.size, st.letterSpacing]);
  const hit = measureCache.get(key);
  if (hit) return hit;

  const PAD = 400;               // slack so nothing can clip
  const W = Math.max(2400, Math.ceil(text.length * st.size * 1.4) + PAD * 2);
  const H = Math.ceil(st.size * 4);
  const baseline = Math.round(st.size * 2.5);
  const anchorX = PAD;

  const mk = (s) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <text x="${anchorX}" y="${baseline}" ${styleAttrs(st)} fill="#ffffff" xml:space="preserve">${xml(s)}</text>
</svg>`;

  const png = await svgToPng(mk(text), path.join(TMP_DIR, "measure.png"), "measure");
  const box = alphaBBox(readPng(png));
  if (!box) {
    throw new Error(
      `caption rendered NOTHING (no ink) for ${JSON.stringify(text)} — ` +
      `font "${st.family}" ${st.weight} probably failed to resolve`,
    );
  }

  // Cap-height reference: shared per (family, weight, size).
  const capKey = `cap:${st.family}:${st.weight}:${st.size}:${st.letterSpacing}`;
  let capH = measureCache.get(capKey);
  if (capH === undefined) {
    const capPng = await svgToPng(mk("H"), path.join(TMP_DIR, "measure-cap.png"), "measure-cap");
    const capBox = alphaBBox(readPng(capPng));
    capH = capBox ? capBox.h : Math.round(st.size * 0.72);
    measureCache.set(capKey, capH);
  }

  const out = { inkW: box.w, inkH: box.h, bearing: box.x - anchorX, capH };
  measureCache.set(key, out);
  return out;
}

function cacheName(text, st) {
  const h = crypto.createHash("sha1").update(JSON.stringify([text, st])).digest("hex").slice(0, 12);
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "caption";
  return `${slug}-${h}.png`;
}

/**
 * Render one caption to a full-frame transparent RGBA PNG.
 *
 * Full-frame (not a cropped pill) on purpose: assemble.mjs can then always
 * `overlay=0:0` with no geometry maths on the timeline side, so caption
 * placement lives in exactly one file.
 *
 * @param {string} text
 * @param {Partial<typeof STYLE> & {out?:string, force?:boolean, quiet?:boolean}} [opts]
 * @returns {Promise<{file:string, width:number, height:number,
 *                    pill:{x:number,y:number,w:number,h:number}, warnings:string[]}>}
 */
export async function renderCaption(text, opts = {}) {
  assertFontsPresent();
  const { out, force = false, quiet = false, ...over } = opts;
  const st = { ...STYLE, ...over };
  const warnings = [];

  if (typeof text !== "string" || !text.trim()) throw new Error("caption text must be a non-empty string");

  const bad = uncoveredChars(text);
  if (bad.length) {
    warnings.push(
      `characters not in Inter's latin subset: ${bad.map((c) => `${JSON.stringify(c)} U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(", ")}` +
      ` — these render in a FALLBACK face and will not match the UI`,
    );
  }
  const words = text.trim().split(/\s+/).length;
  if (words > 6) warnings.push(`${words} words — captions are meant to be 2-5 word noun phrases`);
  if (!quiet) for (const w of warnings) console.warn(`  ! caption "${text}": ${w}`);

  const file = out ?? path.join(CAPTION_CACHE_DIR, cacheName(text, st));
  const m = await measure(text, st);

  const padX = Math.round(st.size * st.padRatio);
  const barW = st.accentBar ? st.accentBarWidth : 0;
  const gap = st.accentBar ? st.accentGap : 0;
  const pillW = padX + barW + gap + m.inkW + padX;
  const pillH = Math.round(st.size * st.pillHeightRatio);
  const pillX = Math.round((st.videoWidth - pillW) / 2);
  const pillY = st.videoHeight - st.bottomMargin - pillH;
  const radius = pillH / 2;

  // Baseline from the shared cap-height reference => identical for every caption.
  const baseline = Math.round(pillY + (pillH + m.capH) / 2);
  const textAnchorX = Math.round(pillX + padX + barW + gap - m.bearing);
  const barX = pillX + padX;
  const barY = Math.round(baseline - m.capH);

  const pill = { x: pillX, y: pillY, w: pillW, h: pillH };

  if (force || !fs.existsSync(file)) {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${st.videoWidth}" height="${st.videoHeight}">
  <g>
    <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${radius}" ry="${radius}"
          fill="${st.pillColor}" fill-opacity="${st.pillOpacity}"
          stroke="${st.strokeColor}" stroke-opacity="${st.strokeOpacity}" stroke-width="1"/>
    ${st.accentBar ? `<rect x="${barX}" y="${barY}" width="${barW}" height="${m.capH}" rx="${barW / 2}" ry="${barW / 2}" fill="${st.accent}"/>` : ""}
    <text x="${textAnchorX}" y="${baseline}" ${styleAttrs(st)} fill="${st.color}" xml:space="preserve">${xml(text)}</text>
  </g>
</svg>`;
    await svgToPng(svg, file, "caption");
  }

  return { file, width: st.videoWidth, height: st.videoHeight, pill, warnings, style: st };
}

/** Render many captions, de-duplicated. Returns a Map<text, result>. */
export async function renderCaptions(texts, opts = {}) {
  const map = new Map();
  for (const t of texts) {
    if (t == null || map.has(t)) continue;
    map.set(t, await renderCaption(t, opts));
  }
  return map;
}

// ---------------------------------------------------------------------- CLI --
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const text = args.find((a) => !a.startsWith("--"));
  const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : d;
  };
  if (!text) {
    console.error('usage: node video/lib/caption.mjs "Caption text" [--out FILE] [--size 44] [--no-accent]');
    process.exit(1);
  }
  const opts = { force: true };
  if (flag("out")) opts.out = path.resolve(flag("out"));
  if (flag("size")) opts.size = Number(flag("size"));
  if (args.includes("--no-accent")) opts.accentBar = false;
  const r = await renderCaption(text, opts);
  console.log(JSON.stringify({ file: r.file, pill: r.pill, warnings: r.warnings }, null, 2));
}
