/**
 * paths.mjs — every filesystem location the harness uses, resolved in ONE place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The harness used to live in scratch space, so "the output dir" was just
 * `../out` relative to the scripts. Now the scripts live inside the paddock
 * working tree and the footage does not: a 90-second cut is ~250 MB of webm
 * plus three full renders during verification, none of which belongs in git.
 *
 * So the rule is absolute: **nothing under `video/` writes into the repo at
 * runtime.** Renders, caption PNGs, scratch SVGs, the fontconfig cache and the
 * per-scene state files all land under OUT_DIR, which defaults outside the repo
 * and is overridable with one environment variable.
 *
 *   PADDOCK_VIDEO_OUT    where renders, clips and scratch go
 *                        (default /data/scratch/paddock-video/out)
 *   PADDOCK_VIDEO_FONTS  where the built TTFs live
 *                        (default video/lib/fonts, gitignored)
 *
 * The one exception is FONT_DIR, which defaults inside the tree because the
 * fonts are a *build* artefact of `build-fonts.mjs`, not a *runtime* one — they
 * are written once, by hand, and `.gitignore` covers `video/(**\/)fonts/`. If
 * even that bothers you, point PADDOCK_VIDEO_FONTS somewhere else.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `video/lib` — where the engine lives. */
export const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `video/` — the root of the whole harness. */
export const VIDEO_ROOT = path.resolve(LIB_DIR, "..");

/** `video/videos` — one directory per film. */
export const VIDEOS_DIR = path.join(VIDEO_ROOT, "videos");

/**
 * Source clips, renders, gifs, reports. Deliberately OUTSIDE the repo: clips
 * are hundreds of megabytes and are regenerable from the scene scripts.
 */
export const OUT_DIR = path.resolve(
  process.env.PADDOCK_VIDEO_OUT || "/data/scratch/paddock-video/out",
);

/**
 * Scratch: measurement SVGs/PNGs, the fontconfig cache, verify's extracted
 * frames, and the per-scene state files written by the `*-prep.mjs` seeders.
 * Under OUT_DIR so a single env var relocates everything the harness writes.
 */
export const TMP_DIR = path.join(OUT_DIR, "tmp");

/** Rendered caption PNGs, content-addressed by text + full style. */
export const CAPTION_CACHE_DIR = path.join(OUT_DIR, "captions");

/** Static TTFs cut from the product's woff2 by `build-fonts.mjs`. NOT committed. */
export const FONT_DIR = process.env.PADDOCK_VIDEO_FONTS
  ? path.resolve(process.env.PADDOCK_VIDEO_FONTS)
  : path.join(LIB_DIR, "fonts");

/** Staging copies of the product's woff2, made by `build-fonts.mjs`. */
export const FONT_SRC_DIR = path.join(TMP_DIR, "fonts-src");
