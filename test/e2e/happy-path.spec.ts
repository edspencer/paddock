import { test, expect } from "@playwright/test";

/**
 * E2E happy paths — Chromium drives the REAL built SPA + REAL server with the
 * fake `claude` (no Anthropic calls). Each test is independent but the server +
 * its data dir are shared across the file (workers: 1), so projects created in
 * one test may be visible in later ones — assertions scope to their own names.
 *
 * The fake's default reply echoes the prompt ("Acknowledged: <prompt>"), so we
 * assert that text streams into the transcript.
 */

// Create a project via the New Project modal, picking an area. Returns its slug.
async function createProject(page: import("@playwright/test").Page, name: string, area?: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /New Project/i }).first().click();
  const dialog = page.locator("form").filter({ hasText: "New project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill(name);
  if (area) {
    // The Area <select> is the one currently showing "Unsorted".
    await dialog.getByRole("combobox").first().selectOption({ label: area });
  }
  await dialog.getByRole("button", { name: /Create project/i }).click();
  // Lands on the project chat view.
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+/);
}

test("create a project (pick an area) and land in it", async ({ page }) => {
  await createProject(page, "E2E Reactor", "Homelab");
  // The project's chat composer is present.
  await expect(page.getByPlaceholder(/Message the keeper agent/i)).toBeVisible();
});

test("send a chat, watch it stream, reload and see history", async ({ page }) => {
  await createProject(page, "E2E Streamer");
  const composer = page.getByPlaceholder(/Message the keeper agent/i);
  await composer.fill("ping from e2e");
  await page.getByRole("button", { name: /^Send$/ }).click();

  // The user bubble appears, then the streamed assistant reply. The same text
  // can occur in more than one node, so assert on the first match.
  await expect(page.getByText("ping from e2e").first()).toBeVisible();
  await expect(page.getByText(/Acknowledged: ping from e2e/).first()).toBeVisible({
    timeout: 30_000,
  });

  // The URL now carries the established session id.
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  // Reload → history hydrates from the transcript.
  await page.reload();
  await expect(page.getByText("ping from e2e").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Acknowledged: ping from e2e/).first()).toBeVisible({
    timeout: 15_000,
  });
});

test("collapse an area section on the landing page", async ({ page }) => {
  await createProject(page, "E2E Collapsible", "House");
  await page.goto("/");

  // The House section header (a button with the area label). Ensure it starts
  // expanded (collapse state persists in localStorage across runs).
  const header = page.getByRole("button", { name: /^House/ });
  await expect(header).toBeVisible();
  if ((await header.getAttribute("aria-expanded")) === "false") {
    await header.click();
  }
  await expect(header).toHaveAttribute("aria-expanded", "true");

  // The project CARD lives in the landing grid's <section> (a `.card` link) — as
  // opposed to the always-visible AppShell sidebar link to the same project.
  const card = page.locator("section a.card").filter({ hasText: "E2E Collapsible" });
  await expect(card).toBeVisible();

  // Collapse the section → the card hides (the sidebar link is unaffected).
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(card).toBeHidden();
});

test("filter projects by a domain tag", async ({ page }) => {
  // Create a project carrying a unique tag via the API for determinism, then
  // verify the tag filter view shows it. (We use the UI tag click to navigate.)
  await page.goto("/");
  // Create a project with a domain tag through the modal.
  await page.getByRole("button", { name: /New Project/i }).first().click();
  const dialog = page.locator("form").filter({ hasText: "New project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill("E2E Tagged");
  await dialog.getByPlaceholder(/home, plumbing/i).fill("e2etag");
  await dialog.getByRole("button", { name: /Create project/i }).click();
  await expect(page).toHaveURL(/\/projects\//);

  // Navigate straight to the tag filter route and confirm the project lists.
  await page.goto("/tags/e2etag");
  await expect(page.getByRole("heading", { name: /Projects tagged/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /E2E Tagged/ }).first()).toBeVisible();
});

test("promote a one-off chat into a project", async ({ page }) => {
  // Start a one-off chat and send a message so a session exists.
  await page.goto("/chat");
  const composer = page.getByPlaceholder(/Ask anything/i);
  await composer.fill("scratch e2e message");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/Acknowledged: scratch e2e message/)).toBeVisible({ timeout: 30_000 });
  // The URL now carries the scratch session id.
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  // Promote it.
  await page.getByRole("button", { name: /Promote to project/i }).click();
  const dialog = page.locator("form").filter({ hasText: "Promote to project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill("E2E Promoted Project");
  await dialog.getByRole("button", { name: /Promote to project/i }).click();

  // We land in the new project (its chat view), with the moved history present.
  await expect(page).toHaveURL(/\/projects\/e2e-promoted-project/, { timeout: 15_000 });
  await expect(page.getByText("scratch e2e message").first()).toBeVisible({ timeout: 15_000 });
});
