/**
 * build-fonts.mjs — convert the app's woff2 fonts to static TTFs for ffmpeg.
 *
 * Reads (READ ONLY) the product's OWN self-hosted webfonts from
 * packages/web/public/fonts/, writes static instances into FONT_DIR, and dumps
 * Inter's codepoint coverage to coverage.json so caption.mjs can warn about
 * characters the latin subset cannot render.
 *
 * This is a ONE-TIME step, and its output is NOT committed: the TTFs are
 * derived from files already in the repo, so committing them would be storing
 * the same typeface twice, in a format git cannot diff.
 *
 * Requires a python venv with fonttools+brotli:
 *   python3 -m venv /data/scratch/paddock-video/.venv
 *   /data/scratch/paddock-video/.venv/bin/pip install fonttools brotli
 *
 * Run:  env -u NODE_ENV node video/lib/build-fonts.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FONTCONFIG_FILE, ensureFontConfig } from "./fonts.mjs";
import { FONT_DIR, FONT_SRC_DIR, TMP_DIR, VIDEO_ROOT } from "./paths.mjs";

/** The repo's own webfont dir, found relative to `video/` — no absolute paths. */
const SRC_DIR = process.env.PADDOCK_WEB_FONTS
  || path.resolve(VIDEO_ROOT, "..", "packages", "web", "public", "fonts");
const VENV_PY = process.env.FONTTOOLS_PYTHON || "/data/scratch/paddock-video/.venv/bin/python";

const SRC_COPY = FONT_SRC_DIR;

const PLAN = [
  { src: "inter-latin.woff2", wght: 400, out: "Inter-Regular.ttf", coverage: "Inter" },
  { src: "inter-latin.woff2", wght: 600, out: "Inter-SemiBold.ttf" },
  { src: "jetbrains-mono-latin.woff2", wght: 500, out: "JetBrainsMono-Medium.ttf" },
];

fs.mkdirSync(FONT_DIR, { recursive: true });
fs.mkdirSync(SRC_COPY, { recursive: true });

// Copy the originals out of the product tree first, into scratch. packages/web
// is the shipping app: this script only ever READS from it.
for (const f of new Set(PLAN.map((p) => p.src))) {
  fs.copyFileSync(path.join(SRC_DIR, f), path.join(SRC_COPY, f));
}

const script = `
import json, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

plan = json.loads(sys.argv[1])
srcdir, outdir = sys.argv[2], sys.argv[3]
cov = {}
for p in plan:
    f = TTFont(srcdir + "/" + p["src"])
    f.flavor = None  # drop woff2 compression -> plain TTF
    if "fvar" in f:
        f = instancer.instantiateVariableFont(f, {"wght": p["wght"]}, updateFontNames=True, inplace=False)
    out = outdir + "/" + p["out"]
    f.save(out)
    g = TTFont(out)
    print(f'{p["out"]}: family={g["name"].getDebugName(1)!r} '
          f'style={g["name"].getDebugName(2)!r} weight={g["OS/2"].usWeightClass} '
          f'glyphs={g["maxp"].numGlyphs}')
    if p.get("coverage"):
        cov[p["coverage"]] = sorted(g.getBestCmap().keys())
        feats = sorted({r.FeatureTag for r in g["GSUB"].table.FeatureList.FeatureRecord}) if "GSUB" in g else []
        print(f'  GSUB features present: {feats}')
if cov:
    with open(outdir + "/coverage.json", "w") as fh:
        json.dump(cov, fh)
    print("coverage.json:", {k: len(v) for k, v in cov.items()})
`;

console.log(execFileSync(VENV_PY, ["-c", script, JSON.stringify(PLAN), SRC_COPY, FONT_DIR], {
  encoding: "utf8",
}));

// Blow away the fontconfig cache so a rebuilt face is picked up immediately.
fs.rmSync(path.join(TMP_DIR, "fccache"), { recursive: true, force: true });
ensureFontConfig();
console.log(execFileSync("fc-list", [":", "family", "style"], {
  encoding: "utf8",
  env: { ...process.env, FONTCONFIG_FILE },
}).split("\n").filter((l) => /Inter|JetBrains/.test(l)).sort().join("\n"));
