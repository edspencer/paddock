import { test, expect } from "@playwright/test";
import { seedProject, uniq } from "./helpers";

/**
 * Journey: Project view tabs + routing.
 *
 * The active tab is derived from the URL (deep-linkable + reload-safe):
 *   /projects/:slug/home                -> Home tab (project overview)
 *   /projects/:slug/chat[/:sessionId]   -> Chat tab
 *   /projects/:slug/files[/<path>]      -> Files tab / a subdirectory or file (#259)
 * The bare /projects/:slug redirects to the STICKY last tab (localStorage),
 * defaulting to home. The Changes tab only appears on a git repo (covered in the
 * journey-git-* suite); here we assert it's ABSENT on a non-repo server.
 *
 * Disk-seeded with a couple of files so the Files tab has content.
 */

test("Chat and Files tabs switch via the URL; deep-links highlight the right tab", async ({
  page,
}) => {
  const name = uniq("PV Tabs");
  const slug = seedProject({
    name,
    files: { "notes.md": "# Notes\n\nHello.", "data.txt": "plain text" },
  });

  // Deep-link straight to the Files sub-route → Files tab active, files listed.
  await page.goto(`/projects/${slug}/files`);
  await expect(page.getByRole("button", { name: /^Files$/ })).toBeVisible();
  await expect(page.getByText("notes.md")).toBeVisible();
  await expect(page.getByText("data.txt")).toBeVisible();

  // Switch to Chat via the tab; URL updates and the composer shows.
  await page.getByRole("button", { name: /^Chat$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat`));
  await expect(page.getByPlaceholder(/Message the keeper agent/i)).toBeVisible();

  // The Changes tab is absent on a non-git server.
  await expect(page.getByRole("button", { name: /^Changes/ })).toHaveCount(0);
});

test("opening a file deep-links to /files/<path> and renders it; breadcrumb returns to the list", async ({
  page,
}) => {
  const name = uniq("PV File");
  const slug = seedProject({ name, files: { "readme.md": "# Readme\n\nA **markdown** file." } });

  await page.goto(`/projects/${slug}/files`);
  await page.getByText("readme.md").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files/readme.md`));
  // Markdown renders (the bold text becomes a <strong>).
  await expect(page.locator("strong", { hasText: "markdown" })).toBeVisible();

  // The breadcrumb's "Files" root crumb returns to the files list (#259).
  const crumb = page.getByRole("navigation", { name: /File path/i });
  await crumb.getByRole("button", { name: "Files" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files$`));
  await expect(page.getByText("readme.md")).toBeVisible();
});

test("browses into a subdirectory with a nested URL, and '..' goes back up (#259)", async ({
  page,
}) => {
  const name = uniq("PV Subdir");
  const slug = seedProject({
    name,
    files: {
      "top.md": "# Top",
      "design/plan.md": "# Plan\n\nInside a **subfolder**.",
    },
  });

  await page.goto(`/projects/${slug}/files`);
  // The subdirectory is listed at the root and the file inside it is NOT.
  await expect(page.getByText("design")).toBeVisible();
  await expect(page.getByText("plan.md")).toHaveCount(0);

  // Click into the folder → the URL nests and its contents show.
  await page.getByText("design").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files/design$`));
  await expect(page.getByText("plan.md")).toBeVisible();

  // Open the nested file → deep, nested file URL, rendered content.
  await page.getByText("plan.md").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files/design/plan.md`));
  await expect(page.locator("strong", { hasText: "subfolder" })).toBeVisible();

  // The ".." row (from the folder listing) goes back up to the root list.
  const crumb = page.getByRole("navigation", { name: /File path/i });
  await crumb.getByRole("button", { name: "design" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files/design$`));
  await page.getByRole("button", { name: /^\.\.$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files$`));
  await expect(page.getByText("top.md")).toBeVisible();
});

test("sticky last tab: bare /projects/:slug restores the last viewed sub-route across reload", async ({
  page,
}) => {
  const name = uniq("PV Sticky");
  const slug = seedProject({ name, files: { "page.md": "# Page" } });

  // Visit the Files list (sets sticky tab to "files").
  await page.goto(`/projects/${slug}/files`);
  await expect(page.getByText("page.md")).toBeVisible();

  // Now hit the BARE project URL → it should redirect to the sticky Files tab.
  await page.goto(`/projects/${slug}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files`));
  await expect(page.getByRole("button", { name: /^Files$/ })).toBeVisible();

  // Default (no sticky stored) is the Home tab — verify with a fresh project.
  const slug2 = seedProject({ name: uniq("PV Sticky Default") });
  await page.goto(`/projects/${slug2}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${slug2}/home`));
});
