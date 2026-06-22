import { test, expect } from "@playwright/test";
import { sendChatTurn, uniq, slugify } from "./helpers";

/**
 * Journey: One-off (scratch) chats.
 *
 * A new one-off streams + appears in the "Recent" list (and the landing Inbox);
 * it can be renamed and deleted (confirm dialog); and it can be PROMOTED into a
 * project, landing in the project's chat with its history moved + still
 * resumable (continuity: a codeword set before promotion is recalled after).
 */

test("new one-off streams, then appears in the Recent list", async ({ page }) => {
  await page.goto("/chat");
  const msg = uniq("OO recent");
  await sendChatTurn(page, msg, { placeholder: /Ask anything/i });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  // It now appears in the left "Recent" list (its name derived from the preview).
  await expect(page.getByRole("button").filter({ hasText: new RegExp(msg) }).first()).toBeVisible();
});

test("one-off Recent list exposes Delete but (currently) no Rename affordance", async ({ page }) => {
  // GAP — tracked by edspencer/paddock#24 ("one-off chats can be deleted but not
  // renamed"). The project-chat session list has BOTH rename + delete, but the
  // one-off (scratch) Recent list only renders a Delete button — even though the
  // server supports PATCH /api/chats/:id (renameScratchChat). This asserts the
  // CURRENT behavior so a future rename UI addition flips it (and surfaces the
  // gap, not a defect).
  await page.goto("/chat");
  const msg = uniq("OO rename");
  await sendChatTurn(page, msg, { placeholder: /Ask anything/i });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  const entry = page.locator(".group\\/chat").filter({ hasText: new RegExp(msg) }).first();
  await entry.hover();
  await expect(entry.getByRole("button", { name: /Delete chat/i })).toBeVisible();
  // No rename control in the one-off list today.
  await expect(entry.getByRole("button", { name: /Rename chat/i })).toHaveCount(0);
});

test("delete a one-off chat via the confirm dialog removes it from Recent", async ({ page }) => {
  await page.goto("/chat");
  const msg = uniq("OO delete");
  await sendChatTurn(page, msg, { placeholder: /Ask anything/i });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  // Hover the Recent entry and click its delete button.
  const entry = page.locator(".group\\/chat").filter({ hasText: new RegExp(msg) }).first();
  await entry.hover();
  await entry.getByRole("button", { name: /Delete chat/i }).click();

  // Confirm dialog → confirm → the chat is gone and we return to a fresh /chat.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Delete chat/i }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("button").filter({ hasText: new RegExp(msg) })).toHaveCount(0);
});

test("promote a one-off → project: lands in project chat with history + resume continuity", async ({
  page,
}) => {
  // Set a codeword in the one-off chat so we can prove continuity post-promote.
  await page.goto("/chat");
  await sendChatTurn(page, "the codeword is promomelon", {
    placeholder: /Ask anything/i,
    expectReply: /remember the codeword promomelon/i,
  });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  // Promote it to a project.
  const projectName = uniq("OO Promoted");
  const slug = slugify(projectName);
  await page.getByRole("button", { name: /Promote to project/i }).click();
  const dialog = page.locator("form").filter({ hasText: "Promote to project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill(projectName);
  await dialog.getByRole("combobox").first().selectOption({ label: "Side Projects" });
  await dialog.getByRole("button", { name: /Promote to project/i }).click();

  // We land in the new project's chat with the MOVED history present.
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), { timeout: 15_000 });
  await expect(page.getByText(/the codeword is promomelon/).first()).toBeVisible({ timeout: 15_000 });

  // Continuity: resume the promoted session and recall the codeword (#263 fix).
  await sendChatTurn(page, "what was the codeword?", {
    expectReply: /The codeword was promomelon/i,
  });
});

test("a promoted project appears under its area on the landing grid", async ({ page }) => {
  await page.goto("/chat");
  await sendChatTurn(page, uniq("OO promote grid"), { placeholder: /Ask anything/i });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  const projectName = uniq("OO Grid Promoted");
  const slug = slugify(projectName);
  await page.getByRole("button", { name: /Promote to project/i }).click();
  const dialog = page.locator("form").filter({ hasText: "Promote to project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill(projectName);
  await dialog.getByRole("combobox").first().selectOption({ label: "Homelab" });
  await dialog.getByRole("button", { name: /Promote to project/i }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}`), { timeout: 15_000 });

  await page.goto("/");
  const homelab = page.getByRole("button", { name: /^Homelab/ });
  if ((await homelab.getAttribute("aria-expanded")) === "false") await homelab.click();
  await expect(page.locator("section a.card").filter({ hasText: projectName })).toBeVisible();
});
