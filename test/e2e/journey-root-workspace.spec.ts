import { test, expect } from "@playwright/test";
import path from "node:path";
import { createProjectViaUI, paths, seedProject, uniq } from "./helpers";

/**
 * Journey: the ROOT WORKSPACE (#531).
 *
 * The root of a paddock instance is a workspace that ALWAYS exists — no
 * project.yaml gate, no "enable" card, no `__root` sentinel. That inverts the
 * URL space:
 *
 *   `/`          → the root workspace's HOME (a project-like Home pane, with the
 *                  full ProjectView chrome: workspace name heading + tab bar).
 *                  The projects GRID is a SECTION of it, under the root's own
 *                  Chats — embedded, so no standalone `<h1>`/blurb, but its
 *                  "New Project" survives and is the only one in the app.
 *   `/projects`  → a permanent redirect to `/`. It was the grid's own URL for a
 *                  release, so it stays reachable instead of dead-ending.
 *   `/chat`      → a root chat.
 *   `/settings`  → the root workspace's Settings tab — its `project.yaml`, and
 *                  nothing else. Instance-wide config is `/config`, a separate
 *                  screen, because it writes `paddock.config.yaml` and is frozen
 *                  at boot. The two were one stacked tab until they were split.
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

test("root Home carries the projects grid as a section under its own Chats", async ({ page }) => {
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

  // Section order on the root's Home: Chats → Projects → … → Overview. Read in
  // DOM order (the grid's heading is an <h2>, Home's are <h3>, so anything that
  // sorts by heading rank would report the wrong answer).
  const headings = await main.locator("h2, h3").allTextContents();
  const idx = (re: RegExp) => headings.findIndex((h) => re.test(h.trim()));
  expect(idx(/^Chats/)).toBeGreaterThanOrEqual(0);
  expect(idx(/^Chats/)).toBeLessThan(idx(/^Projects/));
  expect(idx(/^Projects/)).toBeLessThan(idx(/^Overview/));
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

  // One nav item in their place, and it goes to `/`. Prefix-matched: Home is the
  // root workspace's row, so its accessible name grows an unread/in-flight count
  // when the root has one (#553) — just like a project row's.
  await sidebar.getByRole("link", { name: /^Home/ }).click();
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

test("the root's Settings tab is an ordinary workspace tab — one pane, and it scrolls", async ({
  page,
}) => {
  await page.goto("/settings");

  // The root's own project.yaml settings, and ONLY those. The instance-wide
  // paddock.config.yaml form used to render beneath this as a second section —
  // two save bars, one page inside another — and, being a fragment that only
  // works as a flex-column child, it was also what stopped this tab scrolling:
  // it grew to full content height, refused to shrink, and squashed the
  // workspace form to ZERO height.
  const workspaceForm = page.getByRole("main").locator("form").first();
  await expect(workspaceForm).toBeVisible();
  expect((await workspaceForm.boundingBox())!.height).toBeGreaterThan(100);
  await expect(page.getByText(/paddock\.config\.yaml/i)).toHaveCount(0);

  // Exactly one save bar on the tab, not two.
  await expect(page.getByRole("button", { name: /Save changes/i })).toHaveCount(1);

  // And the pane scrolls.
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

test("/config is the instance config screen, separate from any workspace's settings", async ({
  page,
}) => {
  await page.goto("/config");

  // Its own page, titled for the file it writes.
  await expect(page.getByRole("heading", { name: "Config", level: 1 })).toBeVisible();
  await expect(page.getByText(/paddock\.config\.yaml/i).first()).toBeVisible();
  // Instance config is frozen at boot, so the restart notice is always up.
  await expect(page.getByText(/take effect only after the server restarts/i)).toBeVisible();
  // Branding lives here — the thing you actually come to this screen for.
  await expect(page.getByText("Accent color")).toBeVisible();

  // It is NOT a workspace: no tab bar, no chat sidebar.
  await expect(page.getByRole("main").getByRole("button", { name: "Chat", exact: true })).toHaveCount(
    0,
  );

  // It scrolls.
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

test("the sidebar's Config link goes to /config, and Settings is not in the sidebar", async ({
  page,
}) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Config", exact: true }).click();
  await expect(page).toHaveURL(/\/config$/);
  await expect(page.getByRole("heading", { name: "Config", level: 1 })).toBeVisible();
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

/**
 * The sidebar's Home link carries the ROOT workspace's unread badge (#553) —
 * the same pill a project row shows, from the same data.
 *
 * Read state is SERVER-authoritative (#488): the client keeps only an in-memory
 * optimistic cache, so every reload re-derives from the server. That is why each
 * assertion here is repeated across a `reload()` — a client-only fix passes the
 * first half of this test and fails the second.
 */
test("an unread root chat puts a count on the sidebar's Home link, and opening it clears it", async ({
  page,
}) => {
  const sidebar = page.getByRole("complementary");
  const homeLink = sidebar.getByRole("link", { name: /^Home/ });
  const badge = homeLink.getByLabel(/unread repl/i);

  // A real root chat with a real completed turn.
  await page.goto("/chat");
  await page.getByPlaceholder(/Message the keeper agent/i).fill("root badge please");
  await page.getByRole("button", { name: /^Send$/ }).click();
  // Match the fake keeper's reply loosely: with preload context on, the echo it
  // acknowledges is the injected `<project-context>` block, not the raw message.
  await expect(page.getByText(/^Acknowledged:/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+$/, { timeout: 15_000 });
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;

  // Read while open ⇒ nothing on Home. A `0` pill here would be the bug.
  await expect(badge).toHaveCount(0);

  // Flag it unread (#458) through the same endpoint the chat-row action posts to,
  // at the ROOT mount — `/api/root/...`, because an empty key cannot ride in a
  // path segment.
  const res = await page.request.post(`/api/root/chats/${sessionId}/unread`, {
    data: { unread: true },
  });
  expect(res.ok()).toBe(true);

  // Off Home (a project route) so nothing auto-marks it seen, and reload so the
  // count is derived from the server rather than from anything in this tab.
  const slug = seedProject({ name: uniq("RW Badge Sibling") });
  await page.goto(`/projects/${slug}/home`);
  await expect(badge).toHaveText("1");

  await page.reload();
  await expect(badge).toHaveText("1");

  // Opening the root chat marks it seen, which also spends the manual flag.
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByText(/^Acknowledged:/).first()).toBeVisible({ timeout: 15_000 });

  // The clear STICKS across a reload from a different route — the check that a
  // client-only fix fails. (A MANUAL flag is only re-read from the next projects
  // payload, so the reload is what proves it; the timestamp case clears in-tab
  // the moment the chat is opened — see AppShell.test.tsx.)
  await page.goto(`/projects/${slug}/home`);
  await page.reload();
  await expect(homeLink).toHaveText("Home");
  await expect(badge).toHaveCount(0);
});

test("the Home badge is the same component as a project row's, and projects keep theirs", async ({
  page,
}) => {
  // One root chat + one project chat, both flagged unread, so the two badges are
  // on screen together and can be compared directly.
  await page.goto("/chat");
  await page.getByPlaceholder(/Message the keeper agent/i).fill("root pill");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/^Acknowledged:/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/chat\/[a-z0-9-]+$/, { timeout: 15_000 });
  const rootSession = new URL(page.url()).pathname.split("/").pop()!;

  const name = uniq("RW Pill");
  const slug = await createProjectViaUI(page, { name, area: "Homelab" });
  await page.goto(`/projects/${slug}/chat`);
  await page.getByPlaceholder(/Message the keeper agent/i).fill("project pill");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/^Acknowledged:/).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+$`), { timeout: 15_000 });
  const projectSession = new URL(page.url()).pathname.split("/").pop()!;

  for (const [base, id] of [
    ["/api/root", rootSession],
    [`/api/projects/${slug}`, projectSession],
  ] as const) {
    expect((await page.request.post(`${base}/chats/${id}/unread`, { data: { unread: true } })).ok()).toBe(
      true,
    );
  }

  // Somewhere neither chat is open, so neither auto-clears.
  await page.goto("/config");
  const sidebar = page.getByRole("complementary");
  const rootPill = sidebar.getByRole("link", { name: /^Home/ }).getByLabel(/unread repl/i);
  const projectPill = sidebar.getByRole("link", { name: new RegExp(name) }).getByLabel(/unread repl/i);
  await expect(rootPill).toHaveText("1");
  // The project row's badge is untouched by any of this — the easiest regression.
  await expect(projectPill).toHaveText("1");

  // Same rendered pill, not a lookalike: identical classes and identical box.
  expect(await rootPill.getAttribute("class")).toBe(await projectPill.getAttribute("class"));
  const rootBox = (await rootPill.boundingBox())!;
  const projectBox = (await projectPill.boundingBox())!;
  expect(Math.round(rootBox.width)).toBe(Math.round(projectBox.width));
  expect(Math.round(rootBox.height)).toBe(Math.round(projectBox.height));

  // Clear both flags again: these specs share one long-lived server, and a root
  // chat left permanently unread would leak a badge into every later test.
  for (const [base, id] of [
    ["/api/root", rootSession],
    [`/api/projects/${slug}`, projectSession],
  ] as const) {
    await page.request.post(`${base}/chats/${id}/seen`, { data: {} });
  }
});
