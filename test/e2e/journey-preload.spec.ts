import { test, expect } from "@playwright/test";
import { createProjectViaUI, writeProjectFile, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: the "Preload project context" checkbox on a NEW project chat (#1).
 *
 * The checkbox is shown only on a brand-new project chat (no session yet). It's
 * disabled until a sweep has produced an OVERVIEW.md, and default-ON once
 * available. We create the project via the UI (keeper wired), then seed an
 * OVERVIEW.md on disk (what a sweep would author) and reload so the server
 * reports hasOverview:true.
 */

test("preload checkbox: disabled with no overview, enabled + default-on once OVERVIEW.md exists", async ({
  page,
}) => {
  const slug = await createProjectViaUI(page, { name: uniq("PL Preload") });

  // Fresh new chat, no overview yet → the toggle is present but DISABLED, with
  // the "(no overview yet)" hint.
  const checkbox = page.getByRole("checkbox", { name: /Preload project context/i });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toBeDisabled();
  await expect(page.getByText(/no overview yet/i)).toBeVisible();

  // Seed an OVERVIEW.md (what a sweep would write) then reload the chat.
  writeProjectFile(slug, "OVERVIEW.md", "# Overview\n\nSeeded project state.\n");
  await page.goto(`/projects/${slug}/chat`);

  // Now the toggle is ENABLED and checked by default, with the inject hint.
  const enabled = page.getByRole("checkbox", { name: /Preload project context/i });
  await expect(enabled).toBeEnabled();
  await expect(enabled).toBeChecked();
  await expect(page.getByText(/injects OVERVIEW\.md/i)).toBeVisible();

  // The header also shows the "Overview" hint pill once an overview exists.
  await expect(page.getByText("Overview", { exact: true })).toBeVisible();

  // Sending the first turn with preload ON augments the prompt with a
  // <project-context> block (the seeded OVERVIEW.md), so the fake echoes the
  // whole augmented prompt. Assert the streamed reply contains BOTH the injected
  // overview marker and the user's message tail — proving preload reached the agent.
  const composer = page.getByPlaceholder(/Message the keeper agent/i);
  await composer.fill("kick off with context");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/Seeded project state/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/kick off with context/).first()).toBeVisible();

  // After the first turn established the session, the preload toggle is gone
  // (it only shows on a never-resumed new chat).
  await expect(page.getByRole("checkbox", { name: /Preload project context/i })).toHaveCount(0);
});

test("preload toggle can be unchecked before sending", async ({ page }) => {
  const slug = await createProjectViaUI(page, { name: uniq("PL Uncheck") });
  writeProjectFile(slug, "OVERVIEW.md", "# Overview\n\nState.\n");
  await page.goto(`/projects/${slug}/chat`);

  const checkbox = page.getByRole("checkbox", { name: /Preload project context/i });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();

  // It still sends fine with preload off.
  await sendChatTurn(page, "no preload please");
  await expect(page.getByText(/Acknowledged: no preload please/).first()).toBeVisible();
});
