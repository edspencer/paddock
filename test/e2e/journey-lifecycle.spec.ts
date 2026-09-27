import { test, expect } from "@playwright/test";
import { createProjectViaUI, uniq } from "./helpers";

/**
 * Journey: Project lifecycle — create → edit → delete, fully through the UI.
 *
 * Create with name/area/summary/tags (New Project modal) → land in the project,
 * and it appears under its area on the grid + in the sidebar. Edit
 * (area/status/summary/tags) via the Settings tab → reflected on the project
 * header, the grid, and the sidebar. Delete (confirm dialog) → removed
 * everywhere and we return to the projects grid, which is its own page at
 * `/projects` again (#599 gave root Home's opening screen to the running/unread
 * feeds — see `gridUrl`).
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
  await expect(page.getByPlaceholder(/Message Claude/i)).toBeVisible();
  // The header carries the name; the summary leads the Home tab (#919 — the
  // header is just the name and the tabs now).
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await page.getByTestId("workspace-tabs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("home-summary")).toHaveText("A homelab thing");

  // On the projects grid it shows under Homelab, and the sidebar lists it.
  await page.goto("/projects");
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

  // Straight to the Settings tab. The header's ⋯ menu used to offer "Edit
  // details" for this, which only switched to this same tab (#919).
  await page.getByTestId("workspace-tabs").getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/settings`));

  const settings = page.getByRole("main");
  await expect(settings.getByRole("heading", { name: /Identity & metadata/i })).toBeVisible();
  // Change summary, area (House), status (paused), tags.
  await settings.getByPlaceholder(/One line on what/i).fill("after edit");
  await settings.getByLabel("Area").selectOption({ label: "House" });
  await settings.getByLabel("Status").selectOption("paused");
  await settings.getByPlaceholder(/home, plumbing/i).fill("editedtag");
  await settings.getByRole("button", { name: /Save changes/i }).click();

  // The sidebar row carries the new tag; Home leads with the new summary (the
  // header shows neither since #919 — it is just the name and the tabs).
  await expect(page.getByRole("button", { name: "editedtag", exact: true }).first()).toBeVisible();
  await page.getByTestId("workspace-tabs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("home-summary")).toHaveText("after edit");

  // On the grid the project now lives under House (not Homelab).
  await page.goto("/projects");
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

  await page.getByTestId("workspace-tabs").getByRole("button", { name: "Settings" }).click();
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

test("delete (confirm dialog) → removed from grid + sidebar, returns to the projects grid", async ({
  page,
}) => {
  const name = uniq("LC Delete");
  const slug = await createProjectViaUI(page, { name, area: "Side Projects" });
  // The Settings danger zone (#923) is the only delete inside a project since
  // the header's ⋯ menu went (#919).
  await page.goto(`/projects/${slug}/settings`);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: /Delete project…/i }).click();

  // The confirm dialog names the project; confirming deletes + navigates back to
  // the projects grid (`/projects` — see `gridUrl`).
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(name)).toBeVisible();
  await confirm.getByRole("button", { name: /Delete project/i }).click();

  await expect(page).toHaveURL(/\/projects$/);
  // …and it really is the grid, not a route-error screen: its own page header.
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  // Gone from the grid + sidebar (both auto-retry until the context refresh lands).
  await expect(page.locator("a.card").filter({ hasText: name })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("link", { name: new RegExp(name) })).toHaveCount(0);
});
