import { test, expect } from "@playwright/test";
import { seedProject, uniq } from "./helpers";

/**
 * Journey: Project view tabs + routing.
 *
 * The active tab is derived from the URL (deep-linkable + reload-safe):
 *   /projects/:slug/home                -> Home tab (project overview)
 *   /projects/:slug/chat[/:sessionId]   -> Chat tab
 *   /projects/:slug/files[/:name]       -> Files tab / a file
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

test("opening a file deep-links to /files/:name and renders it; back returns to the list", async ({
  page,
}) => {
  const name = uniq("PV File");
  const slug = seedProject({ name, files: { "readme.md": "# Readme\n\nA **markdown** file." } });

  await page.goto(`/projects/${slug}/files`);
  await page.getByText("readme.md").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files/readme.md`));
  // Markdown renders (the bold text becomes a <strong>).
  await expect(page.locator("strong", { hasText: "markdown" })).toBeVisible();

  // The back link returns to the files list.
  await page.getByRole("button", { name: /← Files/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files$`));
  await expect(page.getByText("readme.md")).toBeVisible();
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
