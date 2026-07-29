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
 *   `/projects`  → the projects GRID, rendered as the root workspace's Projects
 *                  TAB *inside* ProjectView (so: no standalone `<h1>`/blurb, but
 *                  the "New Project" / "New chat" actions survive).
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

  // The full ProjectView tab bar, led by the root-only "Projects" (children) tab.
  const main = page.getByRole("main");
  for (const tab of ["Projects", "Home", "Chat", "Files", "History", "Settings", "Triggers"]) {
    await expect(main.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }

  // The Home PANE is what's rendered (its Overview section), and nothing 404s:
  // the root workspace always exists, so there is no "Project not found" path.
  await expect(main.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText(/Project not found/i)).toHaveCount(0);

  // The grid is NOT on the front door any more.
  await expect(page.locator("section a.card")).toHaveCount(0);
});

test("the Projects tab navigates to /projects and lists the projects (embedded grid)", async ({
  page,
}) => {
  const name = uniq("RW Child");
  seedProject({ name, group: "homelab" });

  await page.goto("/");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);

  // The grid renders: area sections + the seeded project's card.
  const homelab = page.getByRole("button", { name: /^Homelab/ });
  if ((await homelab.getAttribute("aria-expanded")) === "false") await homelab.click();
  await expect(page.locator("section a.card").filter({ hasText: name })).toBeVisible();

  // It renders INSIDE ProjectView: the workspace heading + tab bar are still
  // there, with the Projects tab now the active one.
  await expect(page.getByRole("heading", { name: rootName(), level: 1 })).toBeVisible();
  await expect(main.getByRole("button", { name: "Home", exact: true })).toBeVisible();

  // Embedded ⇒ the grid drops its OWN page header (the duplicate "Projects"
  // `<h1>` + blurb) — but keeps its actions.
  await expect(page.getByText(/Each project is a directory with its own keeper agent/i)).toHaveCount(
    0,
  );
  await expect(main.getByRole("button", { name: "New Project", exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: "New chat", exact: true })).toBeVisible();

  // Deep-linking / reloading /projects lands on the same thing (URL-derived tab).
  await page.reload();
  await expect(page.locator("section a.card").filter({ hasText: name })).toBeVisible();
  await expect(main.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
});

test("the sidebar 'Projects' link goes to the grid at /projects", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("complementary").getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
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
