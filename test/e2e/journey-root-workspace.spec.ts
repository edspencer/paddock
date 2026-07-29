import { test, expect } from "@playwright/test";
import path from "node:path";
import { paths, seedProject, uniq } from "./helpers";

/**
 * Journey: the ROOT WORKSPACE (#531).
 *
 * The root of a paddock instance is a workspace that ALWAYS exists — no
 * project.yaml gate, no "enable" card, no `__root` sentinel. That inverts the
 * URL space:
 *
 *   `/`          → the root workspace's HOME (a project-like Home pane, with the
 *                  full ProjectView chrome: workspace name heading + tab bar).
 *                  The projects GRID is its FIRST SECTION — embedded, so no
 *                  standalone `<h1>`/blurb, but the "New Project" / "New chat"
 *                  actions survive, and are now the only ones in the app.
 *   `/projects`  → a permanent redirect to `/`. It was the grid's own URL for a
 *                  release, so it stays reachable instead of dead-ending.
 *   `/chat`      → a root chat.
 *
 * The last one is the regression that shipped in v0.50.0: "New chat" from the
 * front door dead-ended on `Project not found: __root`. It is asserted here as
 * a real, streaming turn — not just a rendered composer.
 */

/** The root workspace's name is its directory's basename (the projects root). */
function rootName(): string {
  return path.basename(paths().projectsDir);
}

test("/ renders the root workspace Home, with the workspace tab bar", async ({ page }) => {
  await page.goto("/");

  // The page heading is the WORKSPACE name (not "Projects" — that page header
  // belonged to the old grid-as-landing-page).
  await expect(page.getByRole("heading", { name: rootName(), level: 1 })).toBeVisible();

  // The full ProjectView tab bar, LED BY Home. There is no Projects tab: the
  // children moved into the Home pane below.
  const main = page.getByRole("main");
  for (const tab of ["Home", "Chat", "Files", "History", "Settings", "Triggers"]) {
    await expect(main.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }
  await expect(main.getByRole("button", { name: "Projects", exact: true })).toHaveCount(0);

  // The Home PANE is what's rendered (its Overview section), and nothing 404s:
  // the root workspace always exists, so there is no "Project not found" path.
  await expect(main.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText(/Project not found/i)).toHaveCount(0);
});

test("root Home leads with the projects grid, embedded as its first section", async ({ page }) => {
  const name = uniq("RW Child");
  seedProject({ name, group: "homelab" });

  await page.goto("/");
  const main = page.getByRole("main");

  // The grid renders on the front door itself — no navigation, no tab click.
  const homelab = page.getByRole("button", { name: /^Homelab/ });
  if ((await homelab.getAttribute("aria-expanded")) === "false") await homelab.click();
  await expect(page.locator("section a.card").filter({ hasText: name })).toBeVisible();

  // It renders INSIDE ProjectView: the workspace heading + tab bar are still
  // there, with Home the active tab.
  await expect(page.getByRole("heading", { name: rootName(), level: 1 })).toBeVisible();
  await expect(main.getByRole("button", { name: "Home", exact: true })).toBeVisible();

  // Embedded ⇒ the grid drops its OWN page header (the duplicate "Projects"
  // `<h1>` + blurb) and its duplicate "New chat" — but keeps New Project, which
  // with the sidebar CTA gone is the only one in the app.
  await expect(page.getByText(/Each project is a directory with its own keeper agent/i)).toHaveCount(
    0,
  );
  await expect(main.getByRole("button", { name: "New Project", exact: true })).toBeVisible();
  // Exactly ONE "New chat" on this screen: Home's Chats-section action. The
  // grid's copy pointed at the same `/chat` and would have been a second button
  // doing the same thing in the same place.
  await expect(main.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);

  // Section order on the root's Home: Projects → Chats → … → Overview.
  const headings = await main.locator("h2, h3").allTextContents();
  const idx = (re: RegExp) => headings.findIndex((h) => re.test(h.trim()));
  expect(idx(/^Projects/)).toBeGreaterThanOrEqual(0);
  expect(idx(/^Projects/)).toBeLessThan(idx(/^Chats/));
  expect(idx(/^Chats/)).toBeLessThan(idx(/^Overview/));
});

test("/projects redirects to root Home, where the list now lives", async ({ page }) => {
  const name = uniq("RW Redirect");
  seedProject({ name, group: "homelab" });

  // The grid's URL for a whole release — bookmarks and old links must still land
  // on the list rather than the route-error screen.
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/$/);
  const homelab = page.getByRole("button", { name: /^Homelab/ });
  if ((await homelab.getAttribute("aria-expanded")) === "false") await homelab.click();
  await expect(page.locator("section a.card").filter({ hasText: name })).toBeVisible();
});

test("the sidebar has a Home link and no New Project / New root chat CTAs", async ({ page }) => {
  const name = uniq("RW Sidebar");
  seedProject({ name });
  // Start somewhere that is NOT `/`, so clicking Home is a real navigation.
  await page.goto("/chat");
  const sidebar = page.getByRole("complementary");

  // The two CTAs are gone; both actions live on root Home now.
  await expect(sidebar.getByRole("button", { name: /New Project/i })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /New root chat/i })).toHaveCount(0);

  // One nav item in their place, and it goes to `/`.
  await sidebar.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("main").getByRole("button", { name: "New Project", exact: true }),
  ).toBeVisible();
});

test("the sidebar 'Projects' label links to root Home", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("complementary").getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("main").getByRole("button", { name: "New Project", exact: true }),
  ).toBeVisible();
});

test("'New chat' from the root Home opens a root chat composer (no 'Project not found')", async ({
  page,
}) => {
  // The v0.50.0 regression: `/` → New chat dead-ended on the `__root` sentinel
  // with "Project not found: __root" instead of a composer. The root workspace
  // always exists now, so the composer is simply there.
  await page.goto("/");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "New chat", exact: true }).click();

  // The root's chat URL is flat + top-level — no slug, no sentinel.
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByText(/Project not found/i)).toHaveCount(0);
  await expect(page.getByText(/not found/i)).toHaveCount(0);

  // A real, usable composer (not an error box, not an "enable the root" card).
  const composer = page.getByPlaceholder(/Message the keeper agent/i);
  await expect(composer).toBeVisible();
  await expect(composer).toBeEditable();
  await expect(main.getByRole("button", { name: /^New Chat$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible();
});

/**
 * KNOWN BROKEN — expected to fail until `packages/web/src/lib/ws.ts` stops
 * treating the root workspace's key as "no project".
 *
 * The server side is correct: a `chat:send` with `projectSlug: ""` runs the root
 * keeper and broadcasts `chat:response` / `chat:complete` back with
 * `projectSlug: ""` (verified directly against the built server over a raw
 * socket). The WEB client then throws those frames away:
 *
 *   // packages/web/src/lib/ws.ts
 *   const slug = msg.payload.projectSlug ?? msg.payload.target;
 *   if (!slug) return;            // "" is falsy → every ROOT frame is dropped
 *
 * So a root chat turn sent, span forever, never rendered a reply, never
 * established its session id in the URL, and never cleared the Stop button.
 *
 * Fixed (the guard now tests for an ABSENT key), but the test is the point:
 * every server-side check passed while this was broken — the turn ran, the
 * transcript was written, the API looked healthy. **Asserting persistence is
 * not asserting that the user sees an answer.**
 */
test("a root chat turn streams its reply back into the pane", async ({ page }) => {
  await page.goto("/chat");
  const composer = page.getByPlaceholder(/Message the keeper agent/i);
  await expect(composer).toBeVisible();

  await composer.fill("hello from the root workspace");
  await page.getByRole("button", { name: /^Send$/ }).click();

  // The fake keeper echoes "Acknowledged: <message>" within ~1s for a project
  // chat; 10s is generous, and keeps the known-failing case cheap.
  await expect(page.getByText(/Acknowledged: hello from the root workspace/).first()).toBeVisible({
    timeout: 10_000,
  });
  // A REAL root chat: the established session id lands in the root's flat URL
  // space (`/chat/:sessionId`, not `/projects/<sentinel>/chat/...`).
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+$/, { timeout: 10_000 });
});

/**
 * The tab-panel LAYOUT regressions. Both of these were invisible to every
 * assertion in the suite — the right elements were in the DOM, with the right
 * text, in the right order. They are only findable by measuring the boxes.
 */
test("the tab strip fits its own box — no phantom vertical scrollbar", async ({ page }) => {
  await page.goto("/");
  const strip = page.getByRole("main").locator("div.overflow-x-auto").first();
  await expect(strip).toBeVisible();

  // `overflow-x: auto` promotes `overflow-y` to `auto`, so the strip IS a
  // vertical scroll container. Its scrollable area is the union of its
  // descendants' border boxes — which the tabs' `-mb-px` overlap used to push
  // 1px past the padding box, growing a scrollbar with nothing to scroll.
  const box = await strip.evaluate((el) => ({
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
    scrollW: el.scrollWidth,
    clientW: el.clientWidth,
  }));
  expect(box.scrollH).toBeLessThanOrEqual(box.clientH);

  // …and the horizontal scrolling the strip exists FOR still works: on a narrow
  // viewport the tabs must overflow sideways rather than wrap or clip.
  await page.setViewportSize({ width: 420, height: 800 });
  await expect(page.getByRole("main").getByRole("button", { name: "Home", exact: true })).toBeVisible();
  const narrow = await strip.evaluate((el) => ({
    scrollW: el.scrollWidth,
    clientW: el.clientWidth,
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));
  expect(narrow.scrollW).toBeGreaterThan(narrow.clientW);
  expect(narrow.scrollH).toBeLessThanOrEqual(narrow.clientH);
});

test("the root's Settings tab shows BOTH sections and both scroll", async ({ page }) => {
  await page.goto("/settings");

  // Section 1: the root's own workspace settings. It used to be squashed to
  // ZERO height by its sibling, so the form was on the page but unreachable —
  // asserting the heading exists would have passed throughout.
  const workspaceForm = page.getByRole("main").locator("form").first();
  await expect(workspaceForm).toBeVisible();
  expect((await workspaceForm.boundingBox())!.height).toBeGreaterThan(100);

  // Section 2: the instance-wide config, below the divider.
  await expect(page.getByText(/paddock\.config\.yaml/i).first()).toBeVisible();

  // Both are taller than their viewports, and both actually scroll. Nothing on
  // this tab scrolled at all before: the instance form's `min-h-0 flex-1`
  // scroller was inert inside a plain <div> wrapper, so it grew to its full
  // content height and no ancestor could scroll it.
  const scrollable = await page.evaluate(() =>
    [...document.querySelectorAll("main *")]
      .filter((el) => {
        const oy = getComputedStyle(el).overflowY;
        return (oy === "auto" || oy === "scroll") && el.clientHeight > 100;
      })
      .map((el) => {
        el.scrollTop = 1e6;
        const max = el.scrollTop;
        el.scrollTop = 0;
        return max;
      })
      .filter((max) => max > 0),
  );
  expect(scrollable.length).toBeGreaterThanOrEqual(2);
});

test("a project's Settings tab still scrolls (the non-root path)", async ({ page }) => {
  const name = uniq("RW ProjSettings");
  const slug = seedProject({ name });
  await page.goto(`/projects/${slug}/settings`);

  await expect(page.getByRole("main").locator("form").first()).toBeVisible();
  // No instance config here — that section is the root's alone.
  await expect(page.getByText(/paddock\.config\.yaml/i)).toHaveCount(0);

  const maxScroll = await page.evaluate(() => {
    const el = [...document.querySelectorAll("main *")].find((e) => {
      const oy = getComputedStyle(e).overflowY;
      return (oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight + 50;
    });
    if (!el) return 0;
    el.scrollTop = 1e6;
    return el.scrollTop;
  });
  expect(maxScroll).toBeGreaterThan(0);
});
