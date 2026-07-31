/**
 * test-caption.mjs — text-handling torture test for the caption renderer.
 *
 * Every string here contains at least one character that is either
 *   (a) an ffmpeg drawtext metacharacter (' : , \ % ; [ ] =), or
 *   (b) non-ASCII,
 * i.e. exactly the class of input that previously ate two caption lines.
 *
 * The assertions are pixel-level, not "it didn't throw":
 *   - the PNG is RGBA at full frame size
 *   - it contains ink (a silently-empty render is the actual failure mode)
 *   - the ink is centred in the frame (the pill is where the style says)
 *   - distinct strings produce distinct pixels (so a mangled/truncated string
 *     cannot pass by rendering something plausible)
 *   - a string and its "one character removed" variant differ (proves the
 *     awkward character is really being drawn, not silently dropped)
 *
 * Run: env -u NODE_ENV node test-caption.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renderCaption, STYLE } from "../lib/caption.mjs";
import { alphaBBox, readPng } from "../lib/png.mjs";
import { TMP_DIR } from "../lib/paths.mjs";

const OUT = path.join(TMP_DIR, "caption-tests");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const bad = [];
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; bad.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

const CASES = [
  ["straight apostrophe",      "It's the keeper's chat"],
  ["typographic apostrophe",   "Ed’s homelab, always on"],
  ["middle dot U+00B7",        "Runs on a mini-PC · 24/7"],
  ["em dash + en dash",        "Always on — 24–7"],
  ["colon",                    "Diffs: line by line"],
  ["ampersand (XML escape)",   "Triggers, schedules & diffs"],
  ["angle brackets + quotes",  `<review> "ship it"`],
  ["backslash and percent",    "100%\\ coverage"],
  ["semicolon and equals",     "PORT=5001; HOST=0.0.0.0"],
  ["square brackets",          "[live] keeper session"],
  ["accented latin",           "Café résumé naïve"],
  ["currency + symbols",       "£0 · €0 · ©2026"],
  ["ellipsis + nbsp",          "Thinking… still"],
];

console.log("\n=== caption text handling ===\n");

const hashes = new Map();
for (const [name, text] of CASES) {
  const file = path.join(OUT, `${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  let r;
  try {
    r = await renderCaption(text, { out: file, force: true, quiet: true });
  } catch (e) {
    t(name, false, `threw: ${e.message}`);
    continue;
  }
  const img = readPng(file);
  const box = alphaBBox(img);
  const okSize = img.width === STYLE.videoWidth && img.height === STYLE.videoHeight;
  const okInk = !!box && box.w > 20 && box.h > 10;
  // Pill must be horizontally centred within 2px and sit in the lower third.
  const cx = box ? box.x + box.w / 2 : -1;
  const okCentre = box && Math.abs(cx - STYLE.videoWidth / 2) <= 2;
  const okLower = box && box.y > STYLE.videoHeight * 0.66;
  const h = crypto.createHash("sha1").update(readPng(file).data).digest("hex");
  const dup = hashes.get(h);
  hashes.set(h, text);

  t(name,
    okSize && okInk && okCentre && okLower && !dup,
    [
      okSize ? "" : `size ${img.width}x${img.height}`,
      okInk ? "" : "NO INK RENDERED",
      okCentre ? "" : `off-centre by ${box ? (cx - STYLE.videoWidth / 2).toFixed(1) : "?"}px`,
      okLower ? "" : `ink at y=${box?.y}`,
      dup ? `IDENTICAL PIXELS to "${dup}"` : "",
    ].filter(Boolean).join("; ") ||
    `${box.w}x${box.h}px ink, centred, warnings=${r.warnings.length}`,
  );
  if (r.warnings.length) for (const w of r.warnings) console.log(`          note: ${w}`);
}

// --- the strong test: dropping the awkward character must change the pixels --
console.log("\n=== awkward characters are actually drawn ===\n");
const PAIRS = [
  ["apostrophe", "It's here", "Its here"],
  ["middle dot", "mini-PC · on", "mini-PC  on"],
  ["ampersand", "A & B", "A  B"],
  ["colon", "Diffs: here", "Diffs here"],
  ["accents", "Café résumé", "Cafe resume"],
  ["em dash", "on — really", "on  really"],
];
for (const [name, withCh, without] of PAIRS) {
  const a = path.join(OUT, `pair-${name}-a.png`);
  const b = path.join(OUT, `pair-${name}-b.png`);
  await renderCaption(withCh, { out: a, force: true, quiet: true });
  await renderCaption(without, { out: b, force: true, quiet: true });
  const ha = crypto.createHash("sha1").update(readPng(a).data).digest("hex");
  const hb = crypto.createHash("sha1").update(readPng(b).data).digest("hex");
  const wa = alphaBBox(readPng(a)), wb = alphaBBox(readPng(b));
  t(`"${withCh}" renders differently from "${without}"`, ha !== hb,
    `ink ${wa.w}px vs ${wb.w}px`);
}

// --- inputs that should be rejected loudly, not rendered as nothing ---------
console.log("\n=== bad input is rejected, not silently blank ===\n");
for (const [name, val] of [["empty string", ""], ["whitespace only", "   "], ["null", null], ["number", 42]]) {
  let threw = false;
  try { await renderCaption(val, { out: path.join(OUT, "reject.png"), force: true, quiet: true }); }
  catch { threw = true; }
  t(`${name} throws`, threw);
}

// --- coverage warning fires for characters Inter's subset lacks -------------
{
  const r = await renderCaption("Paddock 日本語", { out: path.join(OUT, "coverage.png"), force: true, quiet: true });
  t("uncovered codepoints produce a warning", r.warnings.some((w) => /not in Inter/.test(w)),
    r.warnings[0] || "no warning");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(`PNGs: ${OUT}`);
if (fail) { console.log("failed:", bad.join("; ")); process.exit(1); }
