import { test, expect } from "@playwright/test";
import { createProjectViaUI, seedGithubToken, uniq } from "./helpers";

/**
 * Journey: the "Connect GitHub" device-flow affordance in the Changes header
 * (git server only; PADDOCK_GITHUB_CLIENT_ID is set so github.configured=true).
 *
 * The full device flow hits real GitHub (github.com/login/device + token
 * endpoints), so we do NOT drive it end-to-end. Instead we assert the two
 * deterministic, observable states:
 *   - configured && !connected  → a "Connect GitHub" button.
 *   - connected (token seeded)  → "@login" + a Disconnect button.
 *
 * The push affordance is also asserted (disabled with no remote configured).
 */

test("Changes header shows the 'Connect GitHub' affordance when configured but not connected", async ({
  page,
}) => {
  const slug = await createProjectViaUI(page, { name: uniq("GH Connect") });
  await page.goto(`/projects/${slug}/chat`);
  await page.getByRole("button", { name: /^Changes/ }).click();

  // configured (client id set) + not connected → the Connect GitHub button.
  await expect(page.getByRole("button", { name: /Connect GitHub/i })).toBeVisible({
    timeout: 15_000,
  });
  // "GitHub not configured" must NOT show (the client id IS configured here).
  await expect(page.getByText(/GitHub not configured/i)).toHaveCount(0);
});

test("Push is disabled when no remote is configured", async ({ page }) => {
  const slug = await createProjectViaUI(page, { name: uniq("GH Push") });
  await page.goto(`/projects/${slug}/chat`);
  await page.getByRole("button", { name: /^Changes/ }).click();

  const push = page.getByRole("button", { name: /^Push/ });
  await expect(push).toBeVisible({ timeout: 15_000 });
  // No origin remote in the test repo → push is disabled ("No remote configured").
  await expect(push).toBeDisabled();
});

// HARNESS LIMITATION (not a product bug): GithubAuth caches the token-file read
// in-memory process-wide (github-auth.ts `loadToken` sets `this.cached` on first
// call and never re-stats the file). Once ANY /api/git request runs this server
// instance — which every other git test does — the disconnected status is cached
// and seeding the token file afterward can't surface the "connected" state. We
// can't bust that cache from a spec (would need a server restart or a reload hook
// in packages/server, which this suite must not edit). Marked fixme so the
// affordance is documented without a flaky/false-green assertion; see the bug
// ledger ("GitHub connected-state not E2E-observable").
test.fixme(
  "a seeded GitHub token surfaces the 'connected as @login' + Disconnect state",
  async ({ page }) => {
    seedGithubToken("e2euser");
    const slug = await createProjectViaUI(page, { name: uniq("GH Connected") });
    await page.goto(`/projects/${slug}/chat`);
    await page.getByRole("button", { name: /^Changes/ }).click();
    const login = page.getByText(/@e2euser/);
    const disconnect = page.getByRole("button", { name: /Disconnect/i });
    await expect(login.or(disconnect).first()).toBeVisible({ timeout: 15_000 });
  },
);
