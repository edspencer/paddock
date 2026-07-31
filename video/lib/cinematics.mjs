/**
 * cinematics.mjs — make automated browsing look human on camera.
 *
 * Everything here is paced against the WALL CLOCK, because that is what the
 * video encoder samples. Anything driven by "N steps as fast as possible"
 * produces a jump-cut in the footage even though the trace looks fine.
 *
 * The visible pointer is a DOM overlay (installed by record.mjs's
 * installCursor via addInitScript). Playwright's real mouse is invisible to
 * the screencast, so every real page.mouse.move() is mirrored onto the
 * overlay in the same tick -- hover states and the drawn pointer stay in sync.
 */

import { sleep } from "./record.mjs";

/** Frames per second we drive animations at. Above the recorder's own rate so
 * we are never the limiting factor. */
export const ANIM_FPS = 60;

// ---------------------------------------------------------------- easings --
export const ease = {
  linear: (t) => t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  // Human pointer motion: quick start, long settle.
  pointer: (t) => 1 - Math.pow(1 - t, 4),
};

/**
 * Run `fn(t, eased)` repeatedly for durationMs, paced to real time.
 * Always fires a final frame at t = 1 so we never stop short of the target.
 */
export async function animate(durationMs, easing, fn) {
  if (durationMs <= 0) {
    await fn(1, 1);
    return;
  }
  const start = Date.now();
  const frame = 1000 / ANIM_FPS;
  for (;;) {
    const elapsed = Date.now() - start;
    const t = Math.min(1, elapsed / durationMs);
    await fn(t, easing(t));
    if (t >= 1) break;
    const drift = (Date.now() - start) - elapsed;
    await sleep(Math.max(0, frame - drift));
  }
}

// ----------------------------------------------------------------- cursor --

/** Current logical pointer position, per page. */
const cursorPos = new WeakMap();

export function cursorAt(page) {
  return cursorPos.get(page) ?? { x: 960, y: 540 };
}

/** Teleport the pointer with no animation (use for setting up a shot). */
export async function placeCursor(page, x, y) {
  cursorPos.set(page, { x, y });
  await page.mouse.move(x, y);
  await page.evaluate(([x, y]) => window.__cursor?.move(x, y), [x, y]);
}

/**
 * Move the VISIBLE cursor (and the real mouse) to x,y over durationMs.
 * Adds a slight arc so the path is not a dead-straight robot line.
 *
 * @param {import('playwright').Page} page
 * @param {number} x
 * @param {number} y
 * @param {number} [durationMs=650]
 * @param {object} [opts]
 * @param {number} [opts.arc=0.12] lateral bow as a fraction of distance (0 = straight)
 * @param {(t:number)=>number} [opts.easing]
 */
export async function moveCursor(page, x, y, durationMs = 650, opts = {}) {
  const { arc = 0.12, easing = ease.pointer } = opts;
  const from = cursorAt(page);
  const dx = x - from.x;
  const dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) {
    await placeCursor(page, x, y);
    return;
  }
  // Perpendicular unit vector for the bow.
  const px = -dy / dist;
  const py = dx / dist;
  const bow = dist * arc * (from.x <= x ? 1 : -1);

  await animate(durationMs, easing, async (t, e) => {
    // sin() peaks mid-flight and returns to 0 at both ends.
    const bend = Math.sin(Math.PI * e) * bow;
    const cx = from.x + dx * e + px * bend;
    const cy = from.y + dy * e + py * bend;
    cursorPos.set(page, { x: cx, y: cy });
    await page.mouse.move(cx, cy);
    await page.evaluate(([a, b]) => window.__cursor?.move(a, b), [cx, cy]);
  });
  cursorPos.set(page, { x, y });
}

/**
 * Resolve a selector (or {x,y}) to viewport-centre coordinates.
 *
 * If the element is off-screen we must scroll to it -- but Playwright's
 * scrollIntoViewIfNeeded() is an INSTANT jump, which reads as a jump-cut in
 * the footage. So by default we ease there instead. Pass {autoScroll:false}
 * if you have already framed the shot yourself.
 */
export async function centreOf(page, target, opts = {}) {
  if (target && typeof target === "object" && "x" in target) return target;
  const { autoScroll = true, scrollMs = 900 } = opts;
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  await loc.waitFor({ state: "visible", timeout: 15000 });

  let box = await loc.boundingBox();
  const vp = page.viewportSize() ?? { width: 1920, height: 1080 };
  const offscreen =
    !box || box.y < 0 || box.x < 0 || box.y + box.height > vp.height || box.x + box.width > vp.width;

  if (offscreen) {
    if (autoScroll) await smoothScroll(page, loc, scrollMs);
    else await loc.scrollIntoViewIfNeeded();
    box = await loc.boundingBox();
  }
  if (!box) throw new Error(`centreOf: no bounding box for ${target}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Move to an element, hold a beat (so the hover state reads on camera), then
 * click with a press/release squash and a ripple.
 */
export async function humanClick(page, target, opts = {}) {
  const {
    moveMs = 700,
    preClickMs = 320,
    postClickMs = 450,
    button = "left",
    click = true,
  } = opts;
  const { x, y } = await centreOf(page, target);
  await moveCursor(page, x, y, moveMs, opts);
  await sleep(preClickMs); // let :hover paint before the click
  await page.evaluate(() => window.__cursor?.press());
  await page.evaluate(([a, b]) => window.__cursor?.ripple(a, b), [x, y]);
  await sleep(90);
  if (click) await page.mouse.click(x, y, { button });
  await page.evaluate(() => window.__cursor?.release());
  await sleep(postClickMs);
}

/** Hover only -- no click. Useful for tooltip/menu shots. */
export async function humanHover(page, target, opts = {}) {
  return humanClick(page, target, { ...opts, click: false, postClickMs: opts.postClickMs ?? 250 });
}

// ----------------------------------------------------------------- scroll --

/**
 * Eased scrolling.
 *
 * - `target` as a NUMBER  -> scroll by that many px (positive = down) using
 *   real wheel events at the cursor, so nested scroll containers under the
 *   pointer behave exactly as they would for a user.
 * - `target` as a SELECTOR -> ease the nearest scrollable ancestor so the
 *   element lands in view, driven in-page by rAF.
 *
 * @param {import('playwright').Page} page
 * @param {number|string} target
 * @param {number} [durationMs=1200]
 */
export async function smoothScroll(page, target, durationMs = 1200, opts = {}) {
  const { easing = ease.inOutCubic } = opts;

  if (typeof target === "number") {
    let applied = 0;
    await animate(durationMs, easing, async (t, e) => {
      const want = Math.round(target * e);
      const step = want - applied;
      if (step !== 0) {
        applied = want;
        await page.mouse.wheel(0, step);
      }
    });
    return;
  }

  // Selector form: animate the scroll container directly.
  //
  // Resolve through a Playwright LOCATOR, not document.querySelector inside
  // the page -- otherwise Playwright-only engines ("text=", "role=", ">>"
  // chaining) throw "not a valid selector" in the browser.
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  await loc.waitFor({ state: "attached", timeout: 15000 });
  const handle = await loc.elementHandle();
  if (!handle) throw new Error(`smoothScroll: could not resolve ${target}`);

  await page.evaluate(
    async ({ el, durationMs, margin }) => {
      if (!el) return;
      const scroller = (function find(n) {
        for (let p = n.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          const oy = s.overflowY;
          if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
        }
        return document.scrollingElement || document.documentElement;
      })(el);

      const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
      const startTop = scroller.scrollTop;
      const elTop = isRoot
        ? el.getBoundingClientRect().top + startTop
        : el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + startTop;
      const viewH = isRoot ? window.innerHeight : scroller.clientHeight;
      const max = scroller.scrollHeight - viewH;
      const want = Math.max(0, Math.min(max, elTop - (viewH - el.offsetHeight) / 2 - margin));
      const delta = want - startTop;
      if (Math.abs(delta) < 1) return;

      const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      await new Promise((resolve) => {
        const t0 = performance.now();
        (function step(now) {
          const t = Math.min(1, (now - t0) / durationMs);
          scroller.scrollTop = startTop + delta * easeInOutCubic(t);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        })(t0);
      });
    },
    { el: handle, durationMs, margin: opts.margin ?? 0 },
  );
  await handle.dispose();
}

// ------------------------------------------------------------------ typing --

/**
 * Type with variable per-character delay -- uniform delays read as machine
 * output on camera.
 */
export async function humanType(page, target, text, opts = {}) {
  const { cps = 14, jitter = 0.55, focus = true } = opts;
  if (focus && typeof target === "string") await page.locator(target).first().click();
  const base = 1000 / cps;
  for (const ch of text) {
    await page.keyboard.type(ch);
    const wobble = 1 + (Math.random() * 2 - 1) * jitter;
    // Punctuation gets a slightly longer beat, like a real typist.
    const extra = ".,!?\n".includes(ch) ? base * 2 : 0;
    await sleep(base * wobble + extra);
  }
}

// ------------------------------------------------------------------ dwell --

/**
 * Hold still. Every shot should end with ~1500-2000ms of this so a caption
 * can sit on a stable frame in the edit.
 */
export async function dwell(page, ms = 1800) {
  await sleep(ms);
}

/** Convenience: settle the page (fonts + network + a beat) before shooting. */
export async function settle(page, ms = 600) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await sleep(ms);
}

export { sleep };
