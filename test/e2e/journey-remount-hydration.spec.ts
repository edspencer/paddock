import { test, expect, type Page } from "@playwright/test";
import { createProjectViaUI, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: remounting a chat pane while a turn is live (#726).
 *
 * `ChatPane` hydrates a resumed transcript over REST and used to apply the result
 * as a FULL REPLACE. The socket is attached future-only by design (a fresh mount
 * hydrates over REST, so replaying buffered frames would duplicate it), so every
 * live frame arriving between the server READING the transcript and the response
 * reaching the browser was appended to the pane and then thrown away. The effect's
 * `cancelled` flag guards a newer chat SWITCH; it never guarded newer FRAMES.
 *
 * ## Delaying the RESPONSE leg, and why `route.continue()` will not do it
 *
 * On localhost `/messages` answers in 3–7 ms, so the natural window is far too
 * small to hit reliably. It has to be widened artificially — but only on the
 * response leg. Symmetric latency (CDP throttling) does NOT reproduce this, and
 * that is the instructive part: delaying the request too means the server reads
 * the transcript LATER, so the snapshot comes back fresh and there is nothing to
 * lose. The staleness window is the response leg plus the server's post-read work.
 *
 * `await sleep(); route.continue()` looks like a response delay and is not one:
 * Playwright intercepts BEFORE the request is issued, so `continue()` is what
 * sends it — sleeping first delays the REQUEST, which is exactly the symmetric
 * case that cannot reproduce the bug. Verified: `main` passes under that recipe
 * and fails under this one. {@link delayTranscriptResponse} therefore calls
 * `route.fetch()` first (the server reads the transcript NOW), holds the bytes,
 * and only then `fulfill()`s.
 *
 * Real-world incidence is correspondingly low: it needs ~1 s+ of response-leg
 * latency, i.e. a WAN client or a loaded server, not a dev box. This is here
 * because the failure is silent and total — no reply at all, and a sub-agent card
 * spinning forever, until a reload — not because it fires often.
 */

/** How long the transcript snapshot is held. Longer than the fake's SLOWTOOL. */
const RESPONSE_DELAY_MS = 18_000;

/**
 * The composer textarea. Matched on BOTH placeholders: while a turn streams the
 * placeholder flips to "Queue a message to send next…", so a locator pinned to
 * "Message Claude" waits out the very turn these tests act during.
 */
function composerBox(page: Page) {
  return page.getByPlaceholder(/Message Claude|Queue a message/i);
}

/**
 * Issue the transcript request immediately (so the server reads the transcript at
 * the real time) and hold only the RESPONSE for `ms`. See the header for why this
 * is not `await sleep(); route.continue()`.
 */
async function delayTranscriptResponse(page: Page, ms: number): Promise<void> {
  await page.route("**/chats/*/messages*", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await route.fulfill({ response, body });
  });
}

/**
 * The route's own content. This assertion is about a TOOL CARD left spinning, and
 * it used to read the whole page — which the fleet readout (#784) broke by
 * rendering the literal word "running" as the unit on its fleet-wide counter.
 * Scoping it to `<main>` says what it always meant; the readout is chrome and
 * lives outside that landmark.
 */
const transcript = (page: Page) => page.getByRole("main");

/** Leave the chat (which unmounts ChatPane) and navigate straight back to it. */
async function leaveAndReturn(page: Page): Promise<void> {
  await page.getByRole("main").getByRole("button", { name: "Files", exact: true }).click();
  await expect(composerBox(page)).toHaveCount(0);
  await page.goBack();
  await expect(composerBox(page)).toBeVisible();
}

/** A promise that settles when the (possibly delayed) hydration snapshot lands. */
function snapshotLanded(page: Page) {
  return page.waitForResponse((r) => /\/chats\/[^/]+\/messages/.test(r.url()), {
    timeout: 60_000,
  });
}

/**
 * Seed a project with an established session, start a `[[SLOWTOOL]]` turn, remount
 * the pane mid-tool, and return once the delayed snapshot has been applied.
 *
 * The remount is timed so the server reads the transcript AFTER the sub-agent's
 * `tool_use` is on disk but BEFORE its result — the exact shape of the original
 * report, where the snapshot's tool row was still pending and the reconciliation
 * that would have settled it was eaten along with the reply.
 */
async function remountMidTool(page: Page, name: string, delayMs: number) {
  await createProjectViaUI(page, { name: uniq(name) });
  // Establish a session id so navigating back RESUMES (and therefore hydrates)
  // rather than opening a fresh, empty composer.
  await sendChatTurn(page, "establish the session", { expectReply: /Acknowledged:/ });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+/, { timeout: 15_000 });

  await delayTranscriptResponse(page, delayMs);

  const token = `RH${Date.now().toString(36)}`;
  await composerBox(page).fill(`[[SLOWTOOL]] ${token}`);
  await page.getByRole("button", { name: /^Send$/ }).click();
  // Wait for the sub-agent card: the `tool_use` is on disk and the tool is in
  // flight. Everything from here to its result lands inside the stale window.
  await expect(page.getByText("slow research task").first()).toBeVisible({ timeout: 20_000 });

  const snapshot = snapshotLanded(page);
  await leaveAndReturn(page);

  const reply = page.getByText(new RegExp(`Acknowledged: \\[\\[SLOWTOOL\\]\\] ${token}`));
  // The tool completes and the reply streams while the snapshot is still held.
  await expect(reply).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('button[aria-label="Stop"]')).toHaveCount(0, { timeout: 40_000 });

  await snapshot;
  // The bytes have arrived; this is only a render beat for React to apply them,
  // not a race on the network. (There is no text signal to wait on: the earlier
  // turn's text is also this chat's NAME in the list, so it is on screen the whole
  // time and asserting on it would prove nothing.)
  await page.waitForTimeout(750);
  return { token, reply };
}

test("a remount mid-turn keeps the reply that arrived while the snapshot was in flight", async ({
  page,
}) => {
  const { token, reply } = await remountMidTool(page, "RH Remount", RESPONSE_DELAY_MS);

  // On `main` this is where it all disappears: the snapshot was read while the
  // tool was still running, so applying it wholesale removes the reply entirely
  // and rolls the sub-agent card back to "running", where it stays forever.
  await expect(reply, "the assistant's reply survived the hydration snapshot").toBeVisible();
  await expect(page.getByText("slow research task").first()).toBeVisible();
  await expect(
    transcript(page).getByText(/^running$/i),
    "the tool-result reconciliation survived too — no card left spinning",
  ).toHaveCount(0);
  // …and the merge duplicated nothing: the token appears once in the user bubble
  // and once in the echoed reply, not twice over.
  await expect(page.getByText(token)).toHaveCount(2);
});

test("control: with no added latency the same navigation already worked", async ({ page }) => {
  const { token, reply } = await remountMidTool(page, "RH Control", 0);
  await expect(reply).toBeVisible();
  await expect(transcript(page).getByText(/^running$/i)).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(2);
});
