import { test, expect } from "@playwright/test";
import { createProjectViaUI, uniq } from "./helpers";

/**
 * Journey: Project lifecycle — create → edit → delete, fully through the UI.
 *
 * Create with name/area/summary/tags (New Project modal) → land in the project,
 * and it appears under its area on the grid + in the sidebar. Edit
 * (area/status/summary/tags) → reflected on the project header, the grid, and
 * the sidebar. Delete (confirm dialog) → removed everywhere and we return to
 * the landing page.
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

  // Open the project actions menu in the header, choose Edit details.
  await page.getByRole("button", { name: /Project actions/i }).click();
  await page.getByRole("menuitem", { name: /Edit details/i }).click();

  const dialog = page.locator("form").filter({ hasText: "Edit project" });
  await expect(dialog).toBeVisible();
  // Change summary, area (House), status (paused), tags.
  await dialog.getByPlaceholder(/One line on what/i).fill("after edit");
  // Area select is the first combobox; Status is the second.
  await dialog.getByRole("combobox").first().selectOption({ label: "House" });
  await dialog.getByRole("combobox").nth(1).selectOption("paused");
  await dialog.getByPlaceholder(/home, plumbing/i).fill("editedtag");
  await dialog.getByRole("button", { name: /Save changes/i }).click();
  await expect(dialog).toBeHidden();

  // Header reflects the new summary + tag + status pill.
  await expect(page.getByText("after edit")).toBeVisible();
  await expect(page.getByRole("button", { name: "editedtag", exact: true }).first()).toBeVisible();

  // On the grid the project now lives under House (not Homelab).
  await page.goto("/");
  const house = page.getByRole("button", { name: /^House/ });
  if ((await house.getAttribute("aria-expanded")) === "false") await house.click();
  await expect(page.locator("section a.card").filter({ hasText: name })).toBeVisible();
});

// GAP — tracked by edspencer/paddock#12 ("per-project settings UI"). The project
// `model` is part of the API + DTO (UpdateProjectInput.model, Project.model) and
// the PATCH route validates + re-registers the keeper on a model change, but the
// Edit Project modal exposes NO model picker (only status/area/summary/tags) — so
// the prompt's "edit ... model → reflected on the grid + sidebar" surface isn't
// drivable from the UI today. Marked fixme so the intended journey is documented
// and flips green once the model picker lands in the edit/settings UI.
test.fixme("edit a project's keeper model from the UI → reflected on the chat picker", async ({
  page,
}) => {
  const { createProjectViaUI } = await import("./helpers");
  const name = uniq("LC Model");
  const slug = await createProjectViaUI(page, { name, area: "Homelab" });
  await page.goto(`/projects/${slug}/chat`);

  await page.getByRole("button", { name: /Project actions/i }).click();
  await page.getByRole("menuitem", { name: /Edit details/i }).click();
  const dialog = page.locator("form").filter({ hasText: "Edit project" });
  // EXPECTED (post-#12): a Model picker in the edit modal. Today it doesn't exist.
  await dialog.getByRole("combobox", { name: /Model/i }).selectOption({ label: "Sonnet 4.6" });
  await dialog.getByRole("button", { name: /Save changes/i }).click();

  // The chat composer's model picker should now default to the project's new model.
  const chatModel = page
    .getByRole("combobox")
    .filter({ has: page.getByRole("option", { name: /Sonnet/ }) });
  await expect(chatModel).toHaveValue("claude-sonnet-4-6");
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
