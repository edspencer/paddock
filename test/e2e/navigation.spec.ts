import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

/**
 * Cross-cutting browser journeys: the /tags/:tag deep link + clearable filter
 * chip, sticky last-tab restoration, dark-mode rendering, and the live WS
 * connection indicator.
 */

test("/tags/:tag deep link filters, and the chip clears back to the full grid", async ({ page }) => {
  await createProject(page, "E2E Deep Tagged", { area: "Homelab", tags: "deeptag" });

  // Direct-load the tag deep link (not via a click) — it must filter on load.
  await page.goto("/tags/deeptag");
  await expect(page.getByRole("heading", { name: /Projects tagged/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /E2E Deep Tagged/ }).first()).toBeVisible();

  // The clearable filter chip is present; clicking "×" returns to "/".
  const clear = page.getByRole("button", { name: /Clear deeptag filter/i });
  await expect(clear).toBeVisible();
  await clear.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /Projects tagged/i })).toHaveCount(0);
});

test("clicking a tag pill on a project card filters by that tag (issue #22 fix)", async ({ page }) => {
  await createProject(page, "E2E Pill Click", { area: "Homelab", tags: "pillclick" });
  await page.goto("/");

  // The tag pill is a <button> (not a nested <a>) on the project card. Click it
  // → navigates to the tag filter view WITHOUT also opening the project.
  const card = page.locator("section a.card").filter({ hasText: "E2E Pill Click" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "pillclick" }).click();
  await expect(page).toHaveURL(/\/tags\/pillclick$/);
  await expect(page.getByRole("heading", { name: /Projects tagged/i })).toBeVisible();
});

test("/tags/:tag with no matching project shows the empty state + clear", async ({ page }) => {
  await page.goto("/tags/nonexistent-tag-xyz");
  await expect(page.getByRole("heading", { name: /No projects tagged/i })).toBeVisible();
  await page.getByRole("button", { name: /Clear filter/i }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("sticky last-tab: returning to a project restores the Files tab", async ({ page }) => {
  const slug = await createProject(page, "E2E Sticky Tab", { area: "House" });
  // Visit the Files tab so it's remembered.
  await page.goto(`/projects/${slug}/files`);
  await expect(page.getByRole("heading", { name: /^Files$/ })).toBeVisible();

  // Navigate away, then back to the bare project URL → it restores /files.
  await page.goto("/");
  await page.goto(`/projects/${slug}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files$`), { timeout: 10_000 });
});

test("the app renders in dark mode (html.dark drives dark styling)", async ({ page }) => {
  await page.goto("/");
  // Paddock ships dark-only (index.html hard-codes class="dark"); assert the
  // dark theme is actually applied so the dark Tailwind variants take effect.
  const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  expect(isDark).toBe(true);
  // The canvas background resolves to the dark token (not white).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)");
});

test("the chat connection indicator reports 'connected' over the live socket", async ({ page }) => {
  await createProject(page, "E2E Connection", { area: "Homelab" });
  // The composer footer shows a connection dot; once the WS is open it reads
  // "connected".
  await expect(page.getByText("connected")).toBeVisible({ timeout: 15_000 });
});

test("WS recovers after the socket is force-closed (reconnect)", async ({ page }) => {
  // Track every WebSocket the app opens BEFORE the SPA loads, so we can reach in
  // and force-close the client's shared socket mid-session to drive a reconnect.
  await page.addInitScript(() => {
    const w = window as unknown as { __sockets: WebSocket[] };
    w.__sockets = [];
    const Native = window.WebSocket;
    class Tracked extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        w.__sockets.push(this);
      }
    }
    window.WebSocket = Tracked as unknown as typeof WebSocket;
  });

  await createProject(page, "E2E Reconnect", { area: "Homelab" });
  await expect(page.getByText("connected")).toBeVisible({ timeout: 15_000 });

  // Force-close the live socket(s). The client's onclose → scheduleReconnect
  // backoff re-establishes a new socket and the indicator returns to connected.
  await page.evaluate(() => {
    const w = window as unknown as { __sockets: WebSocket[] };
    for (const s of w.__sockets) {
      if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close();
    }
  });

  // The dot reflects the drop (connecting/offline) then recovers to connected.
  await expect(page.getByText(/connecting|offline/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("connected")).toBeVisible({ timeout: 30_000 });
});
