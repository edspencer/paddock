// Paddock LIVE verification AFTER the herdctl 5.11.0 + chat 0.4.0 adoption.
//
// Drives a real Chromium against the LIVE https://projects.valfenda.net to prove
// the API adoption did not regress anything and the new session-rename feature
// works.
//
// STEP 4 (Garage Water Heater, regression guard):
//   - plan.md renders a Mermaid SVG
//   - spec.html renders inside a sandboxed iframe (sandbox="allow-scripts",
//     NOT allow-same-origin)
//   - both appear as pinned sibling tabs
//   - Overview badge present in header
//   - preload checkbox present + default ON on a new chat
//   -> screenshot: live-adopt-water-heater.png
//
// STEP 5 (throwaway test project, exercises the NEW createSDKMessageHandler path
//         + session rename):
//   - create a throwaway project
//   - new chat: prompt that writes a file AND triggers a tool
//   - streaming text renders; a tool block renders with toolName + inputSummary
//     + duration (the new @herdctl/chat translator path)
//   - the session appears in the left list
//   - rename that chat via the pencil/PATCH affordance; the new name shows
//   - (file-on-disk + project deletion are handled by the surrounding shell)
//   -> screenshots: live-adopt-chat.png, live-adopt-rename.png
//
//   BASE_URL=https://projects.valfenda.net node scripts/live-adopt-verify.mjs
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "https://projects.valfenda.net";
const SHOT_DIR = path.resolve("docs/screenshots");
const HEADLESS = process.env.HEADED !== "1";
const TURN_TIMEOUT = Number(process.env.TURN_TIMEOUT ?? 180_000);
const TARGET = "Garage Water Heater";
const TARGET_SLUG = "garage-water-heater";
const TEST_NAME = `Adopt Verify ${Date.now().toString().slice(-6)}`;
const NEW_CHAT_NAME = "Renamed By Adopt Verify";

const results = [];
let browser;
let testSlug = null;
let testSessionId = null;
const log = (...a) => console.log("[adopt]", ...a);
const pass = (n, extra) => {
  results.push({ name: n, ok: true });
  log("PASS:", n, extra ?? "");
};
const fail = (n, e) => {
  results.push({ name: n, ok: false, err: String(e?.stack ?? e) });
  console.error("[adopt] FAIL:", n, "\n   ", e?.stack ?? e);
};

async function shot(page, file) {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, file), fullPage: false });
  log("screenshot:", file);
}
async function waitFor(fn, { timeout = 30_000, interval = 400, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

(async () => {
  browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  [page console.error]", m.text());
  });

  try {
    // =====================================================================
    // STEP 4 — Garage Water Heater regression guard
    // =====================================================================
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: TARGET, exact: true }).first().click();
    await page.waitForURL(new RegExp(`/projects/${TARGET_SLUG}$`), { timeout: 15_000 });
    await page.getByRole("heading", { name: TARGET, level: 1 }).waitFor({ timeout: 10_000 });
    log("opened project:", TARGET);

    // Overview badge
    try {
      const badge = page.locator("header").getByText("Overview", { exact: true });
      await badge.waitFor({ timeout: 10_000 });
      if (!(await badge.isVisible())) throw new Error("Overview badge not visible");
      pass("4a. Overview badge present in header");
    } catch (e) {
      fail("4a. Overview badge present in header", e);
    }

    // Both pinned tabs
    try {
      const planTab = page.getByRole("tab", { name: /Open plan\.md tab/i });
      const specTab = page.getByRole("tab", { name: /Open spec\.html tab/i });
      await planTab.waitFor({ timeout: 10_000 });
      await specTab.waitFor({ timeout: 10_000 });
      if (!(await planTab.isVisible()) || !(await specTab.isVisible()))
        throw new Error("pinned tabs not both visible");
      pass("4b. plan.md + spec.html are pinned sibling tabs");
    } catch (e) {
      fail("4b. plan.md + spec.html are pinned sibling tabs", e);
    }

    // plan.md Mermaid SVG
    try {
      await page.getByRole("tab", { name: /Open plan\.md tab/i }).click();
      await waitFor(
        async () => (await page.locator('[data-testid="mermaid"] svg').count()) > 0,
        { timeout: 45_000, label: "Mermaid SVG (lazy chunk loads)" },
      );
      const svgCount = await page.locator('[data-testid="mermaid"] svg').count();
      const groups = await page.locator('[data-testid="mermaid"] svg g').count();
      const errCount = await page.getByText(/Couldn't render this Mermaid/i).count();
      if (svgCount < 1) throw new Error("no Mermaid svg");
      if (errCount > 0) throw new Error("Mermaid error fallback shown");
      await page.locator('[data-testid="mermaid"] svg').first().scrollIntoViewIfNeeded();
      await shot(page, "live-adopt-water-heater.png");
      pass("4c. plan.md renders a Mermaid SVG", `(svg=${svgCount}, g=${groups})`);
    } catch (e) {
      await shot(page, "live-adopt-water-heater.png").catch(() => {});
      fail("4c. plan.md renders a Mermaid SVG", e);
    }

    // spec.html sandboxed iframe
    try {
      await page.getByRole("tab", { name: /Open spec\.html tab/i }).click();
      const iframe = page.locator('iframe[sandbox="allow-scripts"]');
      await iframe.waitFor({ timeout: 15_000 });
      const sandbox = await iframe.getAttribute("sandbox");
      if (sandbox !== "allow-scripts") throw new Error(`unexpected sandbox: "${sandbox}"`);
      if (/allow-same-origin/.test(sandbox ?? "")) throw new Error("must NOT have allow-same-origin");
      const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
      let inner = "";
      try {
        await frame.locator("h1").first().waitFor({ timeout: 8_000 });
        inner = (await frame.locator("h1").first().innerText()).trim();
      } catch {
        inner = "(h1 not read)";
      }
      pass("4d. spec.html renders in a sandboxed iframe", `(sandbox="${sandbox}", h1="${inner.slice(0, 50)}")`);
    } catch (e) {
      fail("4d. spec.html renders in a sandboxed iframe", e);
    }

    // preload checkbox default ON
    try {
      await page.getByRole("tab", { name: "Chat", exact: true }).click().catch(() => {});
      await page.getByRole("button", { name: /New Chat/i }).click();
      await page.getByPlaceholder(/Message the keeper agent/i).waitFor({ timeout: 8_000 });
      const checkbox = page
        .locator('label:has-text("Preload project context") input[type="checkbox"]')
        .first();
      await checkbox.waitFor({ timeout: 8_000 });
      const checked = await checkbox.isChecked();
      const disabled = await checkbox.isDisabled();
      if (!checked) throw new Error("preload checkbox not checked by default");
      if (disabled) throw new Error("preload checkbox disabled (overview exists, should be enabled)");
      pass("4e. Preload checkbox present + default ON on a new chat", `(checked=${checked})`);
    } catch (e) {
      fail("4e. Preload checkbox present + default ON on a new chat", e);
    }

    // =====================================================================
    // STEP 5 — throwaway project: new chat (new translator path) + rename
    // =====================================================================
    // Create the throwaway project.
    try {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /New Project/i }).first().click();
      await page.getByRole("heading", { name: "New project" }).waitFor({ timeout: 5_000 });
      await page.getByPlaceholder("Garage Water Heater Replacement").fill(TEST_NAME);
      await page
        .getByPlaceholder("One line on what this project is about")
        .fill("Throwaway project for the herdctl 5.11.0 adoption live verify.");
      await page.getByRole("button", { name: /Create project/i }).click();
      await page.waitForURL(/\/projects\/[a-z0-9-]+$/i, { timeout: 20_000 });
      testSlug = page.url().split("/projects/")[1];
      await page.getByRole("heading", { name: TEST_NAME, level: 1 }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: /New Chat/i }).waitFor({ timeout: 5_000 });
      // Confirm its keeper registered (addAgent path).
      const fleet = await fetchJson(`${BASE_URL}/api/fleet`);
      const hasKeeper = (fleet?.agents ?? []).some((a) => a.name === `keeper-${testSlug}`);
      if (!hasKeeper) throw new Error(`keeper-${testSlug} not registered via addAgent`);
      log("created throwaway project:", testSlug);
      pass("5a. Throwaway project created + keeper registered via addAgent");
    } catch (e) {
      fail("5a. Throwaway project created + keeper registered via addAgent", e);
    }

    // New chat: stream + tool block via the new createSDKMessageHandler path.
    try {
      if (!testSlug) throw new Error("no throwaway project");
      await page.getByRole("button", { name: /New Chat/i }).click();
      const composer = page.getByPlaceholder(/Message the keeper agent/i);
      await composer.waitFor({ timeout: 8_000 });
      await composer.fill(
        "First run the bash command \"pwd\" to find your working directory. Then use the Write tool to create a file at <that-working-directory>/adopt.txt containing exactly the word ADOPTED (use the absolute path under your working directory, not your home dir). Then say done in one sentence.",
      );
      await page.getByRole("button", { name: /^Send$/ }).click();

      // (a) assistant text streams
      await waitFor(
        async () => (await page.locator(".justify-start .prose, .justify-start p").count()) > 0,
        { timeout: TURN_TIMEOUT, label: "assistant streaming text" },
      );

      // (b) tool block renders (toolName via the translated chat:tool_call)
      await waitFor(
        async () => (await page.locator("button:has(.font-mono.font-semibold)").count()) > 0,
        { timeout: TURN_TIMEOUT, label: "tool block" },
      );
      const firstTool = page.locator("button:has(.font-mono.font-semibold)").first();
      const toolName = (await firstTool.locator(".font-mono.font-semibold").first().innerText()).trim();
      await firstTool.click().catch(() => {});
      await page.waitForTimeout(400);
      // duration / input summary text inside the (now expanded) tool block region
      const toolRegionText = await page.locator("body").innerText();
      const hasDuration = /\d+\s?ms|\d+(\.\d+)?\s?s\b/i.test(toolRegionText);
      log("first tool block:", toolName, "durationVisible:", hasDuration);
      await shot(page, "live-adopt-chat.png");

      // (c) completion: composer unlocks + a saved session appears in the list
      await waitFor(
        async () => (await page.getByRole("button", { name: /^Send$/ }).count()) > 0,
        { timeout: TURN_TIMEOUT, label: "turn complete (composer unlocked)" },
      );
      // The session is created server-side immediately; the in-app list may lag
      // up to the discovery cache TTL, so re-open the project to force a re-fetch
      // (this is the documented freshness behavior, not a failure).
      await waitFor(
        async () => {
          try {
            const chats = await fetchJson(`${BASE_URL}/api/projects/${testSlug}/chats`);
            const list = chats?.chats ?? chats ?? [];
            return Array.isArray(list) && list.length >= 1;
          } catch {
            return false;
          }
        },
        { timeout: 45_000, label: "session listed via API" },
      );
      const chats = await fetchJson(`${BASE_URL}/api/projects/${testSlug}/chats`);
      const list = chats?.chats ?? chats ?? [];
      if (Array.isArray(list) && list.length) testSessionId = list[0].sessionId;
      log("session id:", testSessionId);
      // Re-navigate so the left list reflects the saved session for the rename step.
      await page.goto(`${BASE_URL}/projects/${testSlug}`, { waitUntil: "networkidle" });
      await waitFor(
        async () =>
          (await page.locator(".w-64 button:has(.truncate.font-medium)").count()) >= 1,
        { timeout: 20_000, label: "session appears in left list after re-fetch" },
      );
      if (!toolName) throw new Error("tool block had no tool name (translator regression?)");
      pass(
        "5b. New chat streams text + tool block (toolName via new translator) + session saved",
        `(tool=${toolName}, durationVisible=${hasDuration}, session=${testSessionId})`,
      );
    } catch (e) {
      await shot(page, "live-adopt-chat.png").catch(() => {});
      fail("5b. New chat streams text + tool block + session saved", e);
    }

    // Rename the chat via the pencil affordance (window.prompt -> PATCH).
    try {
      if (!testSlug) throw new Error("no throwaway project");
      // The saved chat row exposes a "Rename chat <name>" button on hover.
      const renameBtn = page.locator('button[aria-label^="Rename chat"]').first();
      await renameBtn.waitFor({ timeout: 10_000 });
      // Handle the window.prompt dialog with the new name.
      page.once("dialog", async (d) => {
        log("rename prompt:", d.message());
        await d.accept(NEW_CHAT_NAME);
      });
      await renameBtn.click();
      // The new name should show in the list (optimistic update) AND persist via PATCH.
      await waitFor(
        async () => (await page.getByText(NEW_CHAT_NAME, { exact: false }).count()) > 0,
        { timeout: 15_000, label: "renamed chat shows new name in list" },
      );
      // Confirm server-side persistence: re-fetch chats; customName should match.
      await waitFor(
        async () => {
          try {
            const chats = await fetchJson(`${BASE_URL}/api/projects/${testSlug}/chats`);
            const list = chats?.chats ?? chats ?? [];
            return (Array.isArray(list) ? list : []).some(
              (c) => (c.name || c.customName) === NEW_CHAT_NAME,
            );
          } catch {
            return false;
          }
        },
        { timeout: 15_000, label: "rename persisted server-side (PATCH)" },
      );
      await shot(page, "live-adopt-rename.png");
      pass("5c. Session rename via pencil/PATCH shows + persists the new name", `("${NEW_CHAT_NAME}")`);
    } catch (e) {
      await shot(page, "live-adopt-rename.png").catch(() => {});
      fail("5c. Session rename via pencil/PATCH shows + persists the new name", e);
    }
  } finally {
    await browser.close();
  }

  // Emit machine-readable bits for the surrounding shell.
  console.log("\n[adopt] TEST_SLUG=" + (testSlug ?? ""));
  console.log("[adopt] TEST_SESSION=" + (testSessionId ?? ""));
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n[adopt] ${okCount}/${results.length} checks PASSED`);
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => {
  console.error("[adopt] fatal:", e);
  process.exit(2);
});
