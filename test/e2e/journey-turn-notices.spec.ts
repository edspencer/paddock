import { test, expect } from "@playwright/test";
import { createProjectViaUI, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: turn dead-end notices (issue #329).
 *
 * A keeper turn can stop WITHOUT a normal reply — a subscription/usage-limit hit
 * (a synthetic runtime message), the max-turns cap, or an error. These used to
 * leave the chat looking dead. Each now surfaces a distinct inline notice. The
 * fake `claude` drives each shape via a prompt directive ([[LIMIT]] /
 * [[MAXTURNS]] / [[APIERROR]] — see test/bin/claude).
 */

test("usage-limit hit surfaces a 'Session limit reached' notice (live + on reload)", async ({
  page,
}) => {
  const slug = await createProjectViaUI(page, { name: uniq("TN Limit") });

  await sendChatTurn(page, "keep going [[LIMIT]]", {
    expectReply: /Session limit reached/i,
  });

  // The banner shows the parsed reset time and explains the recurring quota.
  await expect(page.getByText(/after the quota resets/i)).toBeVisible();
  await expect(page.getByText(/7:10pm/i)).toBeVisible();
  // A usage limit is NOT retryable — no Retry/Continue affordance.
  await expect(page.getByRole("button", { name: /retry|continue/i })).toHaveCount(0);

  // The URL now carries the session id; reload and confirm the notice PERSISTS —
  // recovered from the raw transcript on the history-hydration path (the parser
  // otherwise drops the synthetic message).
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), { timeout: 15_000 });
  await page.reload();
  await expect(page.getByText(/Session limit reached/i)).toBeVisible({ timeout: 15_000 });
});

test("max-turns cap surfaces a 'Turn limit reached' notice with a Continue affordance", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("TN MaxTurns") });

  await sendChatTurn(page, "do a lot [[MAXTURNS]]", {
    expectReply: /Turn limit reached/i,
  });
  // Retryable → a Continue button re-drives the keeper.
  await expect(page.getByRole("button", { name: /^continue$/i })).toBeVisible();
});

test("a turn error surfaces 'The turn failed' with a Retry affordance", async ({ page }) => {
  await createProjectViaUI(page, { name: uniq("TN Error") });

  await sendChatTurn(page, "trigger a failure [[APIERROR]]", {
    expectReply: /The turn failed/i,
  });
  await expect(page.getByRole("button", { name: /^retry$/i })).toBeVisible();
});

test("a plain successful turn shows NO turn-failed banner (#329 invariant)", async ({ page }) => {
  await createProjectViaUI(page, { name: uniq("TN OK") });

  // A perfectly ordinary turn — no directive. The reply renders; nothing else.
  await sendChatTurn(page, "hello there", { expectReply: /Acknowledged:/i });

  // No notice banner of ANY kind (usage_limit / max_turns / error) is present.
  await expect(page.locator("[data-notice]")).toHaveCount(0);
  await expect(page.getByText(/The turn failed/i)).toHaveCount(0);
});

test("an error result AFTER a completed reply shows NO 'turn failed' banner (#380)", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("TN ReplyError") });

  // [[REPLYERROR]]: a normal reply streams, THEN the terminal result carries an
  // `error_during_execution` subtype — the live-vs-history asymmetry of #380. The
  // reply must render with NO false "turn failed" banner beneath it (the live path
  // now applies the same "a reply supersedes the dead-end" guard the reload path has).
  await sendChatTurn(page, "keep going [[REPLYERROR]]", { expectReply: /Acknowledged:/i });

  await expect(page.locator("[data-notice]")).toHaveCount(0);
  await expect(page.getByText(/The turn failed/i)).toHaveCount(0);
});

test("a max-turns result AFTER a completed reply shows NO 'turn limit' banner (#380)", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("TN ReplyMaxTurns") });

  // [[REPLYMAXTURNS]]: a normal reply then an `error_max_turns` result. No banner.
  await sendChatTurn(page, "do a lot [[REPLYMAXTURNS]]", { expectReply: /Acknowledged:/i });

  await expect(page.locator("[data-notice]")).toHaveCount(0);
  await expect(page.getByText(/Turn limit reached/i)).toHaveCount(0);
});

test("a turn that RECOVERED from a mid-turn API error shows NO banner (#329 regression)", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("TN Recover") });

  // [[APIRECOVER]]: a normal reply followed by a SUCCESS result stamped
  // `is_error:true` — the exact shape a session-mode turn emits after recovering
  // from a transient "Connection closed mid-response". The reply must render with
  // NO false "turn failed" banner beneath it (the v0.39.0 regression).
  await sendChatTurn(page, "keep going [[APIRECOVER]]", { expectReply: /Acknowledged:/i });

  await expect(page.locator("[data-notice]")).toHaveCount(0);
  await expect(page.getByText(/The turn failed/i)).toHaveCount(0);
});
