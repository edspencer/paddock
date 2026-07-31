/**
 * record.mjs — reusable Playwright video-recording harness.
 *
 * Usage:
 *   import { record } from "../../../lib/record.mjs";   // from a scene script
 *   const out = await record("my-scene", async (page) => {
 *     await page.goto("https://example.com");
 *     await dwell(page, 2000);
 *   });
 *
 * Notes / hard-won facts (see README-FINDINGS in the report):
 *  - Video is ONLY flushed to disk on context.close(). We always close in a
 *    finally block so a throwing scene still leaves usable footage.
 *  - `recordVideo.size` must equal the viewport for 1:1 pixels. If it differs,
 *    Playwright letterboxes/scales the frame, which looks soft.
 *  - deviceScaleFactor > 1 does NOT give you a higher-resolution video.
 *    Playwright's screencast is captured at CSS-pixel size and downscaled back
 *    to `recordVideo.size`. See DSF_NOTE below.
 */

import { chromium } from "playwright";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { OUT_DIR } from "./paths.mjs";

/** Clips land OUTSIDE the repo. See paths.mjs / PADDOCK_VIDEO_OUT. */
export const DEFAULT_OUT_DIR = OUT_DIR;

/**
 * BROWSER RESOLUTION
 * ------------------
 * This box has a version skew: the vendored `playwright-core@1.61.0` pins
 * chromium revision 1228, but /ms-playwright only contains revision 1232
 * (installed by the globally-installed @playwright/mcp, which ships
 * playwright-core 1.62-alpha). A bare chromium.launch() therefore dies with
 * "Executable doesn't exist at .../chromium_headless_shell-1228/...".
 *
 * Rather than pin a revision, find whatever full Chromium is actually on disk
 * and hand Playwright an explicit executablePath. We deliberately prefer the
 * FULL chromium build over chrome-headless-shell: the shell build is a
 * stripped headless target and is the riskier choice for screencast-based
 * video capture.
 */
export function resolveChromium() {
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";
  let entries = [];
  try {
    entries = fsSync.readdirSync(root);
  } catch {
    return undefined; // let Playwright try its own default
  }
  const candidates = entries
    .filter((e) => /^chromium-\d+$/.test(e))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .flatMap((e) => [
      path.join(root, e, "chrome-linux64", "chrome"),
      path.join(root, e, "chrome-linux", "chrome"),
    ]);
  return candidates.find((p) => fsSync.existsSync(p));
}

/**
 * DSF_NOTE
 * --------
 * Chromium's screencast (Page.startScreencast, which is what Playwright uses)
 * emits frames sized in *device* pixels, but Playwright's VideoRecorder is
 * configured with `recordVideo.size` and hands ffmpeg that fixed geometry.
 * With deviceScaleFactor: 2 and viewport 1920x1080 the page renders at
 * 3840x2160 internally, then every frame is scaled DOWN to the recordVideo
 * size before encode. Net effect: the video file is still `size` pixels, but
 * text is supersampled (rendered at 2x, downsampled to 1x), so it is *sharper*
 * than a plain 1x recording -- it is antialiasing, not extra resolution.
 *
 * If you actually want a 4K file: set viewport AND recordVideo.size to
 * 3840x2160 with deviceScaleFactor 1 (or 2 for supersampled 4K, at real cost).
 */

/**
 * Record a scene to <outDir>/<name>.webm.
 *
 * @param {string} name              basename for the output file
 * @param {(page, ctx) => Promise<void>} fn  scene driver
 * @param {object} [opts]
 * @param {number} [opts.width=1920]
 * @param {number} [opts.height=1080]
 * @param {number} [opts.deviceScaleFactor=2]  2 = supersampled/crisper text
 * @param {string} [opts.outDir]
 * @param {boolean} [opts.headless=true]
 * @param {string} [opts.baseURL]
 * @param {boolean} [opts.reducedMotion=false] true => prefers-reduced-motion
 * @param {number} [opts.leadInMs=400]   still frames before the scene starts
 * @param {number} [opts.tailMs=1500]    still frames after the scene ends
 * @param {object} [opts.contextOptions] merged into browser.newContext()
 * @param {(page)=>Promise<void>} [opts.onPage] hook run before fn (e.g. auth)
 * @returns {Promise<{path: string, name: string, ms: number}>}
 */
export async function record(name, fn, opts = {}) {
  const {
    width = 1920,
    height = 1080,
    deviceScaleFactor = 2,
    outDir = DEFAULT_OUT_DIR,
    headless = true,
    baseURL,
    reducedMotion = false,
    leadInMs = 400,
    tailMs = 1500,
    contextOptions = {},
    launchOptions = {},
    onPage,
  } = opts;

  await fs.mkdir(outDir, { recursive: true });
  // Each run gets its own raw dir so concurrent recordings cannot collide and
  // we can unambiguously find "the" video file afterwards.
  //
  // The raw dir lives INSIDE outDir on purpose: os.tmpdir() is a different
  // filesystem here, and fs.rename() across devices throws EXDEV. Keeping it
  // on the same device makes the final move atomic and free. (moveFile below
  // still falls back to copy+unlink if someone overrides outDir oddly.)
  const rawDir = await fs.mkdtemp(path.join(outDir, `.raw-${name}-`));

  const executablePath = opts.executablePath ?? resolveChromium();

  const browser = await chromium.launch({
    headless,
    executablePath,
    args: [
      // Crisper glyphs: kill subpixel/hinting artefacts that read as colour
      // fringing once the frame is chroma-subsampled to yuv420p.
      "--font-render-hinting=none",
      "--disable-lcd-text",
      // DO NOT add "--disable-features=..." here. Chromium stores switches in
      // a map, so a second --disable-features REPLACES Playwright's own
      // (substantial) default list rather than merging with it. If you need
      // to disable a feature, append it to Playwright's value instead.
      //
      // NOTE on scrollbars: Playwright passes --hide-scrollbars in headless,
      // so recordings have NO visible scrollbar. That generally looks cleaner
      // on camera, but if a scene needs to show one, use headless:false under
      // xvfb -- you cannot un-hide it with an arg here.
      ...(launchOptions.args ?? []),
    ],
    ...launchOptions,
  });

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    recordVideo: { dir: rawDir, size: { width, height } },
    baseURL,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    colorScheme: "dark",
    ...contextOptions,
  });

  const page = await context.newPage();
  await installCursor(page);

  const started = Date.now();
  let sceneError = null;
  try {
    if (onPage) await onPage(page);
    if (leadInMs) await sleep(leadInMs);
    await fn(page, { context, browser });
    if (tailMs) await sleep(tailMs);
  } catch (err) {
    sceneError = err;
  }

  // Video only lands on disk when the CONTEXT closes. Grab the handle first --
  // page.video() is null-safe but the object is invalidated after close.
  const video = page.video();
  await context.close();
  await browser.close();

  let finalPath = null;
  if (video) {
    const raw = await video.path();
    finalPath = path.join(outDir, `${name}.webm`);
    await fs.rm(finalPath, { force: true });
    await moveFile(raw, finalPath);
  }
  await fs.rm(rawDir, { recursive: true, force: true });

  if (sceneError) {
    sceneError.videoPath = finalPath;
    throw sceneError;
  }
  return { path: finalPath, name, ms: Date.now() - started };
}

/**
 * Inject the visible-cursor overlay. Uses addInitScript so it survives every
 * navigation -- otherwise the pointer vanishes the moment the scene clicks a
 * link, which is exactly when you need it.
 *
 * Exposes in-page: window.__cursor.move(x, y), .press(), .release(),
 * .ripple(x, y), .show(), .hide()
 */
export async function installCursor(page, { size = 22, color = "#ffffff" } = {}) {
  await page.addInitScript(
    ({ size, color }) => {
      if (window.__cursor) return;
      const state = { x: -100, y: -100, el: null, ready: false };

      const svg = `
        <svg width="${size}" height="${size}" viewBox="0 0 24 24"
             xmlns="http://www.w3.org/2000/svg" style="display:block">
          <path d="M5.5 2.5 L5.5 19.2 L9.9 15.1 L12.7 21.4 L15.6 20.1 L12.8 13.9 L18.7 13.6 Z"
                fill="${color}" stroke="rgba(0,0,0,.85)" stroke-width="1.3"
                stroke-linejoin="round"/>
        </svg>`;

      function mount() {
        if (state.el && state.el.isConnected) return state.el;
        const el = document.createElement("div");
        el.id = "__pw_cursor__";
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = [
          "position:fixed",
          "top:0",
          "left:0",
          "width:" + size + "px",
          "height:" + size + "px",
          "pointer-events:none",
          "z-index:2147483647",
          "will-change:transform",
          "transition:none",
          "filter:drop-shadow(0 2px 4px rgba(0,0,0,.55))",
          "transform:translate3d(" + state.x + "px," + state.y + "px,0)",
        ].join(";");
        el.innerHTML = svg;
        (document.body || document.documentElement).appendChild(el);
        state.el = el;
        state.ready = true;
        return el;
      }

      const api = {
        move(x, y) {
          state.x = x;
          state.y = y;
          const el = mount();
          el.style.transform = `translate3d(${x}px,${y}px,0)`;
        },
        press() {
          const el = mount();
          el.style.transform = `translate3d(${state.x}px,${state.y}px,0) scale(.82)`;
        },
        release() {
          const el = mount();
          el.style.transform = `translate3d(${state.x}px,${state.y}px,0) scale(1)`;
        },
        ripple(x = state.x, y = state.y) {
          mount();
          const r = document.createElement("div");
          r.style.cssText = [
            "position:fixed",
            "left:" + (x - 4) + "px",
            "top:" + (y - 4) + "px",
            "width:8px",
            "height:8px",
            "border-radius:50%",
            "border:2px solid rgba(255,255,255,.95)",
            "background:rgba(255,255,255,.18)",
            "pointer-events:none",
            "z-index:2147483646",
          ].join(";");
          document.body.appendChild(r);
          r.animate(
            [
              { transform: "scale(0.3)", opacity: 1 },
              { transform: "scale(5)", opacity: 0 },
            ],
            { duration: 520, easing: "cubic-bezier(.22,.61,.36,1)" },
          ).onfinish = () => r.remove();
        },
        show() {
          mount().style.opacity = "1";
        },
        hide() {
          mount().style.opacity = "0";
        },
      };

      window.__cursor = api;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => api.move(state.x, state.y), {
          once: true,
        });
      }
    },
    { size, color },
  );
}

/** rename(), falling back to copy+unlink when src/dst are on different devices. */
async function moveFile(src, dst) {
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fs.copyFile(src, dst);
    await fs.rm(src, { force: true });
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
