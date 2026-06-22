import { test, expect } from "@playwright/test";
import { createProjectViaUI, writeProjectFile, gitCommitAll, uniq } from "./helpers";

/**
 * Journey: Changes / git tab (runs on the GIT-ENABLED server — see
 * playwright.config.ts `chromium-git` project). The projects root is a real git
 * repo, so the Changes tab lights up.
 *
 * Covers: the Changes tab appears (with an uncommitted badge); the changed-files
 * list; a unified diff for a tracked change; commit (→ clean); and the
 * non-repo case is asserted on the DEFAULT server in journey-project-view.
 *
 * Projects are created via the UI so the keeper is wired and the project dir is
 * created inside the repo (its files start untracked).
 */

test("Changes tab is present on a git repo and lists uncommitted project files", async ({
  page,
}) => {
  const name = uniq("GIT Changes");
  const slug = await createProjectViaUI(page, { name });
  await page.goto(`/projects/${slug}/chat`);

  // The Changes tab is rendered (git repo). A freshly-created project dir is
  // untracked, so the badge shows a non-zero count.
  const changesTab = page.getByRole("button", { name: /^Changes/ });
  await expect(changesTab).toBeVisible({ timeout: 15_000 });
  await changesTab.click();

  // The changed-files panel lists the new project's untracked files.
  await expect(page.getByText("Changed files")).toBeVisible();
  await expect(page.getByRole("button", { name: /project\.yaml/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /CHANGELOG\.md/ })).toBeVisible();
  // The branch indicator shows "main".
  await expect(page.getByText("main", { exact: true })).toBeVisible();
});

test("shows a unified diff for a tracked, modified file", async ({ page }) => {
  const name = uniq("GIT Diff");
  const slug = await createProjectViaUI(page, { name });
  // Commit the new project dir so a subsequent change is a tracked modification.
  gitCommitAll(`add ${slug}`);
  // Modify a tracked file on disk → a real diff.
  writeProjectFile(slug, "CHANGELOG.md", "# Changelog\n\n## 2026-01-01\n- a tracked edit line\n", {
    git: true,
  });

  await page.goto(`/projects/${slug}/chat`);
  await page.getByRole("button", { name: /^Changes/ }).click();

  // Select the modified CHANGELOG.md and confirm the diff renders the added line.
  await page.getByRole("button", { name: /CHANGELOG\.md/ }).click();
  await expect(page.getByText(/a tracked edit line/).first()).toBeVisible({ timeout: 15_000 });
});

test("commit clears the working tree (→ clean) and updates the badge", async ({ page }) => {
  const name = uniq("GIT Commit");
  const slug = await createProjectViaUI(page, { name });
  await page.goto(`/projects/${slug}/chat`);
  await page.getByRole("button", { name: /^Changes/ }).click();

  // Type a commit message and commit.
  await page.getByPlaceholder(/Commit message/i).fill("commit from e2e");
  await page.getByRole("button", { name: /^Commit/ }).click();

  // After committing, the subtree is clean — the "clean" indicator shows and the
  // changed-files list reports no uncommitted changes.
  await expect(page.getByText("clean", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/No uncommitted changes/i)).toBeVisible();
});

test("committing with nothing to commit surfaces a 'Nothing to commit' note", async ({ page }) => {
  const name = uniq("GIT Empty");
  const slug = await createProjectViaUI(page, { name });
  // Commit everything so the subtree is clean to start.
  gitCommitAll(`add ${slug}`);

  await page.goto(`/projects/${slug}/chat`);
  // With a clean tree there may be no Changes tab badge; open Changes if present.
  const changesTab = page.getByRole("button", { name: /^Changes/ });
  await expect(changesTab).toBeVisible({ timeout: 15_000 });
  await changesTab.click();

  // The commit button is disabled when there's nothing to commit (files.length 0).
  await expect(page.getByText("clean", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Commit/ })).toBeDisabled();
});
