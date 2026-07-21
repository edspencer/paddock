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
