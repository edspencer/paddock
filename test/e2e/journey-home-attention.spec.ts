import { test, expect, type Locator, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { paths, seedProject, uniq } from "./helpers";

/**
 * Journey: Home leads with RUNNING + UNREAD (#599).
 *
 * Home used to open on a generic list of recent chats — the same list the
 * sidebar shows in full. It now opens on the two states that want a decision:
 *
 *   1. Running   — chats with a turn in flight        (`home-running-chats`)
 *   2. Unread    — chats holding a reply you've not seen (`home-unread-chats`)
 *   3. Files     — unchanged
 *   4. OVERVIEW.md / CHANGELOG.md — collapsible, persisted per workspace
 *
 * Both feeds come from `GET <base>/chats/attention`, which is scoped to the
 * workspace's SUBTREE. The root workspace's key is `""` and prefixes every
 * workspace key, so the SAME handler and the SAME component make root Home
 * fleet-wide and a project's Home project-scoped. That is the load-bearing
 * property these tests exist to pin: not "the list renders", but that the two
 * mounts of one code path disagree about scope in exactly the intended way.
 *
 * Everything here runs against the shared, stateful e2e server (workers: 1), so
 * root Home carries every OTHER test's chats too. Assertions are therefore
 * always scoped to a per-test marker — never to a count, and never to "the
 * feed is empty" on the root.
 */

/** The root workspace's name is its directory's basename (the projects root). */
function rootName(): string {
  return path.basename(paths().projectsDir);
}

const running = (page: Page) => page.getByTestId("home-running-chats");
const unread = (page: Page) => page.getByTestId("home-unread-chats");

/** One row of a Home feed, found by the marker in its chat name. */
function row(feed: Locator, marker: string): Locator {
  return feed.getByRole("button").filter({ hasText: marker });
}

/** Create a project through the REST API the modal posts to. Returns its slug. */
async function createProject(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/projects", {
    data: { name, status: "active", domain: [] },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).project.slug as string;
}

/**
 * Send one turn in the currently-open composer and wait for the turn to land.
 * Returns the session id the URL settled on — the chat now EXISTS, which is
 * what the attention feed needs (it lists discovered sessions and asks the hub
 * which are live; a session that was never discovered can't appear either way).
 *
 * The reply is matched loosely (`Acknowledged:`) because preload context makes
 * the fake echo the injected `<project-context>` block rather than the raw
 * message — the chat's NAME is still the typed text, which is what the rows key
 * off.
 */
async function sendFirstTurn(page: Page, message: string): Promise<string> {
  await page.getByPlaceholder(/Message Claude/i).fill(message);
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/Acknowledged:/).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForURL(/\/chat\/[a-z0-9-]+$/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/**
 * Get off the open chat before flagging it unread. An OPEN chat is continuously
 * marked seen — the chat list's refresh clears the manual override for whatever
 * is on screen — so a flag set while the chat is open is wiped moments later.
 * `/config` is not a workspace at all, so nothing there can mark anything seen.
 */
async function leaveChat(page: Page): Promise<void> {
  await page.goto("/config");
  await expect(page.getByRole("heading", { name: "Config", level: 1 })).toBeVisible();
}

/** Flag (or clear) a chat unread through the endpoint the row action posts to (#458). */
async function markUnread(
  page: Page,
  base: string,
  sessionId: string,
  unread = true,
): Promise<void> {
  const res = await page.request.post(`${base}/chats/${sessionId}/unread`, { data: { unread } });
  expect(res.ok()).toBe(true);
}

/**
 * The collapsible OVERVIEW.md / CHANGELOG.md toggle on Home.
 *
 * Scoped to buttons that CARRY `aria-expanded`, because the Files section right
 * above lists files of the same names — `getByRole("button", { name: "CHANGELOG.md" })`
 * matches both and trips strict mode.
 */
function notesToggle(page: Page, title: string): Locator {
  return page.getByRole("main").locator("button[aria-expanded]").filter({ hasText: title });
}

/**
 * Put the ROOT workspace's directory back as we found it.
 *
 * Running a root chat makes the sweeper synthesise the root's OVERVIEW.md and
 * CHANGELOG.md, and #599 renders both on root Home — so the synthesised
 * "# Project Overview" becomes a second "Overview" heading on `/` for every
 * later spec in the run. Nothing else in the suite creates a root chat before
 * this file, so these files exist only because of it; removing them keeps this
 * spec from changing what `/` looks like to anyone else.
 */
test.afterAll(() => {
  const { projectsDir } = paths();
  for (const f of ["OVERVIEW.md", "CHANGELOG.md"]) {
    rmSync(path.join(projectsDir, f), { force: true });
  }
});

/** Client-side navigation to root Home — keeps the SPA (and its socket) alive. */
async function goHomeInApp(page: Page): Promise<void> {
  await page.getByRole("complementary").getByRole("link", { name: /^Home/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * Scope: the root's Home is the whole fleet, a project's Home is only itself,
 * and the project-name pill is derived from that difference alone.
 *
 * Two chats holding unread replies — one in a project, one in the ROOT
 * workspace — are enough to pin all three rules at once, because the SAME chat
 * has to be labelled on one Home and bare on the other.
 */
test("root Home is fleet-wide and labels foreign rows; a project's Home is scoped and bare", async ({
  page,
}) => {
  const projectName = uniq("HA Scope");
  const slug = await createProject(page, projectName);
  const projectMarker = uniq("hascope-project");
  const rootMarker = uniq("hascope-root");

  // A project chat with a completed turn…
  await page.goto(`/projects/${slug}/chat`);
  const projectSession = await sendFirstTurn(page, projectMarker);
  await leaveChat(page);
  await markUnread(page, `/api/projects/${slug}`, projectSession);

  // …and a ROOT-workspace chat with one. The root's key is `""`, so its unread
  // endpoint is the `/api/root` mount — an empty key cannot ride in a path
  // segment.
  await page.goto("/chat");
  const rootSession = await sendFirstTurn(page, rootMarker);
  await leaveChat(page);
  await markUnread(page, "/api/root", rootSession);

  // ── root Home: BOTH chats, because `""` prefixes every workspace key ───────
  await page.goto("/");
  const rootUnread = unread(page);
  const projectRow = row(rootUnread, projectMarker);
  const rootRow = row(rootUnread, rootMarker);
  await expect(projectRow).toBeVisible({ timeout: 20_000 });
  await expect(rootRow).toBeVisible();

  // The project's chat is FOREIGN here, so it names its workspace; the root's
  // own chat is not, so it stays bare. (`c.projectSlug !== workspaceSlug`, not a
  // truthiness test — `""` would otherwise label every root chat as foreign.)
  await expect(projectRow).toContainText(projectName);
  await expect(rootRow).not.toContainText(rootName());

  // ── the project's Home: itself only, and nothing to label ─────────────────
  await page.goto(`/projects/${slug}/home`);
  const scopedUnread = unread(page);
  const scopedRow = row(scopedUnread, projectMarker);
  await expect(scopedRow).toBeVisible({ timeout: 20_000 });
  // The root's chat is OUTSIDE this subtree — the whole point of the scoping.
  await expect(row(scopedUnread, rootMarker)).toHaveCount(0);
  // Same chat, same component, no pill: it is not from elsewhere any more.
  await expect(scopedRow).not.toContainText(projectName);

  // Hand the ROOT workspace back the way we found it. The manual flag is
  // per-user server state on a data dir shared by the whole run, and a root chat
  // left flagged unread shows up in every later spec's Home badge count.
  await markUnread(page, "/api/root", rootSession, false);
  await markUnread(page, `/api/projects/${slug}`, projectSession, false);
});

/**
 * The lifecycle: a live turn shows under Running, moves to Unread when it
 * lands, opens in ITS OWN workspace when clicked, and leaves Unread once read.
 *
 * Deliberately one test: these are four observations of one chat moving through
 * one sequence, and splitting them would mean re-manufacturing a live turn
 * three more times (each of which costs a real in-flight window).
 *
 * The turn is driven from the ROOT's Home, so the row is also a FOREIGN row —
 * clicking it must land in the project's URL space, not the root's.
 */
test("a running chat shows under Running, moves to Unread when the turn lands, and opens in its own workspace", async ({
  page,
}) => {
  const projectName = uniq("HA Live");
  const slug = await createProject(page, projectName);
  const marker = uniq("halive");

  // Establish the chat with a normal turn first: the attention feed lists
  // DISCOVERED sessions, so a chat whose very first turn is the live one races
  // session discovery. A second turn on an existing chat has no such race.
  await page.goto(`/projects/${slug}/chat`);
  const sessionId = await sendFirstTurn(page, marker);

  // Now a turn that stays in flight for an observable window (the fake holds a
  // Task tool_use open for PADDOCK_FAKE_SLOWTOOL_MS — see playwright.config.ts).
  await page.getByPlaceholder(/Message Claude/i).fill("hold the line [[SLOWTOOL]]");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 15_000 });

  // Leave for root Home WITHOUT a page load, so the SPA's socket survives and
  // the turn keeps running. (#599 also fixed the reason this could not work:
  // `connect()` was reachable only from `subscribe()`, so landing on Home with
  // no chat pane mounted opened no socket and the running set stayed empty.)
  await goHomeInApp(page);

  // Running is authoritative — the live hub, not a timestamp heuristic.
  const liveRow = row(running(page), marker);
  await expect(liveRow).toBeVisible({ timeout: 20_000 });
  await expect(liveRow).toContainText(projectName); // foreign row ⇒ labelled
  // A chat is never in both feeds: a live turn hasn't landed a reply yet.
  await expect(row(unread(page), marker)).toHaveCount(0);

  // Wait for the turn to actually land. The server moves the chat across on its
  // own — `running` is read from the live hub and `unread` from the completed
  // turn — so this is the real boundary, observed at the contract.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/root/chats/attention");
        const att = (await res.json()) as {
          running: { sessionId: string }[];
          unread: { sessionId: string }[];
        };
        return att.unread.some((c) => c.sessionId === sessionId);
      },
      { timeout: 45_000, intervals: [500] },
    )
    .toBe(true);

  // …and then RE-DERIVE Home from the server rather than trusting the live
  // update. Home's only refetch trigger is the WS running-set moving, and that
  // signal is missed roughly half the time at a turn boundary: the finished chat
  // then sits under "Running" indefinitely and never reaches "Unread" until
  // something remounts the pane. That is a #599 bug, not a property to encode —
  // this reload asserts the SEMANTICS (a landed turn is unread, and is no longer
  // running) without also asserting the broken delivery of it.
  await page.reload();
  const unreadRow = row(unread(page), marker);
  await expect(unreadRow).toBeVisible({ timeout: 20_000 });
  await expect(row(running(page), marker)).toHaveCount(0);

  // Clicking a foreign row navigates into THAT workspace, not this one.
  await unreadRow.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/${sessionId}$`));

  // Reading it clears it: back on root Home the row is gone. Loaded fresh, so
  // this is the SERVER's answer — read state is server-authoritative (#488), and
  // a client-only clear would pass a same-tab check and fail this one.
  await expect(page.getByText(/Acknowledged:/).first()).toBeVisible({ timeout: 20_000 });
  await page.goto("/");
  await expect(unread(page).getByRole("button").filter({ hasText: marker })).toHaveCount(0, {
    timeout: 20_000,
  });
});

/**
 * A brand-new workspace: both feeds empty, in order, with the section furniture
 * Home is supposed to lead with.
 */
test("an idle workspace's Home shows both empty states, the New chat action, and the sections in order", async ({
  page,
}) => {
  const slug = seedProject({
    name: uniq("HA Idle"),
    files: { "OVERVIEW.md": "# Idle\n\nNothing here.", "notes.md": "# Notes" },
  });

  await page.goto(`/projects/${slug}/home`);
  const main = page.getByRole("main");

  await expect(main.getByText("Nothing running right now.")).toBeVisible({ timeout: 20_000 });
  await expect(main.getByText("No unread replies. All caught up.")).toBeVisible();
  // Neither feed's container exists when it is empty — the empty card is not a
  // zero-row list.
  await expect(running(page)).toHaveCount(0);
  await expect(unread(page)).toHaveCount(0);

  // The Running header carries the only "start more work" action on the pane.
  await expect(main.getByRole("button", { name: "New chat", exact: true })).toBeVisible();

  // Section order: what needs me → what is this. (All five are <h3>; read in DOM
  // order rather than by heading rank.)
  const headings = (await main.locator("h3").allTextContents()).map((h) => h.trim());
  const idx = (re: RegExp) => headings.findIndex((h) => re.test(h));
  expect(idx(/^Running/)).toBe(0);
  expect(idx(/^Unread/)).toBe(1);
  expect(idx(/^Files/)).toBeGreaterThan(idx(/^Unread/));
  expect(idx(/^OVERVIEW\.md$/)).toBeGreaterThan(idx(/^Files/));
  expect(idx(/^CHANGELOG\.md$/)).toBeGreaterThan(idx(/^OVERVIEW\.md$/));
});

/**
 * The two curated-notes cards: default expanded, collapsible, and remembered
 * per workspace AND per file. The per-workspace half is the one worth pinning —
 * the collapse state is read in a `useState` initializer, so the sections have
 * to REMOUNT on a workspace switch or a project's fold would leak onto the
 * root's Home.
 */
test("OVERVIEW.md and CHANGELOG.md collapse independently, persist across reload, and don't leak between workspaces", async ({
  page,
}) => {
  const slug = seedProject({
    name: uniq("HA Notes"),
    files: {
      "OVERVIEW.md": "# Overview\n\nThe **hanotesoverview** body.",
      "CHANGELOG.md": "# Changelog\n\nThe **hanoteschangelog** body.",
    },
  });

  await page.goto(`/projects/${slug}/home`);
  const overviewToggle = notesToggle(page, "OVERVIEW.md");
  const changelogToggle = notesToggle(page, "CHANGELOG.md");
  const overviewBody = page.locator("strong", { hasText: "hanotesoverview" });
  const changelogBody = page.locator("strong", { hasText: "hanoteschangelog" });

  // Default expanded, and the markdown is RENDERED (a `**bold**` became a
  // <strong>), not dumped as raw text.
  await expect(overviewToggle).toHaveAttribute("aria-expanded", "true");
  await expect(changelogToggle).toHaveAttribute("aria-expanded", "true");
  await expect(overviewBody).toBeVisible();
  await expect(changelogBody).toBeVisible();

  // Collapse OVERVIEW.md only — per FILE, so the changelog is untouched.
  await overviewToggle.click();
  await expect(overviewToggle).toHaveAttribute("aria-expanded", "false");
  await expect(overviewBody).toHaveCount(0);
  await expect(changelogToggle).toHaveAttribute("aria-expanded", "true");
  await expect(changelogBody).toBeVisible();

  // Persisted, per workspace + file.
  expect(
    await page.evaluate((s) => localStorage.getItem(`paddock:home-collapsed:${s}:overview`), slug),
  ).toBe("1");
  expect(
    await page.evaluate((s) => localStorage.getItem(`paddock:home-collapsed:${s}:changelog`), slug),
  ).not.toBe("1");

  // Survives a reload — the point of persisting it at all.
  await page.reload();
  await expect(overviewToggle).toHaveAttribute("aria-expanded", "false");
  await expect(changelogToggle).toHaveAttribute("aria-expanded", "true");

  // The ROOT's Home has its own fold, still at the default. (The key is
  // `paddock:home-collapsed:<workspaceSlug>:…` and the root's slug is `""`.)
  await page.goto("/");
  await expect(notesToggle(page, "OVERVIEW.md")).toHaveAttribute("aria-expanded", "true", {
    timeout: 20_000,
  });

  // …and coming back, the project's fold is still its own.
  await page.goto(`/projects/${slug}/home`);
  await expect(overviewToggle).toHaveAttribute("aria-expanded", "false");
});

/**
 * The sidebar's Projects header (#599): the project COUNT is gone, replaced by
 * the `+` that opens the New Project modal — which is now the app's ONLY way to
 * create a project, since the grid that used to host that button was deleted
 * from Home.
 */
test("the sidebar's Projects header has no count, and its + creates a project", async ({ page }) => {
  seedProject({ name: uniq("HA Sidebar Sibling") }); // ⇒ a non-zero count, if one existed
  await page.goto("/");
  const sidebar = page.getByRole("complementary");

  // The header row is the label and the `+` and nothing else: the `+` is
  // icon-only, so the row's whole text content is the word "Projects". A
  // surviving count would show up here as a digit.
  const header = sidebar.getByText("Projects", { exact: true }).locator("..");
  await expect(header).toHaveText("Projects");
  const plus = sidebar.getByRole("button", { name: "New Project" });
  await expect(plus).toBeVisible();

  // It really creates a project, and lands in a chat — a brand-new workspace's
  // Home has nothing running and nothing unread, so there is nothing to see on
  // it yet.
  const name = uniq("HA Sidebar New");
  await plus.click();
  const dialog = page.locator("form").filter({ hasText: "New project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill(name);
  await dialog.getByRole("button", { name: /Create project/i }).click();
  await page.waitForURL(/\/projects\/[a-z0-9-]+\/chat$/);
  await expect(page.getByPlaceholder(/Message Claude/i)).toBeVisible();
  // The new project joins the sidebar list immediately (the modal folds it into
  // the shared projects context rather than waiting for a refetch).
  await expect(sidebar.getByRole("link", { name: new RegExp(name) })).toBeVisible();
});
