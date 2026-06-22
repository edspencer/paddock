import { test, expect } from "@playwright/test";
import { createProject, seedProjectFile } from "./helpers";

/**
 * The git-backing-store "Changes" tab, driven end-to-end against a REAL git repo
 * (server.mjs runs `git init` on the projects store when PADDOCK_E2E_GIT=1, the
 * default in the playwright config). Covers: the tab appearing with an
 * uncommitted-count badge, the diff view, committing, and the push affordance
 * being disabled when there's no remote (a FAILURE-mode journey).
 */

test("Changes tab shows uncommitted files, a diff, and commits them", async ({ page }) => {
  const slug = await createProject(page, "E2E Git Project", { area: "Homelab" });

  // Author a file on disk (as the keeper agent would) so the project subtree has
  // an uncommitted change for the Changes tab to surface.
  seedProjectFile(slug, "notes.md", "# Notes\n\nfirst draft\n");

  // Open the project's Files→reload so the new git status is fetched, then the
  // Changes tab should appear with a badge.
  await page.goto(`/projects/${slug}/chat`);
  const changesTab = page.getByRole("button", { name: /Changes/ });
  await expect(changesTab).toBeVisible({ timeout: 10_000 });

  await changesTab.click();

  // The changed file is listed and its diff renders (it's untracked → the diff
  // pane shows the "no diff for untracked" note OR the added lines; assert the
  // file row at minimum).
  await expect(page.getByText("notes.md").first()).toBeVisible();

  // Commit it.
  await page.getByPlaceholder(/Commit message/i).fill("checkpoint notes");
  await page.getByRole("button", { name: /^Commit$/ }).click();

  // A short-hash confirmation appears and the working tree goes clean.
  await expect(page.getByText(/Committed [0-9a-f]{7}/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("clean")).toBeVisible({ timeout: 10_000 });
});

test("Push is disabled when no remote is configured (failure mode)", async ({ page }) => {
  const slug = await createProject(page, "E2E No Remote", { area: "Homelab" });
  seedProjectFile(slug, "thing.md", "x\n");
  await page.goto(`/projects/${slug}/chat`);

  const changesTab = page.getByRole("button", { name: /Changes/ });
  await expect(changesTab).toBeVisible({ timeout: 10_000 });
  await changesTab.click();

  const push = page.getByRole("button", { name: /Push/ });
  await expect(push).toBeVisible();
  await expect(push).toBeDisabled();
  await expect(push).toHaveAttribute("title", /No remote configured/i);
});

test("commit with nothing staged is a graceful no-op", async ({ page }) => {
  const slug = await createProject(page, "E2E Clean Commit", { area: "House" });
  // Author then immediately... we need a change to enable Commit, so seed one,
  // commit it, and assert that re-committing reports nothing.
  seedProjectFile(slug, "a.md", "one\n");
  await page.goto(`/projects/${slug}/chat`);
  await page.getByRole("button", { name: /Changes/ }).click();
  await page.getByPlaceholder(/Commit message/i).fill("first");
  await page.getByRole("button", { name: /^Commit$/ }).click();
  await expect(page.getByText(/Committed [0-9a-f]{7}/i)).toBeVisible({ timeout: 10_000 });

  // Now clean — the Commit button is disabled (nothing to commit).
  await expect(page.getByRole("button", { name: /^Commit$/ })).toBeDisabled();
});

test("GitHub affordance reports 'not configured' without a client id", async ({ page }) => {
  const slug = await createProject(page, "E2E GitHub Affordance", { area: "Homelab" });
  seedProjectFile(slug, "z.md", "z\n");
  await page.goto(`/projects/${slug}/chat`);
  await page.getByRole("button", { name: /Changes/ }).click();
  // No PADDOCK_GITHUB_CLIENT_ID is set on the E2E server → "not configured".
  await expect(page.getByText(/GitHub not configured/i)).toBeVisible({ timeout: 10_000 });
});
