/**
 * Shared E2E helpers for the comprehensive journey-*.spec.ts suite.
 *
 * Two seeding strategies are used across the suite:
 *  1. **UI / API**: drive the real browser, or POST to the running server's REST
 *     API (the most realistic path — exercises the same code the UI does).
 *  2. **On-disk**: write project dirs + files directly under the server's
 *     CANONICAL projects root. A paddock "project" is just a directory with a
 *     `project.yaml`, so this is a faithful way to seed files (markdown, html,
 *     mermaid) the keeper agent would have authored — without a real Claude.
 *
 * The server canonicalizes its data paths (macOS /var -> /private/var), so we
 * read the resolved paths from `paddock-e2e-paths.json`, which server.mjs writes
 * at boot into PADDOCK_E2E_TMP (default server) / PADDOCK_E2E_GIT_TMP (git one).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export interface E2EPaths {
  tmp: string;
  dataDir: string;
  projectsDir: string;
  home: string;
  git: boolean;
  githubConfigured: boolean;
}

/** Read the canonical paths the (default or git) server wrote at boot. */
export function paths(opts: { git?: boolean } = {}): E2EPaths {
  const tmp = opts.git
    ? process.env.PADDOCK_E2E_GIT_TMP
    : process.env.PADDOCK_E2E_TMP;
  if (!tmp) throw new Error("PADDOCK_E2E_TMP not set (run via playwright.config.ts)");
  const file = path.join(tmp, "paddock-e2e-paths.json");
  if (!existsSync(file)) {
    throw new Error(`server has not written ${file} yet — is the webServer up?`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as E2EPaths;
}

/** Slugify the same way the server does (projects.ts slugify). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SeedProjectInput {
  name: string;
  slug?: string;
  group?: string;
  status?: string;
  domain?: string[];
  summary?: string;
  pinned?: string[];
  model?: string;
  hasOverview?: boolean;
  /** Extra files to drop in the project dir: { "diagram.md": "..." }. */
  files?: Record<string, string>;
}

/**
 * Seed a project directly on disk under the server's projects root. Returns the
 * slug. The server reads the directory on the next /api/projects call (no
 * restart needed — the store lists the dir live). NOTE: a keeper agent is NOT
 * registered this way, so chats can't be SENT to a disk-seeded project; use it
 * for grid/files/metadata journeys. For chat journeys, create via the UI/API so
 * the keeper agent is wired up.
 */
export function seedProject(input: SeedProjectInput, opts: { git?: boolean } = {}): string {
  const { projectsDir } = paths(opts);
  const slug = input.slug ?? slugify(input.name);
  const dir = path.join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });

  const yaml: Record<string, unknown> = {
    name: input.name,
    slug,
    status: input.status ?? "active",
    domain: input.domain ?? [],
    visibility: "public",
    started: today(),
    updated: today(),
    summary: input.summary ?? "",
    links: [],
    pinned: input.pinned ?? [],
  };
  if (input.group) yaml.group = input.group;
  if (input.model) yaml.model = input.model;

  writeFileSync(path.join(dir, "project.yaml"), toYaml(yaml), "utf8");
  writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    `# Changelog — ${input.name}\n\n## ${today()}\n- Project opened.\n`,
    "utf8",
  );
  if (input.hasOverview) {
    writeFileSync(path.join(dir, "OVERVIEW.md"), `# ${input.name}\n\nSeeded overview.\n`, "utf8");
  }
  for (const [name, content] of Object.entries(input.files ?? {})) {
    const file = path.join(dir, name);
    // Support nested seed paths (e.g. "design/plan.md") for the Files-subdir
    // browsing journey (#259) by creating any parent directories first.
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return slug;
}

/** Write a single file into an existing project dir (e.g. to create git changes). */
export function writeProjectFile(
  slug: string,
  name: string,
  content: string,
  opts: { git?: boolean } = {},
): string {
  const { projectsDir } = paths(opts);
  const file = path.join(projectsDir, slug, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

/** Commit everything currently in the git-enabled projects root (setup helper). */
export function gitCommitAll(message: string): void {
  const { projectsDir } = paths({ git: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
  };
  execFileSync("git", ["add", "-A"], { cwd: projectsDir, env, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=E2E", "commit", "-m", message], {
    cwd: projectsDir,
    env,
    stdio: "ignore",
  });
}

/** Seed a stored GitHub token so the affordance renders "connected as @login". */
export function seedGithubToken(login: string): void {
  const { dataDir } = paths({ git: true });
  writeFileSync(
    path.join(dataDir, "github-auth.json"),
    JSON.stringify({ access_token: "ghp_e2e_fake_token", login, scope: "repo" }),
    "utf8",
  );
}

/** Remove the stored GitHub token (back to the "connect" affordance). */
export function clearGithubToken(): void {
  const { dataDir } = paths({ git: true });
  const file = path.join(dataDir, "github-auth.json");
  try {
    writeFileSync(file, JSON.stringify({}), "utf8");
  } catch {
    /* ignore */
  }
}

// ── small YAML emitter (avoids adding a dep; covers the project.yaml shape) ──
function toYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
      }
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function yamlScalar(v: unknown): string {
  const s = String(v);
  if (s === "" ) return '""';
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

// ── root-workspace read state ────────────────────────────────────────────────

/**
 * One entry of the sidebar badge's feed: `root.chatTurns` from `GET
 * /api/projects` (see `buildChatTurns` in the server's projects route).
 */
interface ChatTurn {
  sessionId: string;
  lastTurnCompletedAt: string;
  lastSeen?: number;
  unread?: boolean;
}

/** The ROOT workspace's badge feed — the exact input the Home pill counts. */
async function rootChatTurns(page: Page): Promise<ChatTurn[]> {
  const res = await page.request.get("/api/projects");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { root?: { chatTurns?: ChatTurn[] } | null };
  return body.root?.chatTurns ?? [];
}

/**
 * The badge's own rule, mirrored: a chat counts as unread if the user manually
 * flagged it (#458) or a reply landed since they last saw it (#189). Same
 * expression as `useProjectBadges` in AppShell.tsx.
 */
function countsAsUnread(t: ChatTurn): boolean {
  return t.unread === true || Date.parse(t.lastTurnCompletedAt) > (t.lastSeen ?? 0);
}

/**
 * Zero the ROOT workspace's unread badge, and don't return until the server
 * agrees (#612).
 *
 * Home's pill is a GLOBAL count over every root chat, and these specs share one
 * long-lived server (workers: 1), so any earlier spec that left a root chat
 * unread — manually flagged, or merely holding a completed turn it navigated
 * away from before the pane could mark it seen — is added to it. A spec that
 * asserts an exact count therefore has to establish its own starting point
 * rather than inherit one; re-running until the surrounding suite happens not to
 * pollute it is not a fix.
 *
 * Two things have to be true, in this order:
 *
 *  1. **Nothing root-side is mid-turn.** A running chat is deliberately NOT
 *     counted as unread (it hasn't landed a reply yet), so sweeping it now
 *     achieves nothing: it lands a turn moments later with a completion newer
 *     than the `lastSeen` we just wrote, and re-dirties the badge behind us.
 *     Home has held a WebSocket even with no chat open since #599/#607, so such
 *     a late completion now reaches the pill live, without a reload.
 *  2. **Every chat the badge can see has been marked seen.** `/seen` also spends
 *     the manual unread flag, so one sweep covers both halves of the rule.
 *
 * Read back through the same feed the badge reads, so "clean" means clean by the
 * component's own definition and not by ours.
 */
export async function clearRootUnread(page: Page): Promise<void> {
  // (1) `projectSlug === ""` — the root's key IS the empty string, so a
  // truthiness test here would match every root chat and wait forever.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/root/chats/attention");
        expect(res.ok()).toBe(true);
        const att = (await res.json()) as { running: { projectSlug: string }[] };
        return att.running.filter((c) => c.projectSlug === "").length;
      },
      { timeout: 45_000, intervals: [500] },
    )
    .toBe(0);

  // (2) Sweep, then re-derive. Looped because a turn can still land between the
  // read and the POST; it converges as soon as a whole pass finds nothing.
  await expect
    .poll(
      async () => {
        for (const t of (await rootChatTurns(page)).filter(countsAsUnread)) {
          const res = await page.request.post(`/api/root/chats/${t.sessionId}/seen`, { data: {} });
          expect(res.ok()).toBe(true);
        }
        return (await rootChatTurns(page)).filter(countsAsUnread).length;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(0);
}

// ── UI helpers ───────────────────────────────────────────────────────────────

/** Create a project via the New Project modal, picking an optional area + tags. */
export async function createProjectViaUI(
  page: Page,
  opts: { name: string; area?: string; summary?: string; tags?: string; status?: string },
): Promise<string> {
  // New Project lives on the SIDEBAR's Projects header now (#599): the projects
  // grid that used to host the app's only "New Project" was deleted from root
  // Home, and the button moved to where the project list actually is. The modal
  // hangs off AppShell, so it opens from anywhere — `/` is just a stable start.
  await page.goto("/");
  const plus = page.getByRole("complementary").getByRole("button", { name: "New Project" });
  // On a phone the sidebar is OFF-CANVAS: the button is rendered and "visible"
  // in Playwright's sense, just translated outside the viewport, so a click on
  // it spins until the test times out. The hamburger slides the drawer in.
  //
  // Keyed on the button's own box rather than on whether a hamburger is showing:
  // the hamburger is `md:hidden`, so a one-shot visibility read taken before the
  // shell has laid out answers "no" on a phone and skips the drawer. Waiting for
  // this button to render first makes the measurement meaningful on both.
  await expect(plus).toBeVisible();
  const box = await plus.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  if (!box || box.x < 0 || box.x + box.width > width) {
    await page.getByRole("button", { name: /Open menu/i }).click();
    await expect(plus).toBeInViewport();
  }
  await plus.click();
  const dialog = page.locator("form").filter({ hasText: "New project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill(opts.name);
  if (opts.summary) await dialog.getByPlaceholder(/One line on what/i).fill(opts.summary);
  if (opts.tags) await dialog.getByPlaceholder(/home, plumbing/i).fill(opts.tags);
  if (opts.area) {
    await dialog.getByRole("combobox").first().selectOption({ label: opts.area });
  }
  await dialog.getByRole("button", { name: /Create project/i }).click();
  await page.waitForURL(/\/projects\/[a-z0-9-]+/);
  return slugify(opts.name);
}

/**
 * Send one chat turn in the currently-open ChatPane and wait for the reply.
 * By default it waits for the fake's echo ("Acknowledged: <message>"); pass
 * `expectReply` for messages that hit a different built-in rule (e.g. the
 * codeword continuity rules, which reply differently).
 */
export async function sendChatTurn(
  page: Page,
  message: string,
  opts: { placeholder?: RegExp; expectReply?: RegExp } = {},
): Promise<void> {
  const composer = page.getByPlaceholder(opts.placeholder ?? /Message Claude/i);
  await composer.fill(message);
  await page.getByRole("button", { name: /^Send$/ }).click();
  const reply = opts.expectReply ?? new RegExp(`Acknowledged: ${escapeRe(message)}`);
  await page.getByText(reply).first().waitFor({ timeout: 30_000 });
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A unique-ish suffix so parallel/independent tests never collide on names. */
let n = 0;
export function uniq(prefix: string): string {
  n += 1;
  return `${prefix} ${Date.now().toString(36)}${n}`;
}
