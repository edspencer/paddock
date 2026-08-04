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

/**
 * Record a short screen capture as a beat.
 *
 * This runs in its OWN browser context, for one reason: it is the only beat that
 * wants motion, so it is the only one that turns `reducedMotion` off (giving a
 * blinking caret, a live spinner, and the cycling "working" pill). Every still
 * beat keeps reduced motion on and stays frame-for-frame reproducible — the
 * non-determinism is quarantined to this clip.
 *
 * `recordVideo.size` is set to the FINAL output size, not the capture size. The
 * page still renders at deviceScaleFactor 2, and Playwright downsamples device
 * pixels into that frame — so the clip is supersampled exactly like the stills
 * and cuts together with them without a visible drop in sharpness. Setting the
 * size to 2400x1500 instead does NOT upscale; it pads the 1200x750 render into a
 * larger frame with grey.
 */
async function recordClip(id, seconds, drive) {
  const raw = path.join(SHOTS, "raw");
  fs.mkdirSync(raw, { recursive: true });
  const vctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
    recordVideo: { dir: raw, size: { width: WIDTH, height: HEIGHT } },
  });
  const vpage = await vctx.newPage();
  // The GIF uses a single frame in place of this clip (see below), and `drive`
  // takes it at the one moment it knows is right, rather than build.mjs guessing
  // a timestamp that drifts whenever the turn's timing changes.
  const poster = () => vpage.screenshot({ path: path.join(SHOTS, `${id}.png`) });
  const startedAt = await drive(vpage, poster);
  await vctx.close(); // finalises the .webm
  const file = fs
    .readdirSync(raw)
    .map((f) => path.join(raw, f))
    .filter((f) => f.endsWith(".webm"))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  // Trim to the interesting window and re-encode, so build.mjs gets a clip whose
  // timestamps start at zero and whose length is exactly the beat's hold.
  const out = path.join(SHOTS, `${id}.webm`);
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(startedAt), "-t", String(seconds),
    "-i", file, "-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-an", out,
  ]);
  // Motion is close to free in H.264/VP9 and ruinous in GIF: every frame of a
  // moving beat changes every pixel, and this one clip took the GIF from 1.6 MB
  // to 6.5 MB (4.4 MB even at 6fps, by which point the crossfades stutter). So
  // the video outputs get the motion and the GIF holds the poster `drive` took.
  if (!fs.existsSync(path.join(SHOTS, `${id}.png`))) {
    throw new Error(`clip "${id}" recorded no poster frame — call poster() inside drive()`);
  }
  log("recorded", id, `(${seconds}s from +${startedAt}s)`);
}

/**
 * A phone-shaped beat. Captured at a real mobile viewport (so the app takes its
 * own off-canvas-drawer layout rather than a squashed desktop one), then centred
 * on the app's own canvas colour to fill the 16:10 frame the rest of the reel
 * uses.
 */
async function shotMobile(id) {
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: SCALE,
    reducedMotion: "reduce",
    colorScheme: "dark",
    isMobile: true,
    hasTouch: true,
  });
  const mpage = await mctx.newPage();
  const shotPath = path.join(SHOTS, "raw", `${id}-phone.png`);
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  await mpage.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
  await mpage.getByPlaceholder(/Message Claude/i).waitFor({ timeout: 15_000 });
  await mpage.waitForTimeout(1_500);
  await mpage.screenshot({ path: shotPath });
  await mctx.close();
  const W = WIDTH * SCALE;
  const H = HEIGHT * SCALE;
  // Fit the phone to most of the frame height, centre it on the canvas colour
  // the app itself uses, and outline it. The outline matters: the padding is the
  // same colour as the app's own background, so without an edge the shot reads
  // as a narrow crop of the desktop UI rather than a phone.
  const phoneH = Math.round(H * 0.94);
  const phoneW = Math.round((390 / 844) * phoneH);
  const x = Math.round((W - phoneW) / 2);
  const y = Math.round((H - phoneH) / 2);
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", shotPath,
    "-vf",
    [
      `scale=${phoneW}:${phoneH}`,
      `pad=${W}:${H}:${x}:${y}:color=0x141210`,
      `drawbox=x=${x - 3}:y=${y - 3}:w=${phoneW + 6}:h=${phoneH + 6}:color=0x4a423a:t=3`,
    ].join(","),
    path.join(SHOTS, `${id}.png`),
  ]);
  log("captured", id, "(mobile)");
}

const star = manifest.chats["lumen-cli:star"];
/** Typed on camera in the motion beat; its reply is scripted in fixtures.mjs. */
const MOTION_PROMPT = "Add a --no-truecolor flag for the tests.";

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

  // BEAT: the sub-agent card expanded into its own nested steps.
  await page.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
  await toolCard(/sub-agent/i).waitFor({ timeout: 15_000 });
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

  // BEAT: Claude opening its own chats. One frame carries the whole story — the
  // `create_chat` cards (expanded by default) AND the resulting children nested
  // under their parent in the sidebar.
  await page.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
  const createCard = page.locator("button").filter({ hasText: /Create chat/i }).first();
  await createCard.waitFor({ timeout: 15_000 });
  await frameCard(createCard);
  await shot("spawn");

  // BEAT: files rendered in the conversation. Mermaid draws client-side, and the
  // library is code-split across several chunks — so the diagram appears a beat
  // after the page is otherwise idle. Wait for the actual <svg>, not the card.
  await page.goto(chatUrl("lumen-cli", manifest.chats["lumen-cli:handoff"]), {
    waitUntil: "networkidle",
  });
  // Match the HOST element, not the svg id: mermaid stamps its own ids
  // (`mmd-r24-svg`), so `svg[id^="mermaid"]` never matches and the wait times
  // out even though the diagram drew fine.
  const diagram = page.locator(".mermaid-host svg").first();
  await diagram.waitFor({ timeout: 25_000 });
  await page.waitForTimeout(1_200);
  // Frame on the diagram's card so the drawing leads and the document below it
  // is visible underneath.
  await frameCard(page.locator("button").filter({ hasText: /pipeline\.mmd/ }).first());
  await shot("sendfile");

  // BEAT: fork / rewind. We shoot the REVERT CONFIRMATION rather than the hover
  // rail itself: the rail is a pair of 16px icons that all but disappear at GIF
  // scale, whereas the dialog states in words how much is about to be discarded
  // and that the side effects are NOT undone.
  //
  // Two preconditions: the rail only renders for turns with a real UUID id (so
  // the chat must be loaded from history, not just sent), and it is revealed by
  // CSS :hover — a direct click fails Playwright's actionability check.
  await page.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
  const anchorMsg = page
    .locator("div.group.relative")
    .filter({ hasText: "Fallback is in. Running the suite" })
    .first();
  await anchorMsg.waitFor({ timeout: 15_000 });
  await anchorMsg.scrollIntoViewIfNeeded();
  await anchorMsg.hover();
  // Focus rather than click. The rail floats on `-top-3`, so it overlaps the
  // bubble above it and a real click is intercepted by that bubble; the rail is
  // revealed by `group-focus-within` just as much as by `group-hover`, so
  // focusing the button both shows it and lets Enter activate it.
  const revertBtn = page
    .getByRole("button", { name: "Revert conversation back to here" })
    .first();
  await revertBtn.focus();
  await page.waitForTimeout(200);
  await revertBtn.press("Enter");
  await page.getByRole("alertdialog").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot("fork");

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

  // BEAT: History — what ran unattended while you were away.
  await page.goto(`${BASE}/projects/lumen-cli/history`, { waitUntil: "networkidle" });
  await page.getByText(/new runs ran while you were away/).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  await shot("history");

  // BEAT: the same instance from a phone.
  await shotMobile("mobile");

  // Captured LAST on purpose: it sends a real message, which appends a turn to
  // the star chat. Every still that photographs that chat has to be taken while
  // it is still exactly as seeded.
  // BEAT (clip): a turn, live.
  // The deterministic fake `claude` writes each reply as ONE transcript line, so
  // there is no token-by-token typing to film — the honest motion available here
  // is the interaction loop: a message being typed, sent, the turn going busy,
  // and the answer landing. `pressSequentially` is what makes the typing legible;
  // the reply itself comes from the seeded fake-script, so the words are ours.
  await recordClip("motion", 4.0, async (vpage, poster) => {
    // Recording starts when the context is created, so the trim offset is
    // MEASURED from here rather than guessed. A hard-coded offset drifts the
    // moment the page takes longer to settle, and the clip silently ends up all
    // typing with the reply cut off the end.
    const t0 = Date.now();
    await vpage.goto(chatUrl("lumen-cli", star), { waitUntil: "networkidle" });
    const box = vpage.getByPlaceholder(/Message Claude/i);
    await box.waitFor({ timeout: 15_000 });
    await vpage.waitForTimeout(900);
    await box.click();
    const typingStart = Date.now();
    await box.pressSequentially(MOTION_PROMPT, { delay: 45 });
    await box.press("Enter");
    // Wait for the reply itself, not a fixed delay — then a moment more for its
    // fade-in to finish, or the poster catches the text half-transparent.
    await vpage.getByText(/^Added\./).first().waitFor({ timeout: 20_000 });
    await vpage.waitForTimeout(900);
    // The GIF's frame for this beat: the question asked and answered, which
    // reads as a complete exchange. An in-flight frame would be more dramatic
    // but a frozen "working…" pill just looks like a stalled UI in a still.
    await poster();
    await vpage.waitForTimeout(1_200);
    // Start a beat before the first keystroke.
    return Math.max(0, (typingStart - t0) / 1000 - 0.4);
  });

  // ── 5. sanity-check ───────────────────────────────────────────────────────
  const missing = BEATS.filter(
    (b) => !fs.existsSync(path.join(SHOTS, `${b.id}.${b.kind === "clip" ? "webm" : "png"}`)),
  );
  if (missing.length) {
    throw new Error(`beats not captured: ${missing.map((b) => b.id).join(", ")}`);
  }
  log(`captured ${BEATS.length} beats into ${SHOTS}`);
} finally {
  await browser.close().catch(() => {});
  server.stop();
}
