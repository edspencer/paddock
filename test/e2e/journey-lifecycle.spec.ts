import { test, expect } from "@playwright/test";
import { createProjectViaUI, uniq } from "./helpers";

/**
 * Journey: Project lifecycle — create → edit → delete, fully through the UI.
 *
 * Create with name/area/summary/tags (New Project modal) → land in the project,
 * and it appears under its area on the grid + in the sidebar. Edit
 * (area/status/summary/tags) via the Settings tab → reflected on the project
 * header, the grid, and the sidebar. Delete (confirm dialog) → removed
 * everywhere and we return to the landing page.
 *
 * Created via the UI (not disk-seeded) so the keeper agent is registered and the
 * project is fully real.
 */

test("create with name/area/summary/tags → lands + appears under its area + sidebar", async ({
  page,
}) => {
  const name = uniq("LC Create");
  const slug = await createProjectViaUI(page, {
    name,
    area: "Homelab",
    summary: "A homelab thing",
    tags: "lctag, networking",
  });

  // Landed in the project chat view.
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}`));
  await expect(page.getByPlaceholder(/Message the keeper agent/i)).toBeVisible();
  // Header reflects name, summary, and tags.
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("A homelab thing")).toBeVisible();

  // On the landing page it shows under Homelab, and the sidebar lists it.
  await page.goto("/");
  const homelab = page.getByRole("button", { name: /^Homelab/ });
  if ((await homelab.getAttribute("aria-expanded")) === "false") await homelab.click();
  await expect(page.locator("section a.card").filter({ hasText: name })).toBeVisible();
  await expect(page.locator("aside").getByRole("link", { name: new RegExp(name) })).toBeVisible();
});

test("edit area/status/summary/tags → reflected on the project header + grid + sidebar", async ({
  page,
}) => {
  const name = uniq("LC Edit");
  const slug = await createProjectViaUI(page, { name, area: "Homelab", summary: "before" });
  await page.goto(`/projects/${slug}/chat`);

  // Open the project actions menu in the header, choose Edit details → the
  // Settings tab (issue #122; the old modal was retired).
  await page.getByRole("button", { name: /Project actions/i }).click();
  await page.getByRole("menuitem", { name: /Edit details/i }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/settings`));

  const settings = page.getByRole("main");
  await expect(settings.getByRole("heading", { name: /Identity & metadata/i })).toBeVisible();
  // Change summary, area (House), status (paused), tags.
  await settings.getByPlaceholder(/One line on what/i).fill("after edit");
  await settings.getByLabel("Area").selectOption({ label: "House" });
  await settings.getByLabel("Status").selectOption("paused");
  await settings.getByPlaceholder(/home, plumbing/i).fill("editedtag");
  await settings.getByRole("button", { name: /Save changes/i }).click();

  // Header reflects the new summary + tag + status pill.
  await expect(page.getByText("after edit")).toBeVisible();
  await expect(page.getByRole("button", { name: "editedtag", exact: true }).first()).toBeVisible();

  // On the grid the project now lives under House (not Homelab).
  await page.goto("/");
  const house = page.getByRole("button", { name: /^House/ });
  if ((await house.getAttribute("aria-expanded")) === "false") await house.click();
  await expect(page.locator("section a.card").filter({ hasText: name })).toBeVisible();
});

// Previously a GAP (edspencer/paddock#12): the Edit modal exposed no model
// picker, so a project's keeper `model` wasn't editable from the UI. The
// Settings tab (issue #122) now surfaces it, so this journey is drivable.
test("edit a project's keeper model from the UI → reflected on the chat picker", async ({
  page,
}) => {
  const name = uniq("LC Model");
  const slug = await createProjectViaUI(page, { name, area: "Homelab" });
  await page.goto(`/projects/${slug}/chat`);

  await page.getByRole("button", { name: /Project actions/i }).click();
  await page.getByRole("menuitem", { name: /Edit details/i }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/settings`));
  // The Settings tab's keeper Model picker.
  await page.getByRole("main").getByLabel("Model").selectOption({ label: "Sonnet 5" });
  await page.getByRole("button", { name: /Save changes/i }).click();

  // A fresh chat's composer picker defaults to the project's (new) keeper model.
  await page.goto(`/projects/${slug}/chat`);
  const chatModel = page
    .getByRole("combobox")
    .filter({ has: page.getByRole("option", { name: /Sonnet/ }) });
  await expect(chatModel).toHaveValue("claude-sonnet-5");
});

test("delete (confirm dialog) → removed from grid + sidebar, returns to landing", async ({
  page,
}) => {
  const name = uniq("LC Delete");
  const slug = await createProjectViaUI(page, { name, area: "Side Projects" });
  await page.goto(`/projects/${slug}/chat`);
  // Wait for the project header to render before opening its actions menu.
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: /Project actions/i }).click();
  await page.getByRole("menuitem", { name: /Delete project/i }).click();

  // The confirm dialog names the project; confirming deletes + navigates home.
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(name)).toBeVisible();
  await confirm.getByRole("button", { name: /Delete project/i }).click();

  await expect(page).toHaveURL(/\/$/);
  // Gone from the grid + sidebar (both auto-retry until the context refresh lands).
  await expect(page.locator("a.card").filter({ hasText: name })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("link", { name: new RegExp(name) })).toHaveCount(0);
});
