import { test, expect } from "@playwright/test";
import { seedProject, uniq } from "./helpers";

/**
 * Journey: Domain-tag filtering (/tags/:tag).
 *
 * A project card / sidebar entry shows its domain tags as clickable chips that
 * navigate to /tags/:tag — a flat grid of only the projects carrying that tag,
 * with an active filter chip (clearable via ×) and an empty state for an
 * unknown tag.
 */

test("deep-link /tags/:tag filters to matching projects + shows the active chip", async ({
  page,
}) => {
  const tag = `tagjourney${Date.now().toString(36)}`;
  seedProject({ name: uniq("TG Match One"), domain: [tag, "shared"] });
  seedProject({ name: uniq("TG Match Two"), domain: [tag] });
  seedProject({ name: uniq("TG NoMatch"), domain: ["other"] });

  await page.goto(`/tags/${tag}`);

  await expect(page.getByRole("heading", { name: /Projects tagged/i })).toBeVisible();
  // Both tagged projects appear; the untagged one does not.
  await expect(page.getByRole("link", { name: /TG Match One/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /TG Match Two/ }).first()).toBeVisible();
  // The grid is the flat tag grid; the non-matching project's CARD is absent.
  await expect(page.locator("a.card").filter({ hasText: "TG NoMatch" })).toHaveCount(0);

  // The active-filter chip is shown with the tag and a clear "×".
  await expect(page.getByText("Filtered by")).toBeVisible();
  const clear = page.getByRole("button", { name: new RegExp(`Clear ${tag} filter`) });
  await expect(clear).toBeVisible();

  // Clearing returns to the full landing (area sections, no filter chip).
  await clear.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Filtered by")).toHaveCount(0);
});

test("unknown tag shows the empty 'No projects tagged' state with Clear filter", async ({
  page,
}) => {
  await page.goto(`/tags/definitely-no-such-tag-${Date.now().toString(36)}`);
  await expect(page.getByRole("heading", { name: /No projects tagged/i })).toBeVisible();
  const clear = page.getByRole("button", { name: /Clear filter/i });
  await expect(clear).toBeVisible();
  await clear.click();
  await expect(page).toHaveURL(/\/$/);
});

test("clicking a tag chip on a project card navigates to its tag filter (not the project)", async ({
  page,
}) => {
  // TagPill is a <button> that navigates to /tags/:tag and stops propagation, so
  // clicking it on a card filters by tag WITHOUT also opening the project (#22).
  const tag = `chipnav${Date.now().toString(36)}`;
  const name = uniq("TG Chip");
  seedProject({ name, domain: [tag] });

  await page.goto("/");
  const card = page.locator("section a.card").filter({ hasText: name });
  await expect(card).toBeVisible();

  // Click the tag chip (a button whose visible text is the tag) inside the card.
  await card.getByRole("button", { name: tag, exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/tags/${tag}$`));
  await expect(page.getByRole("heading", { name: /Projects tagged/i })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(name) }).first()).toBeVisible();
});
