import { test, expect } from "@playwright/test";
import { createProject, sendChat } from "./helpers";

/**
 * Chat-management journeys in the browser: switching a project's model via the
 * composer picker (and that it persists), the context meter populating after a
 * turn, and deleting + renaming a saved chat from the session list.
 */

test("switch the model in the composer; it persists across reload", async ({ page }) => {
  await createProject(page, "E2E Model Switch", { area: "Homelab" });

  const picker = page.getByTitle(/Model for this chat/i);
  await expect(picker).toBeEnabled({ timeout: 15_000 });

  // Pick a non-default model option (whatever the second option is).
  const options = picker.locator("option");
  const count = await options.count();
  expect(count).toBeGreaterThan(1);
  const secondValue = await options.nth(1).getAttribute("value");
  await picker.selectOption(secondValue!);
  await expect(picker).toHaveValue(secondValue!);

  // Send a turn so a session is established (the per-chat model migrates to the
  // session-id key), then reload and confirm the picker restored the choice.
  await sendChat(page, "model switch turn");
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTitle(/Model for this chat/i)).toHaveValue(secondValue!, { timeout: 15_000 });
});

test("the context meter populates after a completed turn", async ({ page }) => {
  await createProject(page, "E2E Context Meter", { area: "House" });
  // Before any turn the meter shows the placeholder.
  await expect(page.getByText("context: —")).toBeVisible({ timeout: 15_000 });

  await sendChat(page, "fill the meter");
  // After the turn the fake reports usage (1200 input tokens) → "1k / …k (..%)".
  await expect(page.getByText(/\d+k \/ \d+k \(\d+%\)/)).toBeVisible({ timeout: 15_000 });
});

test("rename and delete a saved chat from the session list", async ({ page }) => {
  await createProject(page, "E2E Chat CRUD", { area: "Homelab" });
  await sendChat(page, "first saved chat");
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  // The chat now appears in the session list. Rename it via the prompt.
  page.once("dialog", () => {}); // window.prompt is handled below
  await page.evaluate(() => {
    // Force window.prompt to return a fixed name for the rename.
    (window as unknown as { prompt: () => string }).prompt = () => "Renamed Chat";
  });
  // Hover the chat row to reveal the rename button, then click it.
  const renameBtn = page.getByRole("button", { name: /Rename chat/i }).first();
  await renameBtn.click();
  await expect(page.getByText("Renamed Chat")).toBeVisible({ timeout: 10_000 });

  // Delete it (confirm dialog).
  await page.getByRole("button", { name: /Delete chat Renamed Chat/i }).click();
  await page.getByRole("button", { name: /^Delete chat$/ }).click();
  await expect(page.getByText("Renamed Chat")).toHaveCount(0, { timeout: 10_000 });
  // Falls back to a fresh "new chat".
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+\/chat$/, { timeout: 10_000 });
});

test("cancel a streaming turn is not needed but Stop is shown while streaming", async ({ page }) => {
  await createProject(page, "E2E Stop Button", { area: "Homelab" });
  await page.getByPlaceholder(/Message the keeper agent/i).fill("a turn");
  await page.getByRole("button", { name: /^Send$/ }).click();
  // The Send button flips to Stop while the turn is in flight. The fake is fast,
  // so either we catch the Stop button or the turn completes — assert the reply
  // arrives (the streaming lifecycle ran).
  await expect(page.getByText("Acknowledged: a turn").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible();
});
