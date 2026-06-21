// Paddock LIVE final verification (post-redeploy).
//
// Drives a real Chromium against the LIVE https://projects.valfenda.net:
//   1. Landing renders + the real seeded projects show.
//   2. Open "Garage Water Heater".
//   3. New Chat -> send a planning question -> assert a streamed reply renders.
// Captures live-final-{landing,project,chat}.png into docs/screenshots/.
//
// Reuses the selectors proven in scripts/e2e.mjs. Self-contained: no token
// needed here (the server has the Max OAuth token).
//
// Run:  BASE_URL=https://projects.valfenda.net node scripts/live-final-verify.mjs
//
// Prints (on stdout) the sessionId of the chat it created so the caller can
// delete it via the API afterwards (keeps the landing clean / chats empty).
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "https://projects.valfenda.net";
const SHOT_DIR = path.resolve("docs/screenshots");
const HEADLESS = process.env.HEADED !== "1";
const TURN_TIMEOUT = 180_000;

const EXPECTED = [
  "Garage Water Heater",
  "Multi-Zone AC",
  "Garden Irrigation",
  "UK TV / Media",
];
const TARGET = "Garage Water Heater";
const TARGET_SLUG = "garage-water-heater";
const PROMPT =
  "In one sentence, what would you want to know to help plan replacing a garage water heater?";

const results = [];
let browser;
function log(...a) { console.log("[live]", ...a); }
function pass(n) { results.push({ name: n, ok: true }); log("PASS:", n); }
function fail(n, e) { results.push({ name: n, ok: false, err: String(e?.stack ?? e) }); console.error("[live] FAIL:", n, "\n   ", e?.stack ?? e); }

async function shot(page, file) {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, file), fullPage: false });
  log("screenshot:", file);
}
async function waitFor(fn, { timeout = 30_000, interval = 500, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
async function fetchJson(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

async function run() {
  browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[browser pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("[browser console.error]", m.text()); });
  const requestedUrls = [];
  page.on("request", (r) => requestedUrls.push(r.url()));

  // ---- 1: Landing shows the seeded projects --------------------------------
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor({ timeout: 15_000 });
    for (const name of EXPECTED) {
      const n = await page.getByRole("heading", { name, exact: true }).count();
      if (n < 1) throw new Error(`seeded project not on landing: "${name}"`);
    }
    // No test junk.
    const junk = await page.getByText(/Deploy Smoke|Live Verify|Demo Project|Delete Me/i).count();
    if (junk > 0) throw new Error("test-junk project still visible on landing");
    log(`landing shows all ${EXPECTED.length} seeded projects, no junk`);
    await shot(page, "live-final-landing.png");
    pass("1. Landing shows the 4 seeded real projects (no junk)");
  } catch (e) {
    await shot(page, "live-final-landing-FAIL.png").catch(() => {});
    fail("1. Landing shows the 4 seeded real projects (no junk)", e);
  }

  // ---- 2: Open Garage Water Heater -----------------------------------------
  try {
    await page.getByRole("heading", { name: TARGET, exact: true }).first().click();
    await page.waitForURL(new RegExp(`/projects/${TARGET_SLUG}$`), { timeout: 15_000 });
    await page.getByRole("heading", { name: TARGET, level: 1 }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: /New Chat/i }).waitFor({ timeout: 5_000 });
    log("opened project:", TARGET_SLUG);
    await shot(page, "live-final-project.png");
    pass("2. Open 'Garage Water Heater' project view");
  } catch (e) {
    await shot(page, "live-final-project-FAIL.png").catch(() => {});
    fail("2. Open 'Garage Water Heater' project view", e);
  }

  // ---- 3: New Chat -> send -> streamed reply renders -----------------------
  let sessionId = null;
  try {
    await page.getByRole("button", { name: /New Chat/i }).click();
    const composer = page.getByPlaceholder(/Message the keeper agent/i);
    await composer.waitFor({ timeout: 5_000 });
    await composer.fill(PROMPT);
    await page.getByRole("button", { name: /^Send$/ }).click();

    // Streamed assistant text renders (markdown <p> in a left-aligned bubble).
    await waitFor(
      async () => (await page.locator(".justify-start .prose, .justify-start p").count()) > 0,
      { timeout: TURN_TIMEOUT, label: "assistant streaming reply" },
    );
    // Turn completes (composer unlocks) and a session lands in the left list.
    await waitFor(
      async () => (await page.getByRole("button", { name: /^Send$/ }).count()) > 0,
      { timeout: TURN_TIMEOUT, label: "turn complete (composer unlocked)" },
    );
    await waitFor(
      async () => (await page.locator(".w-64 button:has(.truncate.font-medium)").count()) >= 1,
      { timeout: 30_000, label: "session appears in left list" },
    );
    // Capture the rendered reply text for the report.
    const replyText = (await page.locator(".justify-start").last().innerText()).trim();
    log("rendered reply (first 200 chars):", JSON.stringify(replyText.slice(0, 200)));
    await page.waitForTimeout(400);
    await shot(page, "live-final-chat.png");

    // Resolve the created sessionId via the API so the caller can clean it up.
    const chats = await fetchJson(`${BASE_URL}/api/projects/${TARGET_SLUG}/chats`);
    const ids = (chats?.chats ?? []).map((c) => c.sessionId).filter(Boolean);
    if (ids.length >= 1) sessionId = ids[0];
    log("project now has chats:", JSON.stringify(ids));
    pass("3. New Chat streams a reply, session saved");
  } catch (e) {
    await shot(page, "live-final-chat-FAIL.png").catch(() => {});
    fail("3. New Chat streams a reply, session saved", e);
  }

  // Assert no Google Fonts requests over the whole live session.
  try {
    const g = requestedUrls.filter((u) => /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u));
    if (g.length > 0) throw new Error(`google font requests: ${g.slice(0, 3).join(", ")}`);
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    if (!/Inter/i.test(bodyFont)) throw new Error(`body font-family "${bodyFont}" != Inter`);
    log(`fonts self-hosted live: 0 google requests; body uses ${bodyFont}`);
    pass("4. Live fonts self-hosted (no Google Fonts request; Inter applied)");
  } catch (e) {
    fail("4. Live fonts self-hosted (no Google Fonts request; Inter applied)", e);
  }

  await browser.close();
  if (sessionId) console.log(`CREATED_SESSION_ID=${sessionId}`);
}

run()
  .catch(async (e) => { console.error("[live] fatal:", e); if (browser) await browser.close().catch(() => {}); })
  .finally(() => {
    const passed = results.filter((r) => r.ok).length;
    const total = results.length;
    console.log("\n============ LIVE VERIFY SUMMARY ============");
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    console.log(`--------------------------------------------\n${passed}/${total} checks passed`);
    process.exit(passed === total && total >= 4 ? 0 : 1);
  });
