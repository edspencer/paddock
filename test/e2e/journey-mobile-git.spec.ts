import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createProjectViaUI, gitCommitAll, uniq, writeProjectFile } from "./helpers";

/**
 * Journey: the Changes / git tab on a phone (runs under the `mobile-git`
 * project → Pixel 5 against the GIT-enabled server). Asserts the changed-files
 * list and a unified diff render without forcing the page wider than the screen
 * (the diff scrolls within its own pane).
 */

const SHOTS = new URL("./.mobile-shots/", import.meta.url).pathname;

async function hOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("Changes tab + unified diff render on mobile (no page overflow)", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  const slug = await createProjectViaUI(page, { name: uniq("MOB Git") });
  // Commit the new project dir, then make a tracked modification so a diff exists.
  gitCommitAll(`add ${slug}`);
  writeProjectFile(
    slug,
    "CHANGELOG.md",
    "# Changelog\n\n## 2026-01-01\n- a tracked edit line that is deliberately quite long so the " +
      "unified diff has wide content, letting us confirm it scrolls within the diff pane rather " +
      "than blowing the page out horizontally on a narrow phone screen\n",
    { git: true },
  );

  // On mobile the chat view hides the tab bar (the chat is a focused view); the
  // tabs — including Changes — live on the Home hub, so drive Changes from Home.
  await page.goto(`/projects/${slug}/home`);
  const changesTab = page.getByRole("button", { name: /^Changes/ });
  await expect(changesTab).toBeVisible({ timeout: 15_000 });
  await changesTab.click();

  await expect(page.getByText("Changed files")).toBeVisible();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}11-changes-list.png`, fullPage: true });

  await page.getByRole("button", { name: /CHANGELOG\.md/ }).click();
  await expect(page.getByText(/a tracked edit line/).first()).toBeVisible({ timeout: 15_000 });
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}12-changes-diff.png`, fullPage: true });
});
