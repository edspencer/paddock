import { test, expect, type Page } from "@playwright/test";
import { createProjectViaUI, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: deep-linking to a single message.
 *
 * ## Why this is a browser test
 *
 * Every interesting part of the feature is a browser fact that a component test
 * cannot reach:
 *
 *  - The uuid in the link is minted by the CLI into the on-disk transcript, so
 *    the link is only real once it has survived the round trip through
 *    `/messages`. A unit test would assert against a uuid it invented itself.
 *  - "Scrolled to the message" is a layout outcome, and it has a specific enemy:
 *    the transcript pins itself to the BOTTOM on every change (`ChatPane`'s
 *    layout effect). If the reveal fails to unpin first, the snap silently wins
 *    and the view sits at the bottom — which looks, in a screenshot, exactly like
 *    a chat that simply opened normally. Hence the control below.
 *  - The rail only exists on RELOADED turns: a live turn carries an ephemeral
 *    `t<n>` id, so the link would break on the next reload and is deliberately
 *    not offered. That distinction only exists across a real page load.
 *
 * ## The controls, and why there are three
 *
 * "In viewport after the deep link" proves nothing on its own. This spec passed
 * against a build with the scroll deliberately deleted, twice, for two different
 * reasons — so each control below is here because its absence produced a green
 * run over a broken feature:
 *
 *  1. The target must be off-screen on a plain open, or the transcript was simply
 *     short enough to have it on screen all along.
 *  2. After landing, the FIRST row must be off-screen. Following a link also
 *     unpins the transcript, and an unpinned transcript that never scrolls sits at
 *     the top — where an early target already is (see TARGET).
 *  3. The navigation must actually be cross-document. `page.goto` to a URL that
 *     differs only by fragment never reloads, and measures Chrome's own fragment
 *     jump against an already-rendered DOM instead of this feature.
 */

/** Enough turns that the top of the transcript is well off-screen. */
const TURNS = 8;

async function seedChat(page: Page): Promise<{ slug: string; sessionId: string }> {
  const slug = await createProjectViaUI(page, { name: uniq("Deep Link") });
  await page.goto(`/projects/${slug}/chat`);
  for (let i = 1; i <= TURNS; i++) {
    await sendChatTurn(page, `message number ${i}`);
  }
  await page.waitForURL(/\/chat\/[a-z0-9-]+$/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;
  return { slug, sessionId };
}

/**
 * The transcript's anchored rows, oldest first.
 *
 * Addressed by the anchor id rather than by text on purpose. A chat's NAME is
 * derived from its first message, so `getByText("message number 1")` also matches
 * the sidebar's chat row — which is always on screen, and quietly turned the
 * off-screen control below into a false failure. Rows carrying `id="m-…"` exist
 * only in the transcript.
 */
function rows(page: Page) {
  return page.locator('[id^="m-"]');
}

/**
 * The link target is a message in the MIDDLE of the transcript, and that is
 * load-bearing rather than arbitrary.
 *
 * Targeting the FIRST message made this spec pass against a build with the scroll
 * deliberately removed. Following a link also UNPINS the transcript (otherwise the
 * bottom-snap cancels the scroll), and an unpinned transcript that never scrolls
 * sits at the top — which is exactly where the first message already is. Only a
 * target that is off-screen at BOTH ends can tell a real scroll from that.
 */
const TARGET = 5;

test.describe("message deep links", () => {
  test("links to a message, and following the link lands on it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { slug, sessionId } = await seedChat(page);

    // Reload: the rail is offered on reloaded turns only, because only those
    // carry the transcript uuid the link is built from.
    await page.reload();
    const row = rows(page).nth(TARGET);
    await expect(row).toBeAttached();
    // Enough rows either side of the target for "off-screen at both ends" below
    // to mean anything.
    expect(await rows(page).count()).toBeGreaterThan(TARGET + 3);

    // --- the control -------------------------------------------------------
    // A freshly-opened chat sits at the bottom, so an early message is off
    // screen. Everything below is meaningless without this holding.
    await expect(row).not.toBeInViewport();

    // --- the pill is a real link ------------------------------------------
    const anchorId = await row.getAttribute("id");
    expect(anchorId).toMatch(/^m-[0-9a-f-]{8,}$/);
    const uuid = anchorId!.slice(2);

    await row.scrollIntoViewIfNeeded();
    await row.hover();
    const pill = row.getByRole("link", { name: /copy a link to this message/i });
    await expect(pill).toBeVisible();
    const href = await pill.getAttribute("href");
    expect(href).toBe(
      `${new URL(page.url()).origin}/projects/${slug}/chat/${sessionId}#m-${uuid}`,
    );

    // --- clicking copies rather than navigating ----------------------------
    await pill.click();
    await expect(row.getByText("Link copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(href);
    // The click did NOT jump anywhere: a plain click is a copy, and the URL is
    // left alone so the address bar never disagrees with what was copied.
    expect(page.url()).not.toContain("#m-");

    // --- following the link, cold ------------------------------------------
    // Away first, and this is not ceremony: `page.goto` to a URL that differs
    // only by FRAGMENT is a same-document navigation. It never reloads, never
    // re-hydrates, and lets the browser scroll to an id that is already in the
    // DOM — so a spec that went straight there measured Chrome's fragment jump
    // and would have passed with this feature's scroll deleted.
    await page.goto("/");
    await page.goto(href!);

    const landed = rows(page).nth(TARGET);
    await expect(landed).toBeInViewport({ timeout: 15_000 });
    expect(await landed.getAttribute("id")).toBe(anchorId);
    // Not merely "not at the bottom": an unpinned transcript that never scrolls
    // sits at the TOP, so the first row must be off-screen too.
    await expect(rows(page).first()).not.toBeInViewport();
    // And it is flashed, so the eye lands on the right row rather than merely
    // somewhere near it. The class comes off after 3.2s, hence the short wait.
    await expect(landed).toHaveClass(/reveal-flash/, { timeout: 5_000 });
  });

  test("lands on the message when history arrives after the document has loaded", async ({
    page,
  }) => {
    // TWO mechanisms can put the target on screen, and the test above cannot
    // separate them: Chrome retries its own fragment scroll while a document is
    // loading, so on a small chat over localhost the browser can get there first.
    // On a real chat — a large transcript over a network — `/messages` lands long
    // after the browser has given up, and ChatPane's reveal is the only thing
    // left. That is the case worth protecting, so the response is held back until
    // well after the document has finished loading.
    const { slug, sessionId } = await seedChat(page);
    await page.reload();
    const anchorId = (await rows(page).nth(TARGET).getAttribute("id"))!;
    expect(anchorId).toMatch(/^m-/);

    let held = 0;
    await page.route("**/chats/*/messages*", async (route) => {
      held++;
      await new Promise((r) => setTimeout(r, 3_000));
      await route.continue();
    });

    // Away first, so the deep link is a real cross-document load (see above).
    await page.goto("/");
    await page.goto(`/projects/${slug}/chat/${sessionId}#${anchorId}`);

    const landed = rows(page).nth(TARGET);
    await expect(landed).toBeInViewport({ timeout: 25_000 });
    expect(await landed.getAttribute("id")).toBe(anchorId);
    await expect(rows(page).first()).not.toBeInViewport();
    // The precondition, asserted rather than assumed: if the transcript was not
    // actually held back, this test is the one above wearing a different name.
    expect(held).toBeGreaterThan(0);
  });

  test("says so when the link points at a message that is gone", async ({ page }) => {
    const { slug, sessionId } = await seedChat(page);
    await page.reload();
    await expect(rows(page).first()).toBeAttached();

    // A well-formed uuid that is simply not in this transcript — what a link
    // survives into after a revert cuts its target away.
    await page.goto(
      `/projects/${slug}/chat/${sessionId}#m-00000000-0000-4000-8000-000000000000`,
    );
    await expect(page.getByText(/isn't in this chat any more/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("offers no link on a live turn", async ({ page }) => {
    const { slug } = await seedChat(page);
    await page.goto(`/projects/${slug}/chat`);
    await page.getByPlaceholder(/Message Claude/i).fill("a brand new turn");
    await page.getByRole("button", { name: /^Send$/ }).click();
    const live = page.getByText("a brand new turn", { exact: true }).first();
    await expect(live).toBeVisible({ timeout: 30_000 });

    // Streamed straight into the DOM, so it has no reload-stable uuid yet and
    // no rail — the same gate that hides fork and revert there.
    await live.hover();
    await expect(page.getByRole("link", { name: /copy a link to this message/i })).toHaveCount(
      0,
    );
  });
});
