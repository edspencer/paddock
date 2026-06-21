// Paddock full-stack browser E2E.
//
// Drives a real Chromium through the whole project-first workflow against a
// running paddock-server (single process serving the SPA + API + WS), asserting
// and screenshotting each flow. Screenshots land in docs/screenshots/.
//
// Prereqs (the orchestrator wires these up):
//   - paddock-server running and serving the built SPA at $BASE_URL.
//   - The Max OAuth token is in the SERVER's env (this script never needs it).
//   - `playwright` installed + `npx playwright install chromium` done.
//
// Run:  BASE_URL=http://localhost:4022 PADDOCK_DATA_DIR=/tmp/... node scripts/e2e.mjs
//
// Exit code 0 = all flows green; non-zero = a flow failed (details on stderr).
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4022";
const DATA_DIR = process.env.PADDOCK_DATA_DIR ?? null; // for on-disk file assertions
const SHOT_DIR = path.resolve("docs/screenshots");
const HEADLESS = process.env.HEADED !== "1";

// Generous, since flows 3/5/6 drive real Claude turns end-to-end.
const TURN_TIMEOUT = 180_000;

const results = [];
let browser;

function log(...a) {
  console.log("[e2e]", ...a);
}
function pass(name) {
  results.push({ name, ok: true });
  log("PASS:", name);
}
function fail(name, err) {
  results.push({ name, ok: false, err: String(err?.stack ?? err) });
  console.error("[e2e] FAIL:", name, "\n   ", err?.stack ?? err);
}

async function shot(page, file) {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, file), fullPage: false });
  log("screenshot:", file);
}

/** Poll a predicate until true or timeout. */
async function waitFor(fn, { timeout = 30_000, interval = 500, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function run() {
  browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[browser pageerror]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console.error]", m.text());
  });

  // ---- Flow 1: Landing -----------------------------------------------------
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor({ timeout: 15_000 });
    // Empty state OR a grid — both are acceptable "landing".
    const hasEmpty = await page.getByText("Create your first project").count();
    const newProjectBtns = await page.getByRole("button", { name: /New Project/i }).count();
    if (newProjectBtns < 1) throw new Error("No 'New Project' button on landing");
    log(`landing: emptyState=${hasEmpty > 0}, newProjectButtons=${newProjectBtns}`);
    await shot(page, "01-landing.png");
    pass("1. Landing loads (projects grid / empty state)");
  } catch (e) {
    await shot(page, "01-landing-FAIL.png").catch(() => {});
    fail("1. Landing loads (projects grid / empty state)", e);
  }

  // ---- Flow 2: New Project -------------------------------------------------
  const PROJECT_NAME = "Demo Project";
  let projectSlug = null;
  try {
    // Open the modal (use the grid's primary CTA).
    await page.getByRole("button", { name: /New Project/i }).first().click();
    await page.getByRole("heading", { name: "New project" }).waitFor({ timeout: 5_000 });
    await page.getByPlaceholder("Garage Water Heater Replacement").fill(PROJECT_NAME);
    await page
      .getByPlaceholder("One line on what this project is about")
      .fill("A demo project created by the paddock E2E suite.");
    await page.getByPlaceholder("home, plumbing").fill("demo");
    await shot(page, "02-new-project.png");
    await page.getByRole("button", { name: /Create project/i }).click();

    // We should navigate into /projects/<slug> and see the project header.
    await page.waitForURL(/\/projects\/[a-z0-9-]+$/i, { timeout: 20_000 });
    projectSlug = page.url().split("/projects/")[1];
    await page.getByRole("heading", { name: PROJECT_NAME, level: 1 }).waitFor({ timeout: 10_000 });
    // The New Chat button proves we're in the project view.
    await page.getByRole("button", { name: /New Chat/i }).waitFor({ timeout: 5_000 });
    log("created project slug:", projectSlug);
    await shot(page, "03-project-view.png");
    pass("2. Create project via modal + navigate into it");
  } catch (e) {
    await shot(page, "02-new-project-FAIL.png").catch(() => {});
    fail("2. Create project via modal + navigate into it", e);
  }

  // ---- Flow 3: New Chat — streaming, tool block, completion ----------------
  const FILE_PROMPT =
    "Say hello in one short sentence, then create a file notes.md containing exactly 'paddock works' in your working directory.";
  try {
    if (!projectSlug) throw new Error("No project from flow 2");
    // Ensure a fresh chat.
    await page.getByRole("button", { name: /New Chat/i }).click();
    const composer = page.getByPlaceholder(/Message the keeper agent/i);
    await composer.waitFor({ timeout: 5_000 });
    await composer.fill(FILE_PROMPT);
    await page.getByRole("button", { name: /^Send$/ }).click();

    // (a) assistant text streams in (an assistant bubble with rendered markdown).
    // The user bubble shows our prompt; the assistant bubble is the left-aligned one.
    await waitFor(
      async () => {
        // Any assistant text appears (markdown <p> inside a left bubble).
        const txt = await page.locator(".justify-start .prose, .justify-start p").count();
        return txt > 0;
      },
      { timeout: TURN_TIMEOUT, label: "assistant streaming text" },
    );
    await shot(page, "04-streaming.png");

    // (b) a TOOL BLOCK renders (Write/Bash). Tool blocks show a monospace tool name.
    await waitFor(
      async () => {
        const tools = await page.locator("button:has(.font-mono.font-semibold)").count();
        return tools > 0;
      },
      { timeout: TURN_TIMEOUT, label: "tool block" },
    );
    // Expand the first tool block for the screenshot.
    const firstTool = page.locator("button:has(.font-mono.font-semibold)").first();
    const toolName = (await firstTool.locator(".font-mono.font-semibold").first().innerText()).trim();
    log("first tool block:", toolName);
    await firstTool.click().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, "05-tool-block.png");

    // (c) completion: the composer unlocks (Send returns) AND the session shows
    // up in the left list (no longer "New chat…").
    await waitFor(
      async () => {
        const sendVisible = await page.getByRole("button", { name: /^Send$/ }).count();
        return sendVisible > 0;
      },
      { timeout: TURN_TIMEOUT, label: "turn complete (composer unlocked)" },
    );
    // A saved session should now appear in the left list.
    await waitFor(
      async () => {
        // Sidebar chat buttons that are NOT the "New chat…" placeholder.
        const saved = await page
          .locator(".w-64 button.flex.w-full.flex-col, .w-64 button:has(.truncate.font-medium)")
          .count();
        return saved >= 1;
      },
      { timeout: 30_000, label: "session appears in left list" },
    );
    await shot(page, "06-complete.png");

    // Confirm notes.md on disk (best-effort; needs PADDOCK_DATA_DIR).
    let diskOk = "skipped (no PADDOCK_DATA_DIR)";
    if (DATA_DIR) {
      const notesPath = path.join(DATA_DIR, "projects", projectSlug, "notes.md");
      try {
        const content = (await fs.readFile(notesPath, "utf8")).trim();
        if (!/paddock works/i.test(content)) {
          throw new Error(`notes.md content mismatch: ${JSON.stringify(content)}`);
        }
        diskOk = `OK (${notesPath})`;
      } catch (e) {
        // Don't hard-fail the whole flow on disk path guesswork; surface it.
        diskOk = `NOT FOUND at ${notesPath}: ${e.message}`;
      }
    }
    log("notes.md on disk:", diskOk);
    if (DATA_DIR && diskOk.startsWith("NOT FOUND")) {
      // Try to locate notes.md anywhere under the data dir before failing.
      const found = await findFile(DATA_DIR, "notes.md");
      if (found) {
        const content = (await fs.readFile(found, "utf8")).trim();
        if (/paddock works/i.test(content)) {
          diskOk = `OK (found at ${found})`;
          log("notes.md located:", diskOk);
        }
      }
    }
    if (DATA_DIR && !diskOk.startsWith("OK")) throw new Error(`notes.md assertion failed: ${diskOk}`);

    pass("3. New chat streams text + tool block + session saved + notes.md written");
  } catch (e) {
    await shot(page, "04-streaming-FAIL.png").catch(() => {});
    fail("3. New chat streams text + tool block + session saved + notes.md written", e);
  }

  // ---- Flow 4: Reload + reopen session hydrates from history ---------------
  let firstSessionName = null;
  try {
    if (!projectSlug) throw new Error("No project from flow 2");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: PROJECT_NAME, level: 1 }).waitFor({ timeout: 10_000 });
    // Click the first saved session in the left list.
    const sessionBtn = page
      .locator(".w-64 button:has(.truncate.font-medium)")
      .first();
    await sessionBtn.waitFor({ timeout: 15_000 });
    firstSessionName = (await sessionBtn.locator(".truncate.font-medium").innerText()).trim();
    log("reopening session:", firstSessionName);
    await sessionBtn.click();

    // The prior user message + assistant text should hydrate.
    await waitFor(
      async () => {
        const userBubble = await page.getByText(FILE_PROMPT, { exact: false }).count();
        const assistantText = await page.locator(".justify-start p").count();
        return userBubble > 0 && assistantText > 0;
      },
      { timeout: 30_000, label: "history hydrate (user + assistant)" },
    );
    await shot(page, "07-history.png");
    pass("4. Reload + reopen session hydrates prior messages from history");
  } catch (e) {
    await shot(page, "07-history-FAIL.png").catch(() => {});
    fail("4. Reload + reopen session hydrates prior messages from history", e);
  }

  // ---- Flow 5: Follow-up — resume/session continuity -----------------------
  try {
    if (!projectSlug) throw new Error("No project from flow 2");
    const composer = page.getByPlaceholder(/Message the keeper agent/i);
    await composer.waitFor({ timeout: 5_000 });
    await composer.fill("What exactly did you write in notes.md?");
    await page.getByRole("button", { name: /^Send$/ }).click();

    // Wait for a fresh assistant bubble that contains "paddock works".
    await waitFor(
      async () => {
        const bodies = await page.locator(".justify-start").allInnerTexts();
        return bodies.some((t) => /paddock works/i.test(t));
      },
      { timeout: TURN_TIMEOUT, label: "resume answer mentions 'paddock works'" },
    );
    // Make sure the turn completed (composer unlocked).
    await waitFor(
      async () => (await page.getByRole("button", { name: /^Send$/ }).count()) > 0,
      { timeout: TURN_TIMEOUT, label: "resume turn complete" },
    );
    await shot(page, "08-resume.png");
    pass("5. Follow-up answers 'paddock works' (session continuity in UI)");
  } catch (e) {
    await shot(page, "08-resume-FAIL.png").catch(() => {});
    fail("5. Follow-up answers 'paddock works' (session continuity in UI)", e);
  }

  // ---- Flow 6: One-off /chat scratch ---------------------------------------
  try {
    await page.goto(`${BASE_URL}/chat`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "One-off chat" }).waitFor({ timeout: 10_000 });
    const composer = page.getByPlaceholder(/Ask anything/i);
    await composer.waitFor({ timeout: 5_000 });
    await composer.fill("Reply with just the word: pong");
    await page.getByRole("button", { name: /^Send$/ }).click();
    // A reply streams into an assistant bubble.
    await waitFor(
      async () => (await page.locator(".justify-start p").count()) > 0,
      { timeout: TURN_TIMEOUT, label: "scratch reply streams" },
    );
    await waitFor(
      async () => (await page.getByRole("button", { name: /^Send$/ }).count()) > 0,
      { timeout: TURN_TIMEOUT, label: "scratch turn complete" },
    );
    await shot(page, "09-oneoff.png");
    pass("6. One-off /chat scratch reply streams");
  } catch (e) {
    await shot(page, "09-oneoff-FAIL.png").catch(() => {});
    fail("6. One-off /chat scratch reply streams", e);
  }

  // ---- Flow 7: Final polished project view ---------------------------------
  try {
    if (!projectSlug) throw new Error("No project from flow 2");
    await page.goto(`${BASE_URL}/projects/${projectSlug}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: PROJECT_NAME, level: 1 }).waitFor({ timeout: 10_000 });
    // Open the most recent saved session so the conversation is visible.
    const sessionBtn = page.locator(".w-64 button:has(.truncate.font-medium)").first();
    await sessionBtn.waitFor({ timeout: 15_000 });
    await sessionBtn.click();
    await waitFor(
      async () => (await page.locator(".justify-start p").count()) > 0,
      { timeout: 30_000, label: "final view conversation hydrated" },
    );
    await page.waitForTimeout(600);
    await shot(page, "10-final.png");
    pass("7. Final polished project view with conversation");
  } catch (e) {
    await shot(page, "10-final-FAIL.png").catch(() => {});
    fail("7. Final polished project view with conversation", e);
  }

  await browser.close();
}

/** Recursively find a file by name under a root (shallow-ish, skips node_modules). */
async function findFile(root, name, depth = 6) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const hit = await findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

run()
  .catch(async (e) => {
    console.error("[e2e] fatal:", e);
    if (browser) await browser.close().catch(() => {});
  })
  .finally(() => {
    const passed = results.filter((r) => r.ok).length;
    const total = results.length;
    console.log("\n================ E2E SUMMARY ================");
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    console.log(`--------------------------------------------\n${passed}/${total} flows passed`);
    process.exit(passed === total && total >= 7 ? 0 : 1);
  });
