import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createProjectViaUI, seedProject, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: mobile / phone-sized layout (runs under the `mobile` project →
 * Pixel 5, 393×851, isMobile + hasTouch).
 *
 * The desktop layout stacks fixed sidebars (AppShell w-72 + the in-project
 * w-64 session list / one-off w-60 recent list = ~540px of chrome) which
 * crush a 393px phone. On mobile those become off-canvas DRAWERS behind a
 * hamburger (global nav) and a "Chats"/"Recent" toggle (session lists), and
 * the main content goes full-width. These tests assert that:
 *   - no screen scrolls horizontally (nothing overflows the viewport),
 *   - the global nav is hidden until the hamburger opens it (and closes again),
 *   - the chat composer is reachable without any drawer open,
 *   - the in-project + one-off session lists are reachable as drawers,
 *   - a real turn still sends + streams on a phone.
 *
 * The last test captures screenshots into test/e2e/.mobile-shots/ (gitignored)
 * for eyeballing the result.
 */

const SHOTS = new URL("./.mobile-shots/", import.meta.url).pathname;

/** Horizontal overflow in CSS px (>1 means something is wider than the screen). */
async function hOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("landing: no horizontal overflow; nav drawer opens and closes", async ({ page }) => {
  await page.goto("/");
  // Nothing spills past the right edge of the phone.
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);

  // The hamburger is the only nav affordance up front; the sidebar's actions
  // are off-canvas (translated out of the viewport), not just visually hidden.
  const menu = page.getByRole("button", { name: /Open menu/i });
  await expect(menu).toBeVisible();
  // Scope to the sidebar (`<aside>` = complementary role): the landing page also
  // renders empty-state "New Project" CTAs, so target the drawer's own button.
  const navDrawerAction = page
    .getByRole("complementary")
    .getByRole("button", { name: "New Project" });
  await expect(navDrawerAction).not.toBeInViewport();

  // Tapping the hamburger slides the drawer in → its actions enter the viewport.
  await menu.tap();
  await expect(navDrawerAction).toBeInViewport();

  // Closing it (via the drawer's X) slides it back off-canvas.
  await page.getByRole("button", { name: /Close menu/i }).tap();
  await expect(navDrawerAction).not.toBeInViewport();
});

test("project view: composer reachable; session list is a drawer; a turn sends", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("MOB Proj") });

  // The chat composer is usable with NO drawer open (main pane is full-width).
  const composer = page.getByPlaceholder(/Message the keeper agent/i);
  await expect(composer).toBeInViewport();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);

  // The session list is behind the header "Chats" toggle, not a fixed column.
  const newChat = page.getByRole("button", { name: /^New Chat$/ });
  await expect(newChat).not.toBeInViewport();
  await page.getByRole("button", { name: /Show chats/i }).tap();
  await expect(newChat).toBeInViewport();
  await page.getByRole("button", { name: /Close chats/i }).tap();
  await expect(newChat).not.toBeInViewport();

  // A real turn still streams on a phone.
  await sendChatTurn(page, "hello from a phone");
  await expect(page.getByText(/Acknowledged: hello from a phone/).first()).toBeVisible();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
});

test("one-off chat: composer reachable; Recent is a drawer; a turn sends", async ({ page }) => {
  await page.goto("/chat");
  const composer = page.getByPlaceholder(/Ask anything/i);
  await expect(composer).toBeInViewport();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);

  // Exact text: the sidebar's "New one-off chat" also contains "New one-off".
  const newOneOff = page.getByRole("button", { name: "New one-off", exact: true });
  await expect(newOneOff).not.toBeInViewport();
  await page.getByRole("button", { name: /Show recent chats/i }).tap();
  await expect(newOneOff).toBeInViewport();
  await page.getByRole("button", { name: /Close recent chats/i }).tap();

  await sendChatTurn(page, uniq("OO phone"), { placeholder: /Ask anything/i });
});

test("New Project modal fits the phone (no overflow, Create reachable)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open menu/i }).tap();
  await page.getByRole("complementary").getByRole("button", { name: "New Project" }).tap();
  const form = page.locator("form").filter({ hasText: "New project" });
  await expect(form).toBeVisible();
  await expect(page.getByRole("button", { name: /Create project/i })).toBeInViewport();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}06-new-project-modal.png` });
});

test("Files tab + rich Markdown render on mobile (tables/code/mermaid don't blow out the page)", async ({
  page,
}) => {
  const slug = seedProject({
    name: uniq("MOB Files"),
    group: "house",
    files: {
      "NOTES.md":
        "# Mobile Render Test\n\nA paragraph long enough to wrap across several lines on a " +
        "narrow phone so we can confirm prose reflows without horizontal scrolling of the page.\n\n" +
        "| Column A | Column B | Column C | Column D | Column E | Column F |\n" +
        "|---|---|---|---|---|---|\n" +
        "| alpha | beta | gamma | delta | epsilon | zeta |\n" +
        "| one two | three four | five six | seven | eight nine | ten eleven |\n\n" +
        "```ts\nconst aReallyLongVariableNameThatExceedsTheViewportWidthForSureAndKeepsGoing = " +
        "computeSomething(withArguments, thatAreAlsoQuiteLong, plusEvenMore);\n```\n",
      "DIAGRAM.md":
        "# Flow\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Step Two] --> C[Step Three] --> " +
        "D[Step Four] --> E[Step Five] --> F[Finish]\n```\n",
    },
  });

  // Files list (exact name: each row also has a "Pin NOTES.md" button).
  await page.goto(`/projects/${slug}/files`);
  await expect(page.getByRole("button", { name: "NOTES.md", exact: true })).toBeVisible();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}07-files-list.png`, fullPage: true });

  // Markdown file: wide table + long code line must scroll WITHIN, not overflow the page.
  await page.goto(`/projects/${slug}/files/${encodeURIComponent("NOTES.md")}`);
  await expect(page.getByText(/Mobile Render Test/)).toBeVisible();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}08-file-markdown.png`, fullPage: true });

  // Mermaid diagram must not force the page wider than the phone.
  await page.goto(`/projects/${slug}/files/${encodeURIComponent("DIAGRAM.md")}`);
  await page.waitForTimeout(1800); // mermaid renders async
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}09-file-mermaid.png`, fullPage: true });
});

test("Edit Project modal fits the phone", async ({ page }) => {
  const slug = seedProject({ name: uniq("MOB Edit"), group: "house", summary: "edit me" });
  await page.goto(`/projects/${slug}/files`);
  await page.getByRole("button", { name: /Project actions/i }).first().click();
  await page.getByRole("menuitem", { name: /Edit details/i }).click();
  await expect(page.getByRole("button", { name: /Save changes|Save/i }).first()).toBeInViewport();
  expect(await hOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}10-edit-modal.png` });
});

test("mobile screenshots (visual capture)", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });

  await page.goto("/");
  await page.screenshot({ path: `${SHOTS}01-landing.png`, fullPage: true });

  await page.getByRole("button", { name: /Open menu/i }).tap();
  // Let the 200ms slide-in settle so the capture isn't mid-transition.
  await expect(
    page.getByRole("complementary").getByRole("button", { name: "New Project" }),
  ).toBeInViewport();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}02-nav-drawer.png` });
  await page.getByRole("button", { name: /Close menu/i }).tap();

  await createProjectViaUI(page, { name: uniq("Shot Proj") });
  await page.screenshot({ path: `${SHOTS}03-project-chat.png` });
  await page.getByRole("button", { name: /Show chats/i }).tap();
  await expect(page.getByRole("button", { name: /^New Chat$/ })).toBeInViewport();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}04-project-sessions-drawer.png` });
  await page.getByRole("button", { name: /Close chats/i }).tap();

  await page.goto("/chat");
  await page.screenshot({ path: `${SHOTS}05-oneoff.png` });
});
