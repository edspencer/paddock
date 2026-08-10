#!/usr/bin/env node
/**
 * Re-runnable capture for the docs media rig.
 *
 * WHY THIS IS A SCRIPT AND NOT A SEQUENCE OF CLICKS
 * Seven PRs (#763-#769) are mid-flight on the visual design, including a Config
 * restructure (#768) and Home empty states (#769). Every shot below is
 * guaranteed to go stale. Re-shooting must be `node capture.mjs`, not a human
 * re-deriving twelve navigation paths from memory.
 *
 * Run:  node capture.mjs [--base URL] [--out DIR]   (or $PADDOCK_RIG_BASE)
 *       node capture.mjs --only adopt-modal
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};
const BASE = arg("--base", process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:4000");
const OUT = arg("--out", process.env.PADDOCK_SHOTS_OUT || "./shots");
const ONLY = arg("--only", null);

/**
 * Appearance is per-BROWSER, not per-instance: three localStorage keys read by
 * an inline pre-paint script in index.html. There is no server-side theme, so a
 * capture has to pin them itself.
 *
 * Default is the out-of-the-box appearance — Foundation, dark, the theme's own
 * accent, no tint. That is what a reader sees on first boot, which is the whole
 * job of a documentation screenshot. Override for the theme quartet only.
 */
const SHOT_THEME = process.env.PADDOCK_SHOT_THEME || "foundation";
const SHOT_DARK = (process.env.PADDOCK_SHOT_MODE || "dark") === "dark";

mkdirSync(OUT, { recursive: true });

/**
 * Anything that identifies the host, the rig, or a real person. Kept as ONE
 * list so the mask and the leak-scan can never drift apart — a mask that hides
 * a superset of what the scan checks is the only safe direction.
 *
 * The generic half is here; anything that names YOUR machine (a private domain,
 * an internal hostname, a container id) goes in `$PADDOCK_LEAK_EXTRA` as regex
 * alternatives, e.g. `PADDOCK_LEAK_EXTRA='corp\.example|buildbox-\d+'`. That
 * split is deliberate: this file is public, so hard-coding a private domain here
 * to *detect* it would publish the very string it is guarding.
 */
const LEAK = new RegExp(
  [
    // NB: NOT `/home/<user>/` — the rig's fictional project paths live under
    // /home/<demo user>/ and are deliberately on camera. These two are the real
    // host-path vectors on a server install.
    String.raw`/data/`,
    String.raw`/var/lib/`,
    String.raw`127\.0\.0\.1`,
    String.raw`0\.0\.0\.0`,
    String.raw`10\.\d+\.\d+\.\d+`,
    String.raw`192\.168\.`,
    String.raw`172\.(1[6-9]|2\d|3[01])\.`,
    String.raw`@[\w-]+\.(net|com|org)`,
    ...(process.env.PADDOCK_LEAK_EXTRA ? [process.env.PADDOCK_LEAK_EXTRA] : []),
  ].join("|"),
);

/**
 * Hide the DEEPEST element whose text leaks. Deepest matters: the Home pane
 * footer's path is a bare <span> inside a <div> that also contains the label,
 * so a naive first-match hides the whole footer (or, worse, an ancestor takes
 * the whole pane with it).
 *
 * visibility:hidden, not display:none — it preserves layout, so the shot is
 * framed identically to what a real user sees.
 */
async function mask(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const hit = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!re.test(el.textContent || "")) continue;
      if ([...el.children].some((c) => re.test(c.textContent || ""))) continue;
      el.style.visibility = "hidden";
      hit.push((el.textContent || "").slice(0, 60));
    }
    return hit;
  }, LEAK.source);
}

/**
 * Scan the page's TEXT NODES, not the pixels. `strings foo.png` cannot do this
 * — rendered text is pixel data, so a PNG showing a live token greps clean.
 * This runs before every shot and throws rather than writing a leaky file.
 */
async function assertClean(page, label) {
  const found = await page.evaluate((src) => {
    const re = new RegExp(src, "g");
    const m = (document.body.innerText || "").match(re);
    return m ? [...new Set(m)] : null;
  }, LEAK.source);
  if (found) throw new Error(`LEAK in "${label}": ${found.join(", ")} — shot not written`);
}

/**
 * Screenshot a specific element, tightly framed for the docs column.
 *
 * `fitToLast` clips the frame at the bottom of the last child matching that
 * selector. A scrollable list is as tall as its VIEWPORT, not its content, so
 * an element shot of a 4-row chat list is ~40% empty black — which reads as a
 * sloppy screenshot rather than as a short list.
 */
async function shoot(page, name, { selector = null, fitToLast = null, pad = 8 } = {}) {
  await mask(page);
  await assertClean(page, name);
  const file = path.join(OUT, `docs-${name}.png`);
  if (selector && fitToLast) {
    const box = await page.evaluate(
      ([sel, child, p]) => {
        const el = document.querySelector(sel);
        const kids = el.querySelectorAll(child);
        const last = kids[kids.length - 1];
        const a = el.getBoundingClientRect();
        const b = last.getBoundingClientRect();
        return { x: a.x, y: a.y, width: a.width, height: b.bottom - a.top + p };
      },
      [selector, fitToLast, pad],
    );
    await page.screenshot({ path: file, clip: box, scale: "css" });
  } else if (selector) {
    await page.locator(selector).first().screenshot({ path: file, scale: "css" });
  } else {
    await page.screenshot({ path: file, scale: "css" });
  }
  console.log(`  ✓ ${file}`);
  return file;
}

const SHOTS = {};

/**
 * Register a shot. `fn(page)` should navigate and leave the state on screen.
 * `opts.selector` frames the shot on one element — use it whenever the subject
 * is smaller than the window, or the docs column shrinks it to mush.
 */
const shot = (name, viewport, fn, opts = {}) => (SHOTS[name] = { viewport, fn, opts });

// ---------------------------------------------------------------------------
// Shot definitions. Each names the docs page it is for, so a stale shot can be
// traced back to the prose that depends on it.
// ---------------------------------------------------------------------------

const SIDEBAR = ".w-64, aside, [class*='w-'][class*='border-r']";

// 1a · using/working-in-chats.md after :39 — the "Adopt N native chats…" row
//      sitting above the CHATS label.
shot("adopt-row", { width: 1180, height: 620 }, async (page) => {
  await page.goto(`${BASE}/projects/tidepool/chat`);
  await page.getByRole("button", { name: /Adopt \d+ native Claude Code chats/ }).waitFor();
});

// 1b · using/working-in-chats.md after :44 — the Adopt native chats dialog.
//      Deselected one row so the counter reads "2 of 3" and the button "Adopt 2
//      chats", which is what the audit asked for and also demonstrates that the
//      selection is live rather than a static list.
shot("adopt-modal", { width: 1180, height: 780 }, async (page) => {
  await page.goto(`${BASE}/projects/tidepool/chat`);
  await page.getByRole("button", { name: /Adopt \d+ native Claude Code chats/ }).click();
  // The rows are custom-styled; uncheck() times out on the visually-hidden
  // input, so click the row's own label instead.
  await page.getByText("Draft the sensor onboarding checklist").click();
  await page.getByText(/\d+ of \d+ selected/).waitFor();
});

// 2 · using/working-in-chats.md:64-67 — the emerald terminal Adopted badge on
//     one row beside two ordinary chats.
//
//     FRAMED, not full-window. Without the selector this produced a frame
//     byte-identical to `adopt-row` (same URL, same viewport, same state), and
//     the duplicate sat in the shots dir looking like two captures. A badge is
//     16x16; photographing it inside an 1180px window makes it unreadable in
//     the docs column, which is the whole reason the audit asked for a crop.
shot(
  "adopted-badge",
  { width: 1180, height: 620 },
  async (page) => {
    await page.goto(`${BASE}/projects/tidepool/chat`);
    await page.locator('[data-provenance="adopted"]').first().waitFor();
  },
  { selector: "div.overflow-y-auto:has(div.chat-row)", fitToLast: "div.chat-row" },
);

// 4 · using/sending-files-and-images.md:64-67 — the OUTCOME of a send, which
//     the page never shows: an image rendered inline as a thumbnail and a
//     non-image file as a chip, after a reload so this is the persisted render
//     rather than the optimistic one.
//
//     Staged by stage-attachments.mjs, which drives the two real steps
//     (multipart upload -> chat:send with `attachments`). seed.mjs cannot
//     produce this: an attachment lives in the attachment store, not the JSONL.
//     Framed on the SENT MESSAGE GROUP, not the window: that div is the
//     thumbnail row plus the text bubble and nothing else. Full-window put the
//     thumbnail half-scrolled off the top edge and gave two thirds of the frame
//     to the fake agent's reply, which is a stub and renders as a large empty
//     bubble — an artefact of the rig, not of Paddock, and not something to
//     publish.
shot(
  "sent-attachments",
  { width: 1100, height: 760 },
  async (page) => {
    await page.goto(`${BASE}/projects/tidepool/chat`);
    await page.getByText(/residual after the drift fix/).first().click();
    await page.waitForLoadState("networkidle");
    await page.locator("img[src*='chat-files']").first().waitFor();
  },
  { selector: "div.animate-fade-in.items-end:has(img[src*='chat-files'])" },
);

// 5 · getting-started.md — the highest-traffic page carries no image at all.
//     Root Home: what a reader sees straight after `npx @edspencer/paddock`.
shot("root-home", { width: 1280, height: 800 }, async (page) => {
  await page.goto(`${BASE}/`);
  await page.waitForLoadState("networkidle");
  await page.getByText(/Harbour Notes/).first().waitFor();
});

// 3 · using/creating-and-organizing-projects.md:405 — Promote to project.
//     NB the opener is an unlabelled hover-only "+" on a root chat row, NOT a
//     button reading "Promote to project" as the prose claims.
shot("promote-to-project", { width: 1180, height: 700 }, async (page) => {
  await page.goto(`${BASE}/chat`);
  // The opener is opacity-0 until the chat row is hovered
  // (SessionSidebar.tsx:411), so hover the row before clicking.
  // The opener is opacity-0 until its parent chat ROW is hovered
  // (SessionSidebar.tsx:411 `group-hover/chat:opacity-100`). Hovering the
  // button itself is not enough — hover the row that owns the group.
  const btn = page.locator("[aria-label^='Promote chat']").first();
  await btn.waitFor({ state: "attached" });
  await page.getByText("Compare the two survey methods").first().hover();
  await btn.click({ force: true });
  await page.getByRole("heading", { name: "Promote to project" }).waitFor();
});

// 6 · guides/agent-capabilities.md:159-178 — tool picker, Bash ticked, amber
//     warning visible. The warning renders ONLY while Bash is ticked
//     (TriggersPane.tsx:808), so ticking is the shot.
shot("trigger-tool-picker-bash", { width: 900, height: 820 }, async (page) => {
  await page.goto(`${BASE}/projects/tidepool/triggers`);
  await page.getByTestId("add-trigger").click();
  await page.getByRole("checkbox", { name: /^Bash/ }).check();
  await page.getByText(/lets this trigger run arbitrary shell commands/).waitFor();
});

// 7 · configuration/config-file.md:712 — the project Settings tab. #768 rebuilt
//     this screen STRUCTURALLY, not just repainted it, so the old frame is
//     wrong about layout and not merely about colour. Framed on the form's
//     scroll container rather than the window: the subject is the settings
//     measure, and the sidebar beside it adds nothing at docs-column width.
shot(
  "project-settings",
  { width: 1180, height: 900 },
  async (page) => {
    await page.goto(`${BASE}/projects/tidepool/settings`);
    await page.getByText(/Summary|Domain|Model/).first().waitFor();
    await page.waitForLoadState("networkidle");
  },
  { selector: "main" },
);

// 8 · The Appearance section of /config (#780). NOTHING on the site illustrates
//     the four themes or the accent picker — the feature is un-illustrated
//     anywhere, which is why this is net-new rather than a re-shoot.
shot(
  "appearance-panel",
  { width: 1100, height: 760 },
  async (page) => {
    await page.goto(`${BASE}/config`);
    await page.getByRole("heading", { name: "Appearance" }).waitFor();
    await page.getByText("The neutral base. Warm ground, terracotta accent.").waitFor();
  },
  { selector: "section:has(h3:text-is('Appearance'))" },
);

// 9 · The theme quartet for the 0.67 entry. The SAME route in all four themes,
//     driven by $PADDOCK_SHOT_THEME — four separate runs, four files. This is
//     the ONE shot that must not be Foundation-only, because the subject is the
//     choice itself.
//
//     Four screenshots of one URL at one viewport is precisely the
//     configuration that has produced byte-identical files before, so md5sum
//     the four before believing you have four.
shot(`theme-${SHOT_THEME}`, { width: 1280, height: 800 }, async (page) => {
  await page.goto(`${BASE}/projects/tidepool/settings`);
  await page.waitForLoadState("networkidle");
  await page.getByText("Tidepool").first().waitFor();
});

// 10 · /discover (#745/#802). 0.68 is the newest What's New entry and carries
//      NO image at all. Discovery is also what an empty instance renders as its
//      Home, so this doubles as the first-run screen.
shot("discover", { width: 1280, height: 800 }, async (page) => {
  await page.goto(`${BASE}/discover`);
  await page.waitForLoadState("networkidle");
  await page.getByText(/Discover|scan|candidate/i).first().waitFor();
});

// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch();
  const names = ONLY ? [ONLY] : Object.keys(SHOTS);
  let failed = 0;
  for (const name of names) {
    const s = SHOTS[name];
    if (!s) throw new Error(`no such shot: ${name}`);
    const ctx = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 2 });
    // addInitScript, NOT page.evaluate after goto: the keys are read by a
    // pre-paint inline script, so writing them after navigation gives you a
    // flash of the wrong theme and, worse, a shot taken mid-swap. This runs
    // before any page script, on every navigation.
    await ctx.addInitScript(
      ([theme, dark]) => {
        try {
          localStorage.setItem("paddock:theme", dark ? "dark" : "light");
          localStorage.setItem(
            "paddock:appearance",
            JSON.stringify({ theme, hue: null, tint: 0 }),
          );
          // Keyed <theme>:<dark|light>. A stale entry paints the PREVIOUS
          // theme's solved accent before React boots, and a fast shot catches
          // exactly that frame. Removing it is not optional.
          localStorage.removeItem("paddock:appearance-cache");
        } catch {}
      },
      [SHOT_THEME, SHOT_DARK],
    );
    const page = await ctx.newPage();
    try {
      console.log(`→ ${name}`);
      await s.fn(page);
      // Assert the theme actually took rather than trusting it. Do not try to
      // verify by grepping CSS: OKLCH serialises as `oklch(...)` and --accent
      // is a bare RGB triple, so regex readers score a themed build zero.
      const applied = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
      }));
      if (applied.dark !== SHOT_DARK || !applied.accent) {
        throw new Error(
          `theme did not apply (dark=${applied.dark} want ${SHOT_DARK}, accent="${applied.accent}")`,
        );
      }
      await shoot(page, name, s.opts);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}: ${String(e).split("\n")[0]}`);
    }
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? `\n${failed} shot(s) failed` : "\nall shots captured");
  process.exit(failed ? 1 : 0);
}

main();
