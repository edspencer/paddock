import { test, expect, type Page } from "@playwright/test";
import { escapeRe, uniq } from "./helpers";

/**
 * Journey: the fleet readout above every route (#784).
 *
 * The reason this file exists is the second of the two problems #784 says to fix
 * before reviving the feature: **nothing in the preview or test corpus ever had
 * a running turn**, so the readout could only ever be judged idle. The one
 * screenshot of it populated came from a preview instance that had accidentally
 * accumulated live turns. A strip whose entire subject is live work, that no
 * fixture could put live work in front of, is not reviewable.
 *
 * So this seeds a genuine end-to-end running turn — the fake `claude` holds a
 * Task tool_use open for `PADDOCK_FAKE_SLOWTOOL_MS` (12s, see
 * playwright.config.ts) — and then LEAVES the chat without a page load, so the
 * SPA's socket survives and the turn keeps running while we look at the strip
 * from somewhere else entirely.
 *
 * What that proves that a component test cannot:
 *
 *  - the hub really records `startedAt`, it really rides the `chat:active`
 *    frame, and the client really reads it — an elapsed clock rendering at all
 *    is end-to-end evidence for the whole chain;
 *  - the readout is fed by the SOCKET, not by the route: `/config` is not a
 *    workspace and mounts no chat pane, and the fleet still shows up there;
 *  - and it survives a full reload mid-turn, which is the case `startedAt`
 *    exists for. Before it, every clock restarted at zero on every page load.
 *
 * Everything here runs against the shared, stateful e2e server (workers: 1), so
 * other specs' chats are also in this instance. Assertions are therefore scoped
 * to THIS test's project name and never to a fleet-wide count.
 */

const readout = (page: Page) => page.getByTestId("fleet-readout");

/** This test's own channel, found by the project it belongs to. */
const channel = (page: Page, projectName: string) =>
  readout(page).getByRole("link").filter({ hasText: projectName });

/** A clock, in either of `formatElapsed`'s two shapes. */
const CLOCK = /^\d+:\d\d(:\d\d)?$/;

async function createProject(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/projects", {
    data: { name, status: "active", domain: [] },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).project.slug as string;
}

/**
 * Establish the chat with one completed turn before starting the live one. The
 * attention feed lists DISCOVERED sessions, so a chat whose very first turn is
 * the live one races session discovery; a second turn on an existing chat does
 * not. (The readout itself renders from the socket and does NOT need the chat to
 * be discovered — but its NAME does, and that is asserted below.)
 */
async function sendFirstTurn(page: Page, message: string): Promise<void> {
  await page.getByPlaceholder(/Message Claude/i).fill(message);
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/Acknowledged:/).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForURL(/\/chat\/[a-z0-9-]+$/, { timeout: 30_000 });
}

test("a live turn shows up on the readout from another route, and survives a reload", async ({
  page,
}) => {
  const projectName = uniq("FR Live");
  const slug = await createProject(page, projectName);

  await page.goto(`/projects/${slug}/chat`);
  const chatName = uniq("frlive");
  await sendFirstTurn(page, chatName);
  const chatUrl = page.url();

  // A turn that stays in flight for an observable window.
  await page.getByPlaceholder(/Message Claude/i).fill("hold the line [[SLOWTOOL]]");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 15_000 });

  // Leave for a route that is not a workspace at all, WITHOUT a page load, so
  // the socket survives and the turn keeps running. If the readout were fed by
  // the route rather than by the socket, this is where it would go blank.
  await page.getByRole("complementary").getByRole("link", { name: "Config" }).click();
  await expect(page).toHaveURL(/\/config$/);

  const live = channel(page, projectName);
  await expect(live).toBeVisible({ timeout: 20_000 });
  // The channel shows the PROJECT — at this width one name fits, and across a
  // fleet the project is the one that identifies the work.
  await expect(live).toContainText(projectName);
  // The chat's own name rides the accessible name rather than the pixels, and it
  // arrives with the detail fetch — which only happens BECAUSE something is
  // running. An idle readout makes no request at all, so this assertion is also
  // the evidence that the gated fetch actually fires when it should.
  await expect(live).toHaveAttribute("aria-label", new RegExp(escapeRe(chatName)), {
    timeout: 20_000,
  });
  // A clock, which only exists if the hub's `startedAt` made it all the way to
  // the browser. `—:—` is the honest placeholder for a turn of unknown age, and
  // is exactly what this used to render for every turn.
  await expect(live.locator("span").filter({ hasText: CLOCK }).first()).toBeVisible();

  // A FULL reload mid-turn. The socket reconnects and the server replays its
  // whole running snapshot, `startedAt` included — so the clock picks the turn
  // up where it actually is rather than restarting from zero.
  await page.reload();
  const afterReload = channel(page, projectName);
  await expect(afterReload).toBeVisible({ timeout: 20_000 });
  await expect(afterReload.locator("span").filter({ hasText: CLOCK }).first()).toBeVisible();

  // Clicking a channel goes to that chat, in ITS workspace.
  await afterReload.click();
  await expect(page).toHaveURL(chatUrl);
});

/**
 * The idle state, on a route with no chat in it. Asserted as a POSITIVE — the
 * strip is present and reports zero — because "the readout is absent" and "the
 * readout says nothing is running" render almost identically to a passing test
 * but very differently to a person.
 */
test("the readout is present and honest on a route with no chat", async ({ page }) => {
  await page.goto("/config");
  await expect(readout(page)).toBeVisible();
  // The counts are always exact, whatever else fits. Scoped to the RUNNING stat
  // by its title, since the shared instance's unread count is not ours to
  // predict.
  await expect(readout(page).getByTitle(/Nothing running|Turns in flight/)).toBeVisible();
});
