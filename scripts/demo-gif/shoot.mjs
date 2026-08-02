#!/usr/bin/env node
/**
 * shoot.mjs — seed, boot, drive, and photograph the demo.
 *
 *   node scripts/demo-gif/shoot.mjs [--out DIR] [--port N] [--width N]
 *
 * Produces one PNG per entry in beats.mjs, ready for build.mjs.
 *
 * ── Why this is a committed script and not a session of browser automation ──
 * The previous demo GIF was shot by hand through an interactive browser tool,
 * clicking elements by per-snapshot reference ids (`click("f2e318")`). Those ids
 * are regenerated per page load, so the recipe was unrepeatable the moment the
 * session ended — which is why the whole thing had to be reverse-engineered from
 * a chat transcript. Everything here addresses elements by ROLE and TEXT, which
 * survives a reload, a re-seed, and most UI churn.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 * The UI is full of things that differ between two otherwise identical runs:
 * spinners, pulsing dots, a blinking caret, and a "working" pill that cycles
 * random phrases. Playwright's `reducedMotion: "reduce"` is honoured by the
 * app's CSS and freezes all of it, so two runs produce near-identical frames.
 * Relative timestamps ("3h ago") stay stable because the seed derives every
 * timestamp from a single `--now`.
 *
 * Stills are captured at 2x device scale and downsampled by build.mjs; the
 * supersampling is what keeps 12px UI text legible after GIF quantisation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { startServer, REPO_ROOT } from "./serve.mjs";
import { BEATS } from "./beats.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};

const OUT = path.resolve(arg("out", "/tmp/paddock-demo"));
const PORT = Number(arg("port", "7311"));
const WIDTH = Number(arg("width", "1200"));
const HEIGHT = Number(arg("height", "750"));
const SCALE = Number(arg("scale", "2"));
const SHOTS = path.join(OUT, "stills");

const log = (...a) => console.log("[shoot]", ...a);

// ── 1. seed ─────────────────────────────────────────────────────────────────
// Always re-seed: the rig accumulates state (read marks, live turns, sweeps) the
// moment a server touches it, so reusing a previous run's dir means shooting a
// slightly different world each time.
log("seeding", OUT);
execFileSync(
  process.execPath,
  [path.join(path.dirname(fileURLToPath(import.meta.url)), "seed.mjs"), "--out", OUT],
  { stdio: "inherit" },
);
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ── 2. boot ─────────────────────────────────────────────────────────────────
log("starting server on", PORT);
const server = await startServer({
  dataDir: path.join(OUT, "data"),
  home: path.join(OUT, "home"),
  port: PORT,
  fakeScript: path.join(OUT, "fake-script.json"),
  logFile: path.join(OUT, "server.log"),
});
const BASE = server.base;

// Register teardown BEFORE anything else can throw. Chromium's launch fails on a
// fresh checkout ("Executable doesn't exist… npx playwright install"), and if
// that happens outside a guarded region the server is left orphaned holding the
// port — which the next run then mistakes for its own healthy boot.
let browser;
const teardown = () => {
  try {
    browser?.close();
  } catch {
    /* already gone */
  }
  // Only ever the child we started — never pattern-match and kill "stray"
  // Paddock processes: this box runs many instances, production included.
  server.stop();
};
process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    teardown();
    process.exit(1);
  });
}

browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: SCALE,
  // Freezes spinners, pulses, the streaming caret and the skeleton shimmer.
  reducedMotion: "reduce",
  colorScheme: "dark",
});
const page = await ctx.newPage();

/** A tool-call card, addressed by the text in its header. */
const toolCard = (re) => page.locator("button").filter({ hasText: re }).first();

const shot = async (id) => {
  const file = path.join(SHOTS, `${id}.png`);
  await page.screenshot({ path: file });
  log("captured", id);
};

/** Scroll the transcript pane (the only tall scroller on a chat page). */
const scrollTranscript = async (top) => {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200,
    );
    if (el) el.scrollTop = t === "bottom" ? el.scrollHeight : t;
  }, top);
  await page.waitForTimeout(250);
};

/**
 * Put a tool card's header just below the top of the transcript, so the frame is
 * filled by what the card EXPANDS INTO rather than by the messages above it.
 * `scrollIntoViewIfNeeded` is wrong here: it does the minimum scroll to make the
 * element visible, which for a card that has just grown leaves the header near
 * the bottom of the viewport and its body cut off.
 */
const frameCard = async (locator, offset = 24) => {
  await locator.evaluate((el, off) => {
    const scroller = el.closest(".overflow-y-auto") ?? el.offsetParent;
    if (!scroller) return;
    const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += delta - off;
  }, offset);
  await page.waitForTimeout(400);
};

const star = manifest.chats["lumen-cli:star"];
const chatUrl = (slug, id) => `${BASE}/projects/${slug}/chat/${id}`;

try {
  // ── 3. drive the live turns ───────────────────────────────────────────────
  // The Home "Running" feed reads from the server's in-memory session hub, so it
  // cannot be faked on disk — a genuinely live turn is the only way to populate
  // it. `[[HANG]]` makes the fake `claude` stream its reply and then never write
  // the terminal result line, so the turn stays running until we tear the server
  // down. The directive has to be in the PROMPT, so it lands as a follow-up in a
  // chat whose NAME (taken from its first message, seeded) is what the feed row
  // actually shows.
  for (const [key, slug] of [
    ["lumen-cli:live-ci", "lumen-cli"],
    ["trail-atlas:live-elevation", "trail-atlas"],
  ]) {
    const id = manifest.chats[key];
    await page.goto(chatUrl(slug, id), { waitUntil: "domcontentloaded" });
    const box = page.getByPlaceholder(/Message Claude/i);
    await box.waitFor({ timeout: 15_000 });
    await box.fill("Re-run the matrix build and report which legs are still red. [[HANG]]");
    await box.press("Enter");
    // Wait for the turn to actually register as running before moving on.
    await page.waitForTimeout(1_500);
    log("live turn started in", slug);
  }
  // Give the attention feed's debounce time to settle on the new state.
  await page.waitForTimeout(3_000);

  // ── 4. the beats ──────────────────────────────────────────────────────────
  // BEAT: root Home — the fleet-wide running + unread feeds.
  // Match on the test id, not the label text: the section headings are
  // CSS-uppercased ("RUNNING" on screen is "Running" in the DOM). And assert the
  // feed actually has rows — the container renders either way, so waiting for it
  // alone would happily photograph "Nothing running right now."
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const runningFeed = page.locator('[data-testid="home-running-chats"]');
  await runningFeed.waitFor({ timeout: 15_000 });
  await page
    .locator('[data-testid="home-running-chats"]')
    .filter({ hasNotText: "Nothing running" })
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1_200);
  await shot("home");

  // BEAT: the projects grid.
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  // `exact` matters: without it this also matches the "Side Projects" group
  // heading and Playwright fails the whole run on a strict-mode violation.
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1_200);
  await shot("projects");

  // BEAT: the chat, scrolled so the sub-agent card and the first tool calls show.
  await page.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
  await toolCard(/sub-agent/i).waitFor({ timeout: 15_000 });
  await scrollTranscript(0);
  await shot("chat");

  // BEAT: the sub-agent card expanded into its own nested steps.
  await toolCard(/sub-agent/i).click();
  await page.waitForTimeout(1_200);
  await frameCard(toolCard(/sub-agent/i));
  await shot("subagent");

  // BEAT: the Edit block expanded to its inline diff. Reload first so the
  // sub-agent expansion above doesn't stack two open cards into one long page.
  await page.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
  await toolCard(/render\.ts/).waitFor({ timeout: 15_000 });
  await toolCard(/render\.ts/).click();
  await page.waitForTimeout(800);
  await frameCard(toolCard(/render\.ts/));
  await shot("diff");

  // BEAT: the Read block expanded to the inline image.
  await page.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
  await toolCard(/palette-preview\.png/).waitFor({ timeout: 15_000 });
  await toolCard(/palette-preview\.png/).click();
  // The <img> is fetched from the project's raw-file endpoint — wait for it to
  // decode, or the frame catches an empty box.
  await page.waitForTimeout(1_500);
  await frameCard(toolCard(/palette-preview\.png/));
  await shot("image");

  // BEAT: the Triggers tab.
  await page.goto(`${BASE}/projects/lumen-cli/triggers`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="triggers-pane"]').waitFor({ timeout: 15_000 });
  // The trigger's name and its prompt-file both contain "nightly-triage", so
  // match the name cell exactly rather than by substring.
  await page.getByText("nightly-triage", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  await shot("triggers");

  // BEAT: the Changes tab, with a file selected so the diff pane is populated.
  await page.goto(`${BASE}/projects/lumen-cli/changes`, { waitUntil: "networkidle" });
  await page.getByText("src/render.ts").first().waitFor({ timeout: 15_000 });
  await page.getByText("src/render.ts").first().click();
  await page.waitForTimeout(1_200);
  await shot("changes");

  // ── 5. sanity-check ───────────────────────────────────────────────────────
  const missing = BEATS.filter((b) => !fs.existsSync(path.join(SHOTS, `${b.id}.png`)));
  if (missing.length) {
    throw new Error(`beats not captured: ${missing.map((b) => b.id).join(", ")}`);
  }
  log(`captured ${BEATS.length} beats into ${SHOTS}`);
} finally {
  await browser.close().catch(() => {});
  server.stop();
}
