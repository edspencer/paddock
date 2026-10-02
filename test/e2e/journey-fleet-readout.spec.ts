import { test, expect, type Page } from "@playwright/test";
import { startRunningTurn, uniq } from "./helpers";

/**
 * Journey: the fleet readout (#784) — the strip above every route.
 *
 * This exists because the feature had NO test coverage of the state that is the
 * whole point of it. Nothing in the corpus seeds a running turn, so the readout
 * could only ever be seen idle: the one screenshot of it populated came from a
 * preview instance that had accidentally accumulated live turns. A component
 * test can fake a running map, but only this tier can prove the three things
 * that are genuinely end-to-end:
 *
 *   1. a real turn on the real hub reaches the strip at all;
 *   2. the elapsed clock SURVIVES A RELOAD — the entire reason the hub records
 *      `Turn.startedAt`. Nothing below this tier can observe it, because the bug
 *      it fixes is precisely that a fresh page has no memory of the turn;
 *   3. clicking a channel lands in that chat.
 *
 * The e2e server is shared and stateful (`workers: 1`), so this never asserts an
 * exact fleet-wide count — another test's chat may sit in the unread column.
 * Everything keys off a per-test marker or this test's own project name.
 */

const readout = (page: Page) => page.getByTestId("fleet-readout");
const channels = (page: Page) => readout(page).getByTestId("fleet-channel");
const runningCount = (page: Page) => readout(page).getByTestId("fleet-running-value");

/** Create a project through the REST API the modal posts to. Returns its slug. */
async function createProject(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/projects", {
    data: { name, status: "active", domain: [] },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).project.slug as string;
}

/**
 * The running-turn fixture lives in `helpers.ts` as {@link startRunningTurn},
 * not here. #784 called this out as the piece most likely to be skipped: the
 * whole corpus could not produce a live turn, so any future test of live state
 * would have re-derived this by hand — including the two traps it encodes (a
 * chat must already exist before the live turn, and you must not reload to get
 * anywhere, or the socket dies and the readout is honestly empty).
 */
const liveTurn = (page: Page, slug: string, marker: string) =>
  startRunningTurn(page, { slug, marker });

test("the readout is present on every route, and says the fleet is idle when it is", async ({
  page,
}) => {
  // Idle is a state it has to render honestly, not a state it hides in: a strip
  // that disappears cannot be told from a strip that broke.
  await page.goto("/config");
  await expect(readout(page)).toBeVisible();
  await expect(runningCount(page)).toHaveText("0");
  await expect(channels(page)).toHaveCount(0);

  await page.goto("/");
  await expect(readout(page)).toBeVisible();
});

test("a live turn raises a channel with the project, a ticking clock, and a link into the chat", async ({
  page,
}) => {
  const projectName = uniq("FR Live");
  const slug = await createProject(page, projectName);
  const sessionId = await liveTurn(page, slug, uniq("frlive"));

  // The strip is visible from INSIDE the chat too — it is above every route, so
  // there is no need to navigate anywhere to see the fleet.
  const channel = channels(page).filter({ hasText: projectName });
  await expect(channel).toBeVisible({ timeout: 20_000 });
  await expect(runningCount(page)).not.toHaveText("0");

  // The clock is real, and it MOVES. Read it twice across a second boundary:
  // a static "0:00" would pass a mere visibility check.
  const clockText = async () => (await channel.innerText()).replace(/\s+/g, " ");
  const first = await clockText();
  expect(first).toMatch(/\d+:\d\d/);
  await expect.poll(clockText, { timeout: 8_000, intervals: [400] }).not.toBe(first);

  // Clicking the channel lands in that chat, in ITS workspace's URL space.
  await page.goto("/config"); // somewhere with no chat of its own
  await channels(page).filter({ hasText: projectName }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/${sessionId}$`));
});

test("the elapsed clock survives a reload — the reason the hub records the turn's start", async ({
  page,
}) => {
  const projectName = uniq("FR Reload");
  const slug = await createProject(page, projectName);
  await liveTurn(page, slug, uniq("frreload"));

  const channel = () => channels(page).filter({ hasText: projectName });
  await expect(channel()).toBeVisible({ timeout: 20_000 });

  // Let the turn age past the point where a restarted clock is distinguishable
  // from a preserved one. Under ~2s the two are indistinguishable and the test
  // would pass on the bug.
  await page.waitForTimeout(3_000);

  await page.reload();
  await expect(channel()).toBeVisible({ timeout: 20_000 });

  // THE assertion. A fresh page knows nothing about when this turn began except
  // what the server replays in its running snapshot. Before `Turn.startedAt`
  // the only available answer was "now", so every reload restarted every clock
  // at 0:00 and a forty-minute turn looked brand new.
  const seconds = Number((await channel().innerText()).match(/(\d+):(\d\d)/)![2]);
  expect(seconds).toBeGreaterThanOrEqual(2);
});

test("the channel clears when the turn lands, and the strip returns to idle", async ({ page }) => {
  const projectName = uniq("FR Ends");
  const slug = await createProject(page, projectName);
  await liveTurn(page, slug, uniq("frends"));

  const channel = () => channels(page).filter({ hasText: projectName });
  await expect(channel()).toBeVisible({ timeout: 20_000 });

  // The turn ending is a SOCKET event, not a poll — the strip must clear itself
  // without a reload, or the operator is looking at a turn that finished
  // minutes ago.
  await expect(channel()).toHaveCount(0, { timeout: 45_000 });
});

/**
 * A turn that lands while the user is ELSEWHERE does not just vanish from the
 * strip: it becomes a FINISHED channel ("4m ago", warn-toned, flush with the
 * strip), sitting to the right of anything still running, until it is read.
 * Opening it reads it, and it leaves.
 *
 * The user has to be off the chat when the turn lands — an open chat is marked
 * seen continuously, so it would never be unread. Navigated in-app (sidebar
 * Home link), not by page load, so the SPA's socket and the turn both survive.
 */
test("a turn that lands while you are elsewhere stays on the strip as finished until read", async ({
  page,
}) => {
  const projectName = uniq("FR Done");
  const slug = await createProject(page, projectName);
  const sessionId = await liveTurn(page, slug, uniq("frdone"));

  await page.getByRole("complementary").getByRole("link", { name: /^Home/ }).click();
  await expect(page).toHaveURL(/\/$/);

  const live = () => channels(page).filter({ hasText: projectName });
  const finished = () => readout(page).getByTestId("fleet-finished").filter({ hasText: projectName });
  await expect(live()).toBeVisible({ timeout: 20_000 });

  // The turn lands: the running channel goes, a finished one takes its place.
  await expect(live()).toHaveCount(0, { timeout: 45_000 });
  await expect(finished()).toBeVisible({ timeout: 20_000 });
  await expect(finished()).toContainText(/just now|\dm ago/);
  // No ticking clock on it — it is at rest.
  await expect(finished()).not.toContainText(/\d+:\d\d/);
  await expect(finished()).toHaveAttribute("href", new RegExp(`/projects/${slug}/chat/${sessionId}$`));

  // Home's feed agrees: the same chat, as an UNREAD row.
  await expect(
    page.getByTestId("home-attention-chats").locator('button[data-state="unread"]').filter({
      hasText: /./,
    }),
  ).not.toHaveCount(0);

  // Opening it reads it, and the strip lets it go.
  await finished().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/${sessionId}$`));
  await expect(finished()).toHaveCount(0, { timeout: 20_000 });
});
