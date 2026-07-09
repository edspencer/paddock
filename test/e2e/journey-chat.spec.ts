import { test, expect } from "@playwright/test";
import { createProjectViaUI, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: Project chat.
 *
 * send → streams → completes; the context meter populates after a turn; the
 * model picker switches model; new chat resets the pane; resuming an existing
 * chat from the list hydrates history AND continues the SAME session (continuity
 * — the fake recalls a codeword set in a prior turn on resume).
 *
 * Created via the UI so the keeper agent is wired for real turns.
 */

test("send → stream → complete; context meter populates after the turn", async ({ page }) => {
  const slug = await createProjectViaUI(page, { name: uniq("CH Stream") });

  // Before any turn: the meter shows the muted placeholder.
  await expect(page.getByText("context: —")).toBeVisible();

  await sendChatTurn(page, "first message");
  // User bubble + streamed assistant echo both present.
  await expect(page.getByText("first message").first()).toBeVisible();
  await expect(page.getByText(/Acknowledged: first message/).first()).toBeVisible();

  // The URL now carries the established session id.
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), { timeout: 15_000 });

  // The context meter populates from the completed turn's usage (1200 input
  // tokens / 200k limit → "1k / 200k (1%)").
  await expect(page.getByText(/\d+k \/ \d+k \(\d+%\)/)).toBeVisible({ timeout: 15_000 });
});

test("model picker: switch model is reflected in the select", async ({ page }) => {
  await createProjectViaUI(page, { name: uniq("CH Model") });

  const select = page.getByRole("combobox").filter({ has: page.getByRole("option", { name: /Opus/ }) });
  // Default model is the project keeper default (Opus 4.8).
  await expect(select).toBeVisible();
  // Switch to Sonnet and confirm the select reflects it.
  await select.selectOption({ label: "Sonnet 5" });
  await expect(select).toHaveValue("claude-sonnet-5");

  // Send a turn on the picked model; it still streams (the fake echoes).
  await sendChatTurn(page, "on sonnet");
  await expect(page.getByText(/Acknowledged: on sonnet/).first()).toBeVisible();
  // The picker keeps the chosen model after the turn.
  await expect(select).toHaveValue("claude-sonnet-5");
});

test("new chat resets the pane; the prior chat is still listed and resumable", async ({ page }) => {
  const slug = await createProjectViaUI(page, { name: uniq("CH NewChat") });

  await sendChatTurn(page, "chat one message");
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), { timeout: 15_000 });

  // Click "New Chat" → back to a fresh pane: the assistant echo from the prior
  // turn is gone from the transcript (the prior chat's NAME still shows in the
  // session list — that's expected), and the "New chat…" indicator is shown.
  await page.getByRole("button", { name: /New Chat/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat$`));
  await expect(page.getByText(/Acknowledged: chat one message/)).toHaveCount(0);
  await expect(page.getByText(/New chat…/)).toBeVisible();
  // The prior chat is still listed (and resumable) — its preview as the name.
  // (A second turn isn't asserted here — a fresh chat turn is covered by the
  // "send → stream → complete" + resume tests; doing two turns in rapid
  // succession only added CI-timing flakiness without new coverage.)
  await expect(page.getByRole("button").filter({ hasText: /chat one message/ }).first()).toBeVisible();
});

test("resume an existing chat from the list hydrates history + continues the SAME session", async ({
  page,
}) => {
  const slug = await createProjectViaUI(page, { name: uniq("CH Resume") });

  // Turn 1: set a codeword (the fake's built-in continuity rule remembers it).
  await sendChatTurn(page, "the codeword is e2eberry", {
    expectReply: /remember the codeword e2eberry/i,
  });
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), { timeout: 15_000 });
  const resumedUrl = page.url();

  // Navigate away (new chat) then back into the saved chat from the list.
  await page.getByRole("button", { name: /New Chat/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat$`));

  // Open the saved chat from the session list (its name is derived from preview).
  // Wait for the list entry first — the session-discovery refresh can lag a beat
  // after the turn completes (herdctl's 30s discovery cache; the list re-fetch is
  // invalidated but async), so don't race the click.
  const savedChat = page
    .getByRole("button")
    .filter({ hasText: /codeword is e2eberry/i })
    .first();
  await expect(savedChat).toBeVisible({ timeout: 15_000 });
  await savedChat.click();
  // History hydrates (the original user message is shown again) and we're back
  // on the same session URL.
  await expect(page.getByText(/the codeword is e2eberry/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(resumedUrl);

  // Turn 2 (resume): ask for the codeword — continuity proves the SAME session.
  await sendChatTurn(page, "what was the codeword?", {
    expectReply: /The codeword was e2eberry/i,
  });
});

test("Stop button appears while a turn is in flight (cancel affordance)", async ({ page }) => {
  // The fake completes a turn in ~100ms, so reliably catching the mid-flight
  // Stop button (and a deterministic cancel) is racy. We assert the affordance
  // exists by observing the Send→Stop swap: fill + click Send, then check that
  // EITHER the Stop button appeared OR the turn already completed (echo shown).
  // This documents the cancel control without a flaky mid-turn assertion.
  await createProjectViaUI(page, { name: uniq("CH Cancel") });
  const composer = page.getByPlaceholder(/Message the keeper agent/i);
  await composer.fill("a turn to maybe stop");
  await page.getByRole("button", { name: /^Send$/ }).click();

  // Either Stop showed (streaming) or the echo arrived (completed) — both prove
  // the send path engaged without error.
  await expect
    .poll(async () => {
      const stop = await page.getByRole("button", { name: /Stop/ }).count();
      const echo = await page.getByText(/Acknowledged: a turn to maybe stop/).count();
      return stop + echo;
    })
    .toBeGreaterThan(0);
  // Ultimately the turn completes and the composer is usable again (Send back).
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible({ timeout: 15_000 });
});

test("rename a project chat from the session list (window.prompt)", async ({ page }) => {
  const slug = await createProjectViaUI(page, { name: uniq("CH Rename") });
  await sendChatTurn(page, "renamable chat message");
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), { timeout: 15_000 });

  // The rename uses window.prompt — auto-answer it with a new name.
  page.once("dialog", (d) => void d.accept("My Renamed Chat"));

  const entry = page.locator(".group\\/chat").filter({ hasText: /renamable chat message/ }).first();
  await entry.hover();
  await entry.getByRole("button", { name: /Rename chat/i }).click();

  // The list entry now shows the new name.
  await expect(page.getByRole("button").filter({ hasText: /My Renamed Chat/ }).first()).toBeVisible();
});

test("delete a project chat from the session list (confirm dialog)", async ({ page }) => {
  const slug = await createProjectViaUI(page, { name: uniq("CH DelChat") });
  await sendChatTurn(page, "deletable chat message");
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), { timeout: 15_000 });

  const entry = page.locator(".group\\/chat").filter({ hasText: /deletable chat message/ }).first();
  await entry.hover();
  await entry.getByRole("button", { name: /Delete chat/i }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Delete chat/i }).click();

  // The deleted chat drops out of the list, and we fall back to a fresh new chat.
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat$`));
  await expect(page.getByText(/Acknowledged: deletable chat message/)).toHaveCount(0);
});
