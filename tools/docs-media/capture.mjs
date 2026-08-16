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
import { mkdirSync, writeFileSync } from "node:fs";
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
/**
 * Record WHAT WAS ON SCREEN beside the shot, as `<file>.png.json`.
 *
 * With four runtime themes and a free accent picker, "which theme is this?" is
 * no longer answerable from the PNG — and that question is most of what made
 * deciding this re-shoot expensive. A sidecar turns it into a file read.
 *
 * Everything here is OBSERVED from the live page, not restated from the config
 * that was requested: the point is evidence that the intended appearance
 * actually applied, so a shot taken with a silently-failed theme is detectable
 * afterwards rather than only at capture time.
 */
async function provenance(page, name, viewport) {
  return page.evaluate(
    ([shotName, vp]) => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      let stored = {};
      try {
        stored = JSON.parse(localStorage.getItem("paddock:appearance") || "{}");
      } catch {}
      // The instance stamps its own version into the sidebar; that is the
      // build that is literally in the frame.
      const v = (document.body.innerText || "").match(/\bv(\d+\.\d+\.\d+)\b/);
      return {
        shot: shotName,
        route: location.pathname,
        viewport: vp,
        theme: stored.theme ?? null,
        mode: root.classList.contains("dark") ? "dark" : "light",
        hue: stored.hue ?? null,
        tint: stored.tint ?? 0,
        // Bare space-separated sRGB channels — the branding seam's format.
        accent: cs.getPropertyValue("--accent").trim() || null,
        appVersion: v ? v[1] : null,
      };
    },
    [name, viewport],
  );
}

async function shoot(page, name, { selector = null, fitToLast = null, pad = 8 } = {}, viewport) {
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
  const meta = await provenance(page, name, viewport);
  writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2) + "\n");
  console.log(`  ✓ ${file}  [${meta.theme}/${meta.mode} accent=${meta.accent} v${meta.appVersion}]`);
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
// What's New 0.70-0.72. One shot per release, framed for the docs column.
// ---------------------------------------------------------------------------

/** Page a Home card back to its first entry. */
async function pageToFirst(page, testid) {
  await page.locator(`[data-testid="${testid}"]`).waitFor();
  await page.evaluate(async (sel) => {
    const el = () => document.querySelector(sel);
    const prev = () =>
      [...el().querySelectorAll("button")].find((b) =>
        /Previous/.test(b.getAttribute("aria-label") || ""),
      );
    for (let i = 0; i < 40; i++) {
      if (/(Entry|Tip) 1 of/.test(el().innerText)) break;
      prev().click();
      await new Promise((r) => setTimeout(r, 50));
    }
  }, `[data-testid="${testid}"]`);
}

/**
 * Drive one turn carrying a fake-`claude` directive, and wait for the bar.
 *
 * The background-task rows are REAL state produced by a real turn — the stub
 * writes the SDK's task control messages into the transcript and the CLI
 * runtime yields them unfiltered, so nothing here is injected. What is
 * synthetic is the AGENT, not the mechanism.
 */
async function driveBackgroundWork(page, directive) {
  await page.goto(`${BASE}/projects/tidepool/chat`);
  const box = page.locator('textarea[placeholder="Message Claude…"]');
  await box.waitFor();
  await box.fill(`Kick off the nightly reindex and watch for the scan to finish. ${directive}`);
  await box.press("Enter");
  await page.locator('[data-testid="running-work"]').waitFor({ timeout: 30_000 });
}

// 0.72 · The posture profile row heading the Advanced group (#878/#884).
//        Clipped at the bottom of that first row on purpose: the rows below it
//        are the machine bindings (port, host, data dir), which are host paths
//        the leak-masker would blank, leaving holes in the frame.
shot(
  "whatsnew-posture-profile",
  { width: 1100, height: 900 },
  async (page) => {
    await page.goto(`${BASE}/config`);
    // The label, its help text and the section blurb all contain the phrase.
    await page.getByText("Posture profile").first().waitFor();
    await page.waitForLoadState("networkidle");
    // Advanced is the LAST group and is taller than the viewport, so it sits
    // below the fold. `block: "start"` is load-bearing: scrollIntoViewIfNeeded
    // aligns a tall element's BOTTOM, which leaves its top at a negative y —
    // and a clip rect starting above the viewport silently captures whatever
    // is at the top of the page instead of failing.
    await page.evaluate(() =>
      document.querySelector("#cfg-section-advanced").scrollIntoView({ block: "start" }),
    );
    await page.waitForTimeout(400);
  },
  // Pure CSS: `fitToLast` resolves the selector inside page.evaluate with the
  // real document.querySelector, which does NOT understand :has-text().
  { selector: "#cfg-section-advanced", fitToLast: "div.divide-y > div:first-child" },
);

// 0.72 · The own -> host transcript migration modal (#882). Grouped by project,
//        each row classified, and the copy that says unticked chats are set
//        aside rather than deleted.
shot(
  "whatsnew-transcript-migration",
  { width: 1100, height: 720 },
  async (page) => {
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("networkidle");
    await page.locator('[data-testid="migration-offer"]').click();
    await page.getByText(/will move into ~\/\.claude/).waitFor();
  },
  { selector: '[role="dialog"]' },
);

// 0.71.1 · The two Home cards (#865). Both paged to their first entry so the
//          frame is deterministic — each card otherwise picks at random on
//          every landing, which would make two runs differ for no reason.
shot(
  "whatsnew-home-cards",
  { width: 1280, height: 800 },
  async (page) => {
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("networkidle");
    await pageToFirst(page, "home-whats-new");
    await pageToFirst(page, "home-tips-panel");
  },
  { selector: 'div.mb-8.grid.gap-4:has([data-testid="home-whats-new"])' },
);

// 0.71.0 · The running-work bar expanded: a ✕ per row, Stop all in the header,
//          and each shell's COMMAND beside the intent it was launched with
//          (#851, #854). Four rows, so it opens expanded rather than collapsed.
shot(
  "whatsnew-running-work-stop",
  { width: 1000, height: 700 },
  async (page) => {
    await driveBackgroundWork(page, "[[BGTASK:3]]");
    await page.locator('[data-testid="running-task-cancel"]').first().waitFor();
  },
  { selector: '[data-testid="running-work"]' },
);

// 0.70.1 · The same bar collapsed (#849). Above four rows it opens as one line
//          showing the mix and the age of the oldest task, instead of fifteen
//          rows taller than the composer it docks above.
shot(
  "whatsnew-running-work-collapsed",
  { width: 1000, height: 700 },
  async (page) => {
    await driveBackgroundWork(page, "[[BGTASK:15]]");
    await page.getByText(/shells · 1 monitor/).waitFor();
    // Let the clock move off 0:00. "oldest" is the number that says something
    // is wedged rather than merely slow, and a frame showing 0:00 reads as an
    // unpopulated placeholder rather than as the feature.
    await page.waitForTimeout(45_000);
  },
  { selector: '[data-testid="running-work"]' },
);

// 0.70 · Inline `code` in rendered chat prose (#835). The subject is the chip's
//        background against the message card — the pair that had closed to
//        1.04:1 — so the frame is the assistant bubble, nothing else.
shot(
  "whatsnew-inline-code",
  { width: 900, height: 700 },
  async (page) => {
    // Resolve the chat by NAME through the API rather than clicking the
    // sidebar. The row's six hover actions share its accessible name and are
    // opacity-0 until hovered, so a by-name click is ambiguous at best and
    // lands on an unclickable element at worst.
    // Land on the origin first — the fetch below is same-origin, and running
    // it from about:blank fails.
    await page.goto(`${BASE}/projects/tidepool/chat`);
    const id = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/projects/tidepool/chats`);
      const { chats } = await r.json();
      return chats.find((c) => /^Why cold starts take 40s/.test(c.name || ""))?.sessionId;
    }, BASE);
    if (!id) throw new Error("seed missing the inline-code chat");
    await page.goto(`${BASE}/projects/tidepool/chat/${id}`);
    await page.locator("div.md p code").first().waitFor();
    await page.waitForLoadState("networkidle");
  },
  { selector: "div.animate-fade-in.justify-start:has(code)" },
);

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
      await shoot(page, name, s.opts, s.viewport);
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
