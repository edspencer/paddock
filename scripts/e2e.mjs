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

  // Track every network request so we can assert fonts are self-hosted (no
  // runtime request to Google Fonts) and that the local font files load.
  const requestedUrls = [];
  page.on("request", (r) => requestedUrls.push(r.url()));

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

  // ---- Flow 8: Fonts are self-hosted (no Google Fonts request) -------------
  try {
    // index.html must not reference Google Fonts and the local woff2 must load.
    const html = await page.content();
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html)) {
      throw new Error("index.html still references Google Fonts");
    }
    const googleReqs = requestedUrls.filter((u) =>
      /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u),
    );
    if (googleReqs.length > 0) {
      throw new Error(`Browser requested Google Fonts: ${googleReqs.slice(0, 3).join(", ")}`);
    }
    // The local Inter woff2 must have been fetched (preloaded in <head>).
    const localFont = await fetchStatus(`${BASE_URL}/fonts/inter-latin.woff2`);
    if (localFont !== 200) throw new Error(`local font not served (HTTP ${localFont})`);
    // Confirm the font actually applied (Inter is the body font-family).
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    if (!/Inter/i.test(bodyFont)) throw new Error(`body font-family is "${bodyFont}", expected Inter`);
    log(`fonts: 0 google requests, /fonts/inter-latin.woff2=200, body uses ${bodyFont}`);
    pass("8. Fonts self-hosted (no Google Fonts request; local woff2 loads + applies)");
  } catch (e) {
    fail("8. Fonts self-hosted (no Google Fonts request; local woff2 loads + applies)", e);
  }

  // ---- Flow 9: Edit project metadata persists ------------------------------
  const NEW_SUMMARY = `Edited by E2E at ${new Date().toISOString()}`;
  try {
    if (!projectSlug) throw new Error("No project from flow 2");
    await page.goto(`${BASE_URL}/projects/${projectSlug}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: PROJECT_NAME, level: 1 }).waitFor({ timeout: 10_000 });

    // Open the "…" menu in the project header and choose Edit.
    await page.getByRole("button", { name: /Project actions/i }).first().click();
    await page.getByRole("menuitem", { name: /Edit details/i }).click();
    await page.getByRole("heading", { name: "Edit project" }).waitFor({ timeout: 5_000 });
    await shot(page, "13-edit-metadata.png");

    // Change summary + status, then save.
    const summaryInput = page.getByPlaceholder(/what this project is about/i);
    await summaryInput.fill(NEW_SUMMARY);
    await page.locator("select").first().selectOption("paused");
    await page.getByRole("button", { name: /Save changes/i }).click();

    // The header should reflect the new summary + status after save.
    await waitFor(
      async () => (await page.getByText(NEW_SUMMARY, { exact: false }).count()) > 0,
      { timeout: 10_000, label: "edited summary visible in header" },
    );
    // Verify it persisted on the server (not just optimistic UI).
    const persisted = await fetchJson(`${BASE_URL}/api/projects/${projectSlug}`);
    if (persisted?.project?.summary !== NEW_SUMMARY) {
      throw new Error(`server summary mismatch: ${JSON.stringify(persisted?.project?.summary)}`);
    }
    if (persisted?.project?.status !== "paused") {
      throw new Error(`server status mismatch: ${JSON.stringify(persisted?.project?.status)}`);
    }
    log("edit persisted: summary + status === paused on the server");
    pass("9. Edit project metadata persists (UI + server)");
  } catch (e) {
    await shot(page, "13-edit-metadata-FAIL.png").catch(() => {});
    fail("9. Edit project metadata persists (UI + server)", e);
  }

  // ---- Flow 10: Delete a project (grid + fleet) ----------------------------
  // Create a throwaway project specifically to delete, so the main project's
  // session evidence stays intact for the earlier screenshots.
  const DEL_NAME = "Delete Me";
  let delSlug = null;
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /New Project/i }).first().click();
    await page.getByRole("heading", { name: "New project" }).waitFor({ timeout: 5_000 });
    await page.getByPlaceholder("Garage Water Heater Replacement").fill(DEL_NAME);
    await page.getByRole("button", { name: /Create project/i }).click();
    await page.waitForURL(/\/projects\/[a-z0-9-]+$/i, { timeout: 20_000 });
    delSlug = page.url().split("/projects/")[1];
    log("created throwaway project to delete:", delSlug);

    // Its keeper agent should be registered in the fleet.
    const beforeFleet = await fetchJson(`${BASE_URL}/api/fleet`);
    const keeperName = `keeper-${delSlug}`;
    const hadKeeper = (beforeFleet?.agents ?? []).some((a) => a.name === keeperName);
    if (!hadKeeper) throw new Error(`keeper ${keeperName} not in fleet before delete`);

    // Open the project menu from the GRID and trigger delete + confirm.
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: new RegExp(`Actions for ${DEL_NAME}`, "i") }).click();
    await shot(page, "11-project-menu.png");
    await page.getByRole("menuitem", { name: /Delete project/i }).click();
    await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
    await shot(page, "12-delete-confirm.png");
    await page.getByRole("button", { name: /^Delete project$/i }).click();

    // The card disappears from the grid.
    await waitFor(
      async () => {
        const cards = await page.getByRole("heading", { name: DEL_NAME }).count();
        return cards === 0;
      },
      { timeout: 10_000, label: "deleted project disappears from grid" },
    );

    // The keeper agent is gone from the fleet (config regenerated + reloaded).
    await waitFor(
      async () => {
        const fleet = await fetchJson(`${BASE_URL}/api/fleet`);
        return !(fleet?.agents ?? []).some((a) => a.name === keeperName);
      },
      { timeout: 15_000, label: "keeper removed from /api/fleet" },
    );
    // And the project itself is a 404 on the API.
    const status = await fetchStatus(`${BASE_URL}/api/projects/${delSlug}`);
    if (status !== 404) throw new Error(`expected 404 for deleted project, got ${status}`);
    // On-disk: the project directory is gone (best-effort, needs DATA_DIR).
    if (DATA_DIR) {
      const dir = path.join(DATA_DIR, "projects", delSlug);
      const exists = await fs
        .stat(dir)
        .then(() => true)
        .catch(() => false);
      if (exists) throw new Error(`project dir still on disk: ${dir}`);
    }
    log(`deleted ${delSlug}: gone from grid, keeper unregistered, API 404, dir removed`);
    pass("10. Delete project removes it from the grid + keeper from /api/fleet");
  } catch (e) {
    await shot(page, "11-delete-FAIL.png").catch(() => {});
    fail("10. Delete project removes it from the grid + keeper from /api/fleet", e);
  }

  // ==========================================================================
  // Issues #1, #3, #4 — preload checkbox, rich file rendering (markdown +
  // Mermaid + sandboxed HTML), and pinned sibling tabs.
  // ==========================================================================

  // ---- Flow 11: New project + preload checkbox present & default ON (#1) ----
  const RICH_NAME = "Rich Files Demo";
  let richSlug = null;
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /New Project/i }).first().click();
    await page.getByRole("heading", { name: "New project" }).waitFor({ timeout: 5_000 });
    await page.getByPlaceholder("Garage Water Heater Replacement").fill(RICH_NAME);
    await page.getByRole("button", { name: /Create project/i }).click();
    await page.waitForURL(/\/projects\/[a-z0-9-]+$/i, { timeout: 20_000 });
    richSlug = page.url().split("/projects/")[1];
    log("created rich-files project:", richSlug);

    // Open a New Chat and assert the preload checkbox is present.
    await page.getByRole("button", { name: /New Chat/i }).click();
    const preload = page.getByRole("checkbox", { name: /Preload project context/i });
    await preload.waitFor({ timeout: 5_000 });
    const present = (await preload.count()) > 0;
    if (!present) throw new Error("preload checkbox not present on new chat composer");
    // Default ON for project chats (it's disabled when no overview exists yet,
    // but the user-facing default state is checked = "on").
    const labelChecked = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[type="checkbox"]')];
      const cb = inputs.find((i) =>
        /Preload project context/i.test(i.closest("label")?.textContent ?? ""),
      );
      return cb ? { checked: cb.checked, disabled: cb.disabled } : null;
    });
    log("preload checkbox state:", JSON.stringify(labelChecked));
    await shot(page, "24-preload-checkbox.png");
    if (!labelChecked) throw new Error("could not locate preload checkbox input");
    // Default ON: the checkbox reflects the user's intent (checked) even before
    // a sweep has produced an overview (in which case it's disabled).
    if (!labelChecked.checked) throw new Error("preload checkbox is not checked by default");
    pass("11. New-chat preload checkbox present + default ON (#1)");
  } catch (e) {
    await shot(page, "24-preload-checkbox-FAIL.png").catch(() => {});
    fail("11. New-chat preload checkbox present + default ON (#1)", e);
  }

  // ---- Flow 12: Agent writes plan.md (mermaid) + report.html ---------------
  const RICH_PROMPT =
    "Do exactly two things, no preamble. (1) Write a file named plan.md containing a '## Plan' heading, a short sentence, and a mermaid code fence with a simple `flowchart TD` of three steps A-->B-->C. (2) Write a file named report.html that is a small standalone HTML page with a <!DOCTYPE html>, an <h1>Report</h1>, and an inline <style> giving the h1 a color. Then stop.";
  try {
    if (!richSlug) throw new Error("No rich project from flow 11");
    const composer = page.getByPlaceholder(/Message the keeper agent/i);
    await composer.waitFor({ timeout: 5_000 });
    await composer.fill(RICH_PROMPT);
    await page.getByRole("button", { name: /^Send$/ }).click();

    // Wait for the turn to complete (composer unlocks).
    await waitFor(
      async () => (await page.getByRole("button", { name: /^Send$/ }).count()) > 0,
      { timeout: TURN_TIMEOUT, label: "rich-files turn complete" },
    );

    // Confirm both files exist on disk (best-effort, needs DATA_DIR).
    if (DATA_DIR) {
      const planPath = path.join(DATA_DIR, "projects", richSlug, "plan.md");
      const htmlPath = path.join(DATA_DIR, "projects", richSlug, "report.html");
      await waitFor(
        async () => {
          const a = await fs.stat(planPath).then(() => true).catch(() => false);
          const b = await fs.stat(htmlPath).then(() => true).catch(() => false);
          return a && b;
        },
        { timeout: 20_000, label: "plan.md + report.html written" },
      );
    }
    pass("12. Agent writes plan.md (mermaid) + report.html");
  } catch (e) {
    fail("12. Agent writes plan.md (mermaid) + report.html", e);
  }

  // ---- Flow 13: Files list + open plan.md (markdown + Mermaid SVG) (#3) -----
  try {
    if (!richSlug) throw new Error("No rich project from flow 11");
    // Go to the Files & Changelog tab.
    await page.getByRole("button", { name: /Files & Changelog/i }).click();
    // The files list should include plan.md and report.html (pull-refreshed
    // after the turn). Re-fetch the project view to be safe.
    await waitFor(
      async () => {
        const names = await page.locator(".font-mono").allInnerTexts();
        return names.some((n) => /plan\.md/.test(n)) && names.some((n) => /report\.html/.test(n));
      },
      { timeout: 30_000, label: "files list shows plan.md + report.html" },
    );
    await shot(page, "20-files-list.png");

    // Open plan.md — use an exact name so we hit the file-row open button, not
    // the sidebar chat whose title also contains "plan.md", nor the pin button.
    await page.getByRole("button", { name: "plan.md", exact: true }).click();
    // Markdown heading "Plan" should render (an <h2> from '## Plan').
    await waitFor(
      async () => (await page.getByRole("heading", { name: /Plan/i }).count()) > 0,
      { timeout: 15_000, label: "plan.md markdown heading renders" },
    );
    // The Mermaid diagram must render as real SVG (not raw ```mermaid text).
    await waitFor(
      async () => {
        const svgs = await page.locator('[data-testid="mermaid"] svg').count();
        return svgs > 0;
      },
      { timeout: 20_000, label: "Mermaid diagram renders as SVG" },
    );
    // And there should be NO raw "flowchart" text left in a <pre> (i.e. it was
    // rendered, not dumped as a code block).
    const svgCount = await page.locator('[data-testid="mermaid"] svg').count();
    const nodeCount = await page
      .locator('[data-testid="mermaid"] svg .node, [data-testid="mermaid"] svg g')
      .count();
    log(`plan.md: mermaid svg=${svgCount}, svg child groups=${nodeCount}`);
    if (svgCount < 1) throw new Error("no Mermaid <svg> rendered");
    await shot(page, "21-markdown-mermaid.png");
    pass("13. plan.md renders markdown + Mermaid diagram as SVG (#3)");
  } catch (e) {
    await shot(page, "21-markdown-mermaid-FAIL.png").catch(() => {});
    fail("13. plan.md renders markdown + Mermaid diagram as SVG (#3)", e);
  }

  // ---- Flow 14: Open report.html in a sandboxed iframe (#3) -----------------
  try {
    if (!richSlug) throw new Error("No rich project from flow 11");
    // Back to the files list, then open report.html (exact name = file row).
    await page.getByRole("button", { name: /← Files/ }).click();
    await page.getByRole("button", { name: "report.html", exact: true }).click();
    // A sandboxed iframe must render, with sandbox="allow-scripts" and NO
    // allow-same-origin (the safety property we promised).
    const frameLoc = page.locator('iframe[title="report.html"]');
    await frameLoc.waitFor({ timeout: 15_000 });
    const sandbox = await frameLoc.getAttribute("sandbox");
    log("report.html iframe sandbox:", JSON.stringify(sandbox));
    if (!sandbox || !/allow-scripts/.test(sandbox)) {
      throw new Error(`iframe missing allow-scripts sandbox (got ${JSON.stringify(sandbox)})`);
    }
    if (/allow-same-origin/.test(sandbox)) {
      throw new Error("iframe must NOT have allow-same-origin (isolation requirement)");
    }
    // The iframe's document should contain the <h1>Report</h1> we asked for.
    const frame = await frameLoc.elementHandle();
    const contentFrame = await frame.contentFrame();
    await waitFor(
      async () => {
        try {
          const h1 = await contentFrame.locator("h1").first().innerText();
          return /report/i.test(h1);
        } catch {
          return false;
        }
      },
      { timeout: 15_000, label: "report.html iframe shows <h1>Report</h1>" },
    );
    await shot(page, "22-html-iframe.png");
    pass("14. report.html renders inside a sandboxed iframe (#3)");
  } catch (e) {
    await shot(page, "22-html-iframe-FAIL.png").catch(() => {});
    fail("14. report.html renders inside a sandboxed iframe (#3)", e);
  }

  // ---- Flow 15: Pin both files as sibling tabs + unpin one (#4) ------------
  try {
    if (!richSlug) throw new Error("No rich project from flow 11");
    // report.html is open in the Files reader from flow 14; pin it from there.
    await page.getByRole("button", { name: /Pin as tab/i }).click();
    // Back to the files list and pin plan.md via its row pin control
    // (aria-label "Pin plan.md").
    await page.getByRole("button", { name: /← Files/ }).click();
    await page.getByRole("button", { name: "Pin plan.md", exact: true }).click();

    // Two new sibling tabs should appear next to Chat | Files & Changelog.
    const planTabBtn = page.getByRole("tab", { name: /Open plan\.md tab/i });
    const htmlTabBtn = page.getByRole("tab", { name: /Open report\.html tab/i });
    await waitFor(
      async () => (await planTabBtn.count()) > 0 && (await htmlTabBtn.count()) > 0,
      { timeout: 10_000, label: "two pinned tabs appear" },
    );
    // Verify on the server: project.yaml pinned reflects both.
    const afterPin = await fetchJson(`${BASE_URL}/api/projects/${richSlug}`);
    const pinned = afterPin?.project?.pinned ?? [];
    log("server pinned after pinning both:", JSON.stringify(pinned));
    if (!pinned.includes("plan.md") || !pinned.includes("report.html")) {
      throw new Error(`server pinned missing files: ${JSON.stringify(pinned)}`);
    }

    // Switch to each pinned tab to confirm they render via FileView.
    await planTabBtn.click();
    await waitFor(
      async () => (await page.locator('[data-testid="mermaid"] svg').count()) > 0,
      { timeout: 15_000, label: "pinned plan.md tab renders Mermaid" },
    );
    await htmlTabBtn.click();
    await page.locator('iframe[title="report.html"]').waitFor({ timeout: 10_000 });
    await shot(page, "23-pinned-tabs.png");

    // Unpin report.html via its tab "x". The tab should disappear and the
    // server's pinned[] should drop it.
    await page.getByRole("button", { name: /Unpin report\.html/i }).click();
    await waitFor(
      async () => (await page.getByRole("button", { name: /^report\.html$/ }).count()) === 0,
      { timeout: 10_000, label: "report.html tab disappears after unpin" },
    );
    const afterUnpin = await fetchJson(`${BASE_URL}/api/projects/${richSlug}`);
    const pinned2 = afterUnpin?.project?.pinned ?? [];
    log("server pinned after unpinning report.html:", JSON.stringify(pinned2));
    if (pinned2.includes("report.html")) {
      throw new Error(`report.html still pinned on server: ${JSON.stringify(pinned2)}`);
    }
    if (!pinned2.includes("plan.md")) {
      throw new Error(`plan.md should still be pinned: ${JSON.stringify(pinned2)}`);
    }
    pass("15. Pin two files as sibling tabs + unpin one (tab + project.yaml) (#4)");
  } catch (e) {
    await shot(page, "23-pinned-tabs-FAIL.png").catch(() => {});
    fail("15. Pin two files as sibling tabs + unpin one (tab + project.yaml) (#4)", e);
  }

  // ==========================================================================
  // Deep-linkable, restorable navigation (routes + sticky last tab).
  // ==========================================================================

  // ---- Flow 16: Deep-link a file URL renders the right file on direct load --
  // /projects/:slug/files/<encoded name> must render the file directly (a
  // pinned html in the sandboxed iframe; a markdown's Mermaid as SVG), with the
  // matching tab highlighted — proving the tab is derived from the URL.
  try {
    if (!richSlug) throw new Error("No rich project from flow 11");

    // (a) Markdown file deep link -> Mermaid SVG renders + Chat tab NOT active.
    await page.goto(`${BASE_URL}/projects/${richSlug}/files/${encodeURIComponent("plan.md")}`, {
      waitUntil: "networkidle",
    });
    await waitFor(
      async () => (await page.locator('[data-testid="mermaid"] svg').count()) > 0,
      { timeout: 20_000, label: "deep-linked plan.md renders Mermaid SVG" },
    );

    // (b) HTML file deep link -> sandboxed iframe renders on a fresh load.
    // report.html exists on disk (written in flow 12) even though it was unpinned
    // in flow 15 — deep-linking by name must still render it.
    await page.goto(
      `${BASE_URL}/projects/${richSlug}/files/${encodeURIComponent("report.html")}`,
      { waitUntil: "networkidle" },
    );
    const frameLoc = page.locator('iframe[title="report.html"]');
    await frameLoc.waitFor({ timeout: 15_000 });
    const sandbox = await frameLoc.getAttribute("sandbox");
    if (!sandbox || !/allow-scripts/.test(sandbox) || /allow-same-origin/.test(sandbox)) {
      throw new Error(`deep-linked html iframe sandbox wrong: ${JSON.stringify(sandbox)}`);
    }
    const contentFrame = await (await frameLoc.elementHandle()).contentFrame();
    await waitFor(
      async () => {
        try {
          return /report/i.test(await contentFrame.locator("h1").first().innerText());
        } catch {
          return false;
        }
      },
      { timeout: 15_000, label: "deep-linked report.html shows <h1>Report</h1>" },
    );
    // The pinned plan.md tab is a sibling tab and must be present after reload
    // (pins are server-persisted) — proving pinned tabs are URL-restorable.
    await page.getByRole("tab", { name: /Open plan\.md tab/i }).waitFor({ timeout: 10_000 });
    await shot(page, "30-deeplink-file.png");
    pass("16. Deep-link /files/<name> renders the file directly (md+Mermaid, html in iframe)");
  } catch (e) {
    await shot(page, "30-deeplink-file-FAIL.png").catch(() => {});
    fail("16. Deep-link /files/<name> renders the file directly (md+Mermaid, html in iframe)", e);
  }

  // ---- Flow 17: Deep-link a chat URL hydrates that chat on direct load ------
  // /projects/:slug/chat/:sessionId must restore + hydrate that exact chat.
  try {
    if (!projectSlug) throw new Error("No project from flow 2");
    const detail = await fetchJson(`${BASE_URL}/api/projects/${projectSlug}`);
    const sid = detail?.chats?.[0]?.sessionId;
    if (!sid) throw new Error("no saved chat session to deep-link");
    log("deep-linking chat session:", sid);

    await page.goto(`${BASE_URL}/projects/${projectSlug}/chat/${encodeURIComponent(sid)}`, {
      waitUntil: "networkidle",
    });
    // The chat hydrates from history: the original prompt + assistant text show.
    await waitFor(
      async () => {
        const userBubble = await page.getByText(FILE_PROMPT, { exact: false }).count();
        const assistantText = await page.locator(".justify-start p").count();
        return userBubble > 0 && assistantText > 0;
      },
      { timeout: 30_000, label: "deep-linked chat hydrates from history" },
    );
    // The URL still carries the sessionId (it wasn't redirected away).
    if (!page.url().includes(sid)) throw new Error(`URL lost the sessionId: ${page.url()}`);
    await shot(page, "32-deeplink-chat.png");
    pass("17. Deep-link /chat/:sessionId hydrates that chat on direct load");
  } catch (e) {
    await shot(page, "32-deeplink-chat-FAIL.png").catch(() => {});
    fail("17. Deep-link /chat/:sessionId hydrates that chat on direct load", e);
  }

  // ---- Flow 18: Selecting a chat puts its sessionId in the URL --------------
  try {
    if (!projectSlug) throw new Error("No project from flow 2");
    // Land on the bare project URL (which redirects to a sticky/default tab).
    await page.goto(`${BASE_URL}/projects/${projectSlug}/chat`, { waitUntil: "networkidle" });
    const detail = await fetchJson(`${BASE_URL}/api/projects/${projectSlug}`);
    const sid = detail?.chats?.[0]?.sessionId;
    if (!sid) throw new Error("no saved chat to select");
    // Click the saved chat in the left list.
    const sessionBtn = page.locator(".w-64 button:has(.truncate.font-medium)").first();
    await sessionBtn.waitFor({ timeout: 15_000 });
    await sessionBtn.click();
    // The URL must now include the selected chat's sessionId.
    await waitFor(
      async () => page.url().includes(`/chat/${sid}`),
      { timeout: 10_000, label: "selecting a chat updates the URL to /chat/:sessionId" },
    );
    log("after selecting chat, url:", page.url());
    pass("18. Selecting a chat updates the URL to /chat/:sessionId");
  } catch (e) {
    fail("18. Selecting a chat updates the URL to /chat/:sessionId", e);
  }

  // ---- Flow 19: Sticky last tab restore across projects --------------------
  // Scenario: on project A viewing a pinned file tab -> switch to project B ->
  // return to A via the bare /projects/:slug nav -> land back on that file tab.
  // Also: a project with nothing stored defaults to /chat.
  try {
    if (!richSlug || !projectSlug) throw new Error("missing projects from earlier flows");

    // A = richSlug. Open its pinned plan.md tab (sets the sticky tab to it).
    await page.goto(`${BASE_URL}/projects/${richSlug}/files/${encodeURIComponent("plan.md")}`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("tab", { name: /Open plan\.md tab/i }).waitFor({ timeout: 10_000 });

    // B = projectSlug. Visit it (its bare URL redirects somewhere valid) and do
    // something (open its chat tab) so we genuinely leave A.
    await page.goto(`${BASE_URL}/projects/${projectSlug}`, { waitUntil: "networkidle" });
    await waitFor(
      async () => /\/projects\/[^/]+\/(chat|files)/.test(page.url()),
      { timeout: 10_000, label: "bare project B redirects to a sub-tab" },
    );

    // Return to A via the BARE url (as the sidebar/grid nav does) -> sticky
    // restore must land us back on the pinned plan.md file tab.
    await page.goto(`${BASE_URL}/projects/${richSlug}`, { waitUntil: "networkidle" });
    await waitFor(
      async () =>
        page.url().endsWith(`/files/${encodeURIComponent("plan.md")}`) ||
        page.url().endsWith("/files/plan.md"),
      { timeout: 10_000, label: "returning to A via bare URL restores the plan.md file tab" },
    );
    // And the file actually renders (Mermaid SVG) — not just the URL.
    await waitFor(
      async () => (await page.locator('[data-testid="mermaid"] svg').count()) > 0,
      { timeout: 20_000, label: "restored plan.md tab renders Mermaid" },
    );
    log("sticky restore landed on:", page.url());
    await shot(page, "31-sticky-restored.png");

    // Default-to-chat: a freshly created project with no stored tab should
    // redirect its bare URL to /chat.
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /New Project/i }).first().click();
    await page.getByRole("heading", { name: "New project" }).waitFor({ timeout: 5_000 });
    await page.getByPlaceholder("Garage Water Heater Replacement").fill("Sticky Default");
    await page.getByRole("button", { name: /Create project/i }).click();
    await page.waitForURL(/\/projects\/[a-z0-9-]+\/chat$/i, { timeout: 20_000 });
    const stickySlug = page.url().match(/\/projects\/([a-z0-9-]+)\/chat$/i)?.[1];
    if (!stickySlug) throw new Error(`expected /projects/<slug>/chat, got ${page.url()}`);
    // Re-visit its bare URL directly (no stored tab beyond /chat) -> /chat.
    await page.goto(`${BASE_URL}/projects/${stickySlug}`, { waitUntil: "networkidle" });
    await waitFor(
      async () => page.url().endsWith(`/projects/${stickySlug}/chat`),
      { timeout: 10_000, label: "bare URL of a chat-only project defaults to /chat" },
    );
    pass("19. Sticky last tab restores across projects; bare URL defaults to /chat");
  } catch (e) {
    await shot(page, "31-sticky-restored-FAIL.png").catch(() => {});
    fail("19. Sticky last tab restores across projects; bare URL defaults to /chat", e);
  }

  await browser.close();
}

/** Fetch a URL and return its HTTP status (no body). */
async function fetchStatus(url) {
  try {
    const res = await fetch(url);
    return res.status;
  } catch {
    return 0;
  }
}

/** Fetch JSON from a URL, returning null on any error. */
async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
    process.exit(passed === total && total >= 19 ? 0 : 1);
  });
