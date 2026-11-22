import { test, expect, type Page } from "@playwright/test";
import { startRunningTurn, uniq } from "./helpers";

/**
 * Journey: live status in the browser tab (#958 part 3).
 *
 * The favicon dot rides the real `chat:active` stream, so only
 * this tier proves a real turn reaches them — and that they CLEAR when it lands,
 * which is the half a unit test with a fake running set can't see. The title
 * carries no status (only the favicon does), so every title check here asserts
 * the prefix stays absent. The e2e instance runs the default brand, so "cleared"
 * means the shipped PNG is back.
 *
 * The hidden-tab case fakes `document.visibilityState` (Playwright has no
 * background-tab switch for a single page) and fires the real event, which is
 * exactly what the app listens to.
 */

const icon32 = (page: Page) =>
  page.locator('link[rel~="icon"][sizes="32x32"]').getAttribute("href");

async function createProject(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/projects", {
    data: { name, status: "active", domain: [] },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).project.slug as string;
}

/**
 * Like `startRunningTurn`, but the second turn is `[[HANG]]`: it runs until it is
 * killed, so assertions that need "running" have no window to race. The caller
 * MUST {@link killChat} at the end — DELETE cancels the live turn first (#731).
 */
async function startHangingTurn(page: Page, slug: string, marker: string): Promise<string> {
  await page.goto(`/projects/${slug}/chat`);
  await page.getByPlaceholder(/Message Claude/i).fill(marker);
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/Acknowledged:/).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForURL(/\/chat\/[a-z0-9-]+$/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByPlaceholder(/Message Claude/i).fill("hold forever [[HANG]]");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 15_000 });
  return sessionId;
}

async function killChat(page: Page, slug: string, sessionId: string): Promise<void> {
  await page.request.delete(`/api/projects/${slug}/chats/${sessionId}`);
}

/**
 * A chat with a landed reply, then flagged unread: backlog the tab must NOT count.
 *
 * The flag must be set AFTER the page has stopped looking at the chat. While the
 * chat is open, the SPA marks it seen on open (an explicit `/seen`, which by
 * design clears a manual unread flag, #458) — and that POST can land after ours
 * on a loaded runner, silently un-flagging the backlog (CI run 37148780120). So:
 * leave the chat first, let its in-flight marks drain, THEN flag it, and confirm
 * the server holds the flag before going on.
 */
async function seedUnreadBacklog(page: Page, slug: string, marker: string): Promise<string> {
  await page.goto(`/projects/${slug}/chat`);
  await page.getByPlaceholder(/Message Claude/i).fill(marker);
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/Acknowledged:/).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForURL(/\/chat\/[a-z0-9-]+$/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;
  // Off the chat entirely: no page is left to mark it seen.
  await page.goto("about:blank");
  const chat = async () => {
    const res = await page.request.get(`/api/projects/${slug}/chats`);
    return (await res.json()).chats.find((c: { sessionId: string }) => c.sessionId === sessionId) as
      | { unread?: boolean; lastSeen?: number; lastTurnCompletedAt?: string }
      | undefined;
  };
  // Let the page's own seen marks land first (they were sent before we left).
  // Bounded and non-fatal: a mark the navigation aborted never arrives at all.
  await expect
    .poll(async () => {
      const c = await chat();
      return !!c?.lastTurnCompletedAt && (c.lastSeen ?? 0) >= Date.parse(c.lastTurnCompletedAt);
    }, { timeout: 5_000 })
    .toBe(true)
    .catch(() => {});
  const res = await page.request.post(`/api/projects/${slug}/chats/${sessionId}/unread`, { data: { unread: true } });
  expect(res.ok()).toBe(true);
  // The flag must HOLD, not just appear: read it twice, apart.
  await expect.poll(async () => (await chat())?.unread === true).toBe(true);
  await page.waitForTimeout(500);
  expect((await chat())?.unread).toBe(true);
  return sessionId;
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("a running turn dots the favicon, leaves the title bare, and the dot clears when it lands", async ({
  page,
}) => {
  const name = uniq("TS Run");
  const slug = await createProject(page, name);
  await startRunningTurn(page, { slug, marker: uniq("tsrun") });

  await expect.poll(() => icon32(page), { timeout: 15_000 }).toMatch(/^data:image\/png/);
  await expect(page).toHaveTitle(/ · TS Run/);
  await expect(page).not.toHaveTitle(/^[●✓(]/);

  // [[SLOWTOOL]] holds for ~12s; once it lands the status is gone entirely.
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 40_000 });
  await expect(page).toHaveTitle(/ · TS Run/);
  await expect(page).not.toHaveTitle(/^[●✓(]/);
  await expect.poll(() => icon32(page)).toBe("/icons/favicon-32.png");
});

test("a project page and root Home dot the favicon while running, with no title status", async ({
  page,
}) => {
  const name = uniq("TS Proj");
  const slug = await createProject(page, name);
  await seedUnreadBacklog(page, slug, uniq("tsbacklog"));
  const sessionId = await startHangingTurn(page, slug, uniq("tsproj"));
  try {
    // In-app navigation only — a reload would drop the socket and the running set.
    await page.getByTestId("workspace-tabs").getByRole("button", { name: /^Home/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${slug}/home$`));
    // The backlog is real — the sidebar still counts it…
    await expect(
      page.getByRole("complementary").locator(`a[href="/projects/${slug}"]`).getByLabel(/unread repl/),
    ).toBeVisible({ timeout: 15_000 });
    // …but the tab only says "running" (the dot), and its title carries no status.
    await expect.poll(() => icon32(page), { timeout: 15_000 }).toMatch(/^data:image\/png/);
    await expect(page).toHaveTitle(new RegExp(`^${name} — `));

    // Root Home aggregates the instance, and the shared e2e server holds plenty
    // of other tests' unread chats — none of which may surface as a count.
    await page.getByRole("complementary").getByRole("link", { name: /^Home/ }).click();
    await expect(page).toHaveURL(/\/$/);
    // Root Home's title is the bare brand; losing the project's " — " means it settled.
    await expect(page).not.toHaveTitle(/ — /);
    await expect(page).not.toHaveTitle(/^[●✓(]/);
    await expect(page).not.toHaveTitle(/\(\d+\)/);
    await expect.poll(() => icon32(page)).toMatch(/^data:image\/png/);
  } finally {
    await killChat(page, slug, sessionId);
  }
});

test("a project page dots the favicon for a reply that lands while hidden, and clears when shown", async ({ page }) => {
  const name = uniq("TS Count");
  const slug = await createProject(page, name);
  await seedUnreadBacklog(page, slug, uniq("tscountbacklog"));
  await startRunningTurn(page, { slug, marker: uniq("tscount") });
  await page.getByTestId("workspace-tabs").getByRole("button", { name: /^Home/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/home$`));
  // Hide inside the ~12s [[SLOWTOOL]] window, so the reply lands while hidden.
  await setHidden(page, true);
  // Wait for the reply to LAND: until then the dot is the running one, which
  // showing the tab would not clear. Then the unread dot remains, and the title
  // shows no `(n)` count.
  await expect(page.getByTestId("fleet-running-value")).toHaveText("0", { timeout: 40_000 });
  await expect.poll(() => icon32(page)).toMatch(/^data:image\/png/);
  await expect(page).toHaveTitle(new RegExp(`^${name} — `));

  await setHidden(page, false);
  await expect(page).toHaveTitle(new RegExp(`^${name} — `), { timeout: 10_000 });
  await expect.poll(() => icon32(page)).toBe("/icons/favicon-32.png");
});

test("a reply landing in a hidden tab dots the favicon until the tab is shown, then the SERVER is told", async ({
  page,
}) => {
  const name = uniq("TS Hidden");
  const slug = await createProject(page, name);
  const sessionId = await startRunningTurn(page, { slug, marker: uniq("tshid") });
  // Hide straight away: [[SLOWTOOL]] gives ~12s, and the turn must land while hidden.
  await setHidden(page, true);

  // Every `/seen` POST for this chat, and whether the tab was hidden when it left.
  let hidden = true;
  const seenPosts: Array<{ hidden: boolean }> = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/chats/${sessionId}/seen`)) seenPosts.push({ hidden });
  });

  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 40_000 });
  // Nobody watched it land: a green (non-shipped) favicon, and a bare title.
  await expect.poll(() => icon32(page), { timeout: 10_000 }).toMatch(/^data:image\/png/);
  await expect(page).toHaveTitle(/ · TS Hidden/);
  await expect(page).not.toHaveTitle(/^[●✓(]/);
  // …and the server was NOT told it was seen.
  expect(seenPosts).toEqual([]);

  const seenSent = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/chats/${sessionId}/seen`),
  );
  hidden = false;
  await setHidden(page, false);
  await expect(page).toHaveTitle(/ · TS Hidden/, { timeout: 10_000 });
  await expect(page).not.toHaveTitle(/^[●✓(]/);
  await expect.poll(() => icon32(page)).toBe("/icons/favicon-32.png");
  expect((await seenSent).ok()).toBe(true);
  expect(seenPosts.length).toBeGreaterThan(0);
  expect(seenPosts.every((p) => !p.hidden)).toBe(true);

  // The server-side read state now says read: lastSeen is at or past the turn.
  const res = await page.request.get(`/api/projects/${slug}/chats`);
  const chat = (await res.json()).chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
  expect(chat).toBeTruthy();
  expect(chat.unread ?? false).toBe(false);
  expect(chat.lastSeen).toBeGreaterThanOrEqual(Date.parse(chat.lastTurnCompletedAt));
});
