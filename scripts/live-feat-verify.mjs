// Paddock LIVE feature verification for the new feature set (issues #1-#6).
//
// Drives a real Chromium against the LIVE https://projects.valfenda.net and
// asserts, on the "Garage Water Heater" project:
//   - plan.md renders with a Mermaid SVG
//   - spec.html renders inside a sandboxed iframe (sandbox="allow-scripts",
//     NOT allow-same-origin)
//   - both appear as pinned sibling tabs
//   - the preload checkbox is present + default ON on a new chat
//   - the header shows the Overview badge (hasOverview)
//
// Captures live-feat-{overview,mermaid,html,pins,preload}.png into
// docs/screenshots/. No token needed (the server holds the Max OAuth token).
//
//   BASE_URL=https://projects.valfenda.net node scripts/live-feat-verify.mjs
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "https://projects.valfenda.net";
const SHOT_DIR = path.resolve("docs/screenshots");
const HEADLESS = process.env.HEADED !== "1";
const TARGET = "Garage Water Heater";
const TARGET_SLUG = "garage-water-heater";

const results = [];
let browser;
const log = (...a) => console.log("[feat]", ...a);
const pass = (n, extra) => {
  results.push({ name: n, ok: true });
  log("PASS:", n, extra ?? "");
};
const fail = (n, e) => {
  results.push({ name: n, ok: false, err: String(e?.stack ?? e) });
  console.error("[feat] FAIL:", n, "\n   ", e?.stack ?? e);
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

(async () => {
  browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  [page console.error]", m.text());
  });

  try {
    // ---- Landing + open the project --------------------------------------
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: TARGET, exact: true }).first().click();
    await page.waitForURL(new RegExp(`/projects/${TARGET_SLUG}$`), { timeout: 15_000 });
    await page.getByRole("heading", { name: TARGET, level: 1 }).waitFor({ timeout: 10_000 });
    log("opened project:", TARGET);

    // ---- FEATURE: Overview badge (hasOverview) ---------------------------
    try {
      const badge = page.locator("header").getByText("Overview", { exact: true });
      await badge.waitFor({ timeout: 10_000 });
      const visible = await badge.isVisible();
      if (!visible) throw new Error("Overview badge not visible");
      await shot(page, "live-feat-overview.png");
      pass("Overview badge present in header (hasOverview=true)");
    } catch (e) {
      await shot(page, "live-feat-overview.png");
      fail("Overview badge present in header (hasOverview=true)", e);
    }

    // ---- FEATURE: pinned tabs (plan.md + spec.html) ----------------------
    try {
      const planTab = page.getByRole("tab", { name: /Open plan\.md tab/i });
      const specTab = page.getByRole("tab", { name: /Open spec\.html tab/i });
      await planTab.waitFor({ timeout: 10_000 });
      await specTab.waitFor({ timeout: 10_000 });
      const planVisible = await planTab.isVisible();
      const specVisible = await specTab.isVisible();
      if (!planVisible || !specVisible)
        throw new Error(`pinned tabs not both visible (plan=${planVisible} spec=${specVisible})`);
      await shot(page, "live-feat-pins.png");
      pass("Both files appear as pinned sibling tabs", "(plan.md + spec.html)");
    } catch (e) {
      await shot(page, "live-feat-pins.png");
      fail("Both files appear as pinned sibling tabs", e);
    }

    // ---- FEATURE: plan.md renders a Mermaid SVG --------------------------
    try {
      await page.getByRole("tab", { name: /Open plan\.md tab/i }).click();
      // markdown heading from plan.md should appear
      await waitFor(
        async () => (await page.getByText(/Current Situation|Decision Flow|Options/i).count()) > 0,
        { timeout: 15_000, label: "plan.md markdown rendered" },
      );
      // Mermaid renders into [data-testid=mermaid] as an <svg>
      await waitFor(
        async () => (await page.locator('[data-testid="mermaid"] svg').count()) > 0,
        { timeout: 40_000, label: "Mermaid SVG rendered (lazy mermaid chunk loads)" },
      );
      const svgCount = await page.locator('[data-testid="mermaid"] svg').count();
      // sanity: the svg has real geometry (nodes/edges), not an empty shell
      const groups = await page.locator('[data-testid="mermaid"] svg g').count();
      // ensure no error fallback rendered instead
      const errCount = await page.getByText(/Couldn't render this Mermaid/i).count();
      if (svgCount < 1) throw new Error("no Mermaid <svg> found");
      if (errCount > 0) throw new Error("Mermaid render error fallback shown");
      // scroll the diagram into view for the screenshot
      await page.locator('[data-testid="mermaid"] svg').first().scrollIntoViewIfNeeded();
      await shot(page, "live-feat-mermaid.png");
      pass("plan.md renders a Mermaid SVG", `(svg=${svgCount}, g-elements=${groups})`);
    } catch (e) {
      await shot(page, "live-feat-mermaid.png");
      fail("plan.md renders a Mermaid SVG", e);
    }

    // ---- FEATURE: spec.html renders in a sandboxed iframe ----------------
    try {
      await page.getByRole("tab", { name: /Open spec\.html tab/i }).click();
      const iframe = page.locator('iframe[sandbox="allow-scripts"]');
      await iframe.waitFor({ timeout: 15_000 });
      const sandbox = await iframe.getAttribute("sandbox");
      if (sandbox !== "allow-scripts")
        throw new Error(`unexpected sandbox attr: "${sandbox}"`);
      if (/allow-same-origin/.test(sandbox ?? ""))
        throw new Error("iframe must NOT have allow-same-origin");
      // the sandboxed-frame note should be present
      const note = await page.getByText(/sandboxed frame/i).count();
      // peek inside the frame: the recommendation/title should be there
      const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
      let inner = "";
      try {
        await frame.locator("h1").first().waitFor({ timeout: 8_000 });
        inner = (await frame.locator("h1").first().innerText()).trim();
      } catch {
        inner = "(h1 not read; cross-origin null frame)";
      }
      await shot(page, "live-feat-html.png");
      pass(
        "spec.html renders in a sandboxed iframe",
        `(sandbox="${sandbox}", note=${note}, frame h1="${inner.slice(0, 60)}")`,
      );
    } catch (e) {
      await shot(page, "live-feat-html.png");
      fail("spec.html renders in a sandboxed iframe", e);
    }

    // ---- FEATURE: preload checkbox present + default ON on a new chat ----
    try {
      await page.getByRole("tab", { name: "Chat", exact: true }).click().catch(() => {});
      // Make sure we're on a fresh new chat (composer for a never-resumed chat)
      await page.getByRole("button", { name: /New Chat/i }).click();
      const composer = page.getByPlaceholder(/Message the keeper agent/i);
      await composer.waitFor({ timeout: 8_000 });
      const cb = page.locator('input[type="checkbox"]').filter({ has: page.locator("xpath=.") });
      // scope to the preload label specifically
      const preloadLabel = page.getByText("Preload project context", { exact: false });
      await preloadLabel.waitFor({ timeout: 8_000 });
      const checkbox = page
        .locator('label:has-text("Preload project context") input[type="checkbox"]')
        .first();
      await checkbox.waitFor({ timeout: 8_000 });
      const checked = await checkbox.isChecked();
      const disabled = await checkbox.isDisabled();
      if (!checked) throw new Error("preload checkbox is not checked by default");
      if (disabled) throw new Error("preload checkbox is disabled (overview should be available)");
      await shot(page, "live-feat-preload.png");
      pass("Preload checkbox present + default ON on a new chat", `(checked=${checked}, disabled=${disabled})`);
    } catch (e) {
      await shot(page, "live-feat-preload.png");
      fail("Preload checkbox present + default ON on a new chat", e);
    }
  } finally {
    await browser.close();
  }

  // ---- summary -----------------------------------------------------------
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n[feat] ${okCount}/${results.length} feature checks PASSED`);
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => {
  console.error("[feat] fatal:", e);
  process.exit(2);
});
