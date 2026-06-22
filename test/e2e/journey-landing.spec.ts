import { test, expect } from "@playwright/test";
import { seedProject } from "./helpers";

/**
 * Journey: Landing page + navigation.
 *
 * The landing page groups projects into collapsible area sections (Homelab /
 * House / Side Projects / Unsorted, in that order) with per-section counts, and
 * the sidebar mirrors the same grouping. Collapse state persists in
 * localStorage across reloads. The Inbox section appears once a one-off chat
 * exists.
 *
 * Projects are seeded on disk (a project is just a dir + project.yaml), which is
 * faithful for the read-only grid/nav surface and keeps these tests fast and
 * deterministic. A unique tag/area marker per test keeps assertions scoped even
 * though the server's data dir is shared across the file.
 */

test.describe("landing: area sections + counts", () => {
  test("renders Homelab / House / Side Projects / Unsorted sections in order with counts", async ({
    page,
  }) => {
    // Seed two projects in distinct canonical areas + one Unsorted.
    seedProject({ name: "LN Homelab A", group: "homelab" });
    seedProject({ name: "LN Homelab B", group: "homelab" });
    seedProject({ name: "LN House A", group: "house" });
    seedProject({ name: "LN Side A", group: "side-projects" });
    seedProject({ name: "LN Unsorted A" }); // no group -> Unsorted

    await page.goto("/");

    // Each section header is a button whose accessible name starts with the area
    // label. They must appear in canonical order, Unsorted last.
    const homelab = page.getByRole("button", { name: /^Homelab/ });
    const house = page.getByRole("button", { name: /^House/ });
    const side = page.getByRole("button", { name: /^Side Projects/ });
    const unsorted = page.getByRole("button", { name: /^Unsorted/ });
    await expect(homelab).toBeVisible();
    await expect(house).toBeVisible();
    await expect(side).toBeVisible();
    await expect(unsorted).toBeVisible();

    // Order in the DOM: homelab before house before side before unsorted.
    const headers = await page.getByRole("button").filter({ hasText: /^(Homelab|House|Side Projects|Unsorted)/ }).all();
    const labels = await Promise.all(headers.map((h) => h.textContent()));
    const idx = (re: RegExp) => labels.findIndex((l) => l && re.test(l.trim()));
    expect(idx(/^Homelab/)).toBeLessThan(idx(/^House/));
    expect(idx(/^House/)).toBeLessThan(idx(/^Side Projects/));
    expect(idx(/^Side Projects/)).toBeLessThan(idx(/^Unsorted/));

    // The Homelab count badge reflects (at least) the two we seeded. The count
    // is the small pill inside the header button.
    const homelabCount = await homelab.locator("span").filter({ hasText: /^\d+$/ }).first().textContent();
    expect(Number(homelabCount)).toBeGreaterThanOrEqual(2);

    // The seeded cards live in the landing grid (section a.card).
    await expect(page.locator("section a.card").filter({ hasText: "LN Homelab A" })).toBeVisible();
    await expect(page.locator("section a.card").filter({ hasText: "LN Side A" })).toBeVisible();
  });

  test("collapse state persists across reload (per section, localStorage)", async ({ page }) => {
    seedProject({ name: "LN Persist House", group: "house" });
    await page.goto("/");

    const house = page.getByRole("button", { name: /^House/ });
    await expect(house).toBeVisible();
    // Ensure it starts expanded.
    if ((await house.getAttribute("aria-expanded")) === "false") await house.click();
    await expect(house).toHaveAttribute("aria-expanded", "true");
    const card = page.locator("section a.card").filter({ hasText: "LN Persist House" });
    await expect(card).toBeVisible();

    // Collapse, then reload — the section must come back collapsed.
    await house.click();
    await expect(house).toHaveAttribute("aria-expanded", "false");

    await page.reload();
    const houseAfter = page.getByRole("button", { name: /^House/ });
    await expect(houseAfter).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.locator("section a.card").filter({ hasText: "LN Persist House" }),
    ).toBeHidden();

    // Re-expand so we leave localStorage clean for sibling tests in this file.
    await houseAfter.click();
    await expect(houseAfter).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("landing: sidebar grouping + Inbox", () => {
  test("sidebar groups projects by area with subheaders", async ({ page }) => {
    seedProject({ name: "LN Sidebar Homelab", group: "homelab" });
    seedProject({ name: "LN Sidebar House", group: "house" });
    await page.goto("/");

    const sidebar = page.locator("aside");
    // Sidebar shows the project names as nav links.
    await expect(sidebar.getByRole("link", { name: /LN Sidebar Homelab/ })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: /LN Sidebar House/ })).toBeVisible();
    // With >1 area in play, the sidebar shows the area subheaders (uppercase).
    await expect(sidebar.getByText("Homelab", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("House", { exact: true })).toBeVisible();
  });

  test("Inbox section appears once a one-off chat exists", async ({ page }) => {
    // Before any one-off chat in a FRESH area marker: create a one-off chat and
    // confirm the Inbox section then surfaces on the landing page. (The data dir
    // is shared, so a prior test may already have created scratch chats — we
    // simply assert the Inbox is present AFTER creating one, which is robust.)
    await page.goto("/chat");
    const composer = page.getByPlaceholder(/Ask anything/i);
    await composer.fill("inbox seed message");
    await page.getByRole("button", { name: /^Send$/ }).click();
    await expect(page.getByText(/Acknowledged: inbox seed message/).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.goto("/");
    // The Inbox is a collapsible section header like the areas.
    const inbox = page.getByRole("button", { name: /^Inbox/ });
    await expect(inbox).toBeVisible();
    // And the one-off chat is reachable from it (InboxChatCard links to /chat/:id).
    if ((await inbox.getAttribute("aria-expanded")) === "false") await inbox.click();
    await expect(
      page.locator("section a.card").filter({ hasText: /inbox seed message/ }).first(),
    ).toBeVisible();
  });
});
