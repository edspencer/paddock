/**
 * project-paths — pure path/slug/repo helpers + the project error type.
 *
 * Extracted from projects.ts (issue #403): slug + repo-URL validation, the
 * notebook-vs-repo-backed working-directory resolution, the date stamp, and the
 * seed CLAUDE.md template. All pure (only `node:path`), no `ProjectStore` ties.
 * The public helpers (`isValidRepoUrl`/`repoCheckoutName`/`workingDirFor`/
 * `slugify`/`ProjectError`) are re-exported from projects.ts so existing
 * importers keep resolving in one place.
 */
import path from "node:path";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The reserved slug of the ROOT project (issue #516) — the project whose
 * directory IS `projectsRoot` rather than a subdirectory of it.
 *
 * Deliberately underscore-prefixed: {@link SLUG_RE} rejects underscores, so no
 * user-created project can ever collide with it (neither `create()` nor
 * `slugify()` can produce it). `ProjectStore.list()` only reads *subdirectories*
 * of the root, so a `project.yaml` sitting directly at `projectsRoot` is
 * invisible to enumeration — resolution goes through the explicit
 * `dirFor()` branch instead.
 *
 * **Why `__root` and not `__root__`** (the shape #516 originally proposed): the
 * slug becomes a herdctl agent name (`keeper-<slug>`), and herdctl validates
 * agent names against TWO different patterns. `addAgent` uses
 * `AGENT_NAME_PATTERN` (`/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`), which accepts a
 * trailing underscore — but the session store's path-safety guard uses
 * `SAFE_IDENTIFIER_PATTERN` (`/^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/`),
 * which requires the LAST character to be alphanumeric too. So
 * `keeper-__root__` registers cleanly and then throws PathTraversalError the
 * moment a turn resumes a session. A trailing-alphanumeric sentinel satisfies
 * both. See the regression test in `test/unit/root-project.test.ts`.
 *
 * Existence is the gate: with no `<projectsRoot>/project.yaml` there is no root
 * project at all and nothing changes for an existing instance.
 */
export const ROOT_SLUG = "__root";

/** Whether a slug addresses the root project (issue #516). */
export function isRootSlug(slug: string): boolean {
  return slug === ROOT_SLUG;
}

/**
 * Accepted repo-URL shapes for a repo-backed project (issue #187): https(s),
 * ssh (`git@host:owner/repo`), git://, and a local `file://` or absolute path
 * (the last two make deterministic tests possible without a network). Anything
 * else is rejected up front so a bad value never reaches `git clone`.
 */
export const REPO_URL_RE =
  /^(?:https?:\/\/|git:\/\/|ssh:\/\/|file:\/\/|\/|git@[^\s]+:).+/i;

/** Validate a candidate repo URL (issue #187). */
export function isValidRepoUrl(url: string): boolean {
  const u = url.trim();
  return u.length > 0 && u.length <= 512 && REPO_URL_RE.test(u);
}

/**
 * Derive the checkout directory NAME for a repo-backed project from its repo URL
 * (issue #187) — the repo's own basename, sans a trailing `.git`, sanitised to a
 * filesystem-safe token. The keeper's cwd becomes `<projectDir>/<thisName>`, so
 * the cwd basename reads like the repo (e.g. `paddock`). Deterministic (same URL
 * ⇒ same name), which is why `repo` is immutable once set.
 */
export function repoCheckoutName(repo: string): string {
  const cleaned = repo
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const base = cleaned.split(/[/:]/).pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return safe || "repo";
}

/**
 * Resolve a project's working directory (keeper cwd) from its metadata dir + repo
 * URL: the nested checkout for a repo-backed project, else the metadata dir
 * itself for a notebook project (issue #187).
 */
export function workingDirFor(dir: string, repo?: string): string {
  return repo ? path.join(dir, repoCheckoutName(repo)) : dir;
}

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "exists" | "invalid" | "not_directory",
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Minimal seed for a per-project CLAUDE.md (issue #177): the durable-identity
 * layer of the two-level native-context model (instance-wide + per-project
 * CLAUDE.md, loaded natively once #176 lands). Deliberately terse — the sweeper
 * amends it conservatively over time under "Curated notes"; everything a human
 * writes is preserved. OVERVIEW.md holds current state, CHANGELOG.md holds
 * history; this file holds only what the project durably IS and how we work on it.
 */
export function claudeTemplate(name: string, summary: string): string {
  return [
    `# ${name}`,
    "",
    summary?.trim() || "<!-- One-line description of what this project is. -->",
    "",
    "<!--",
    "Durable project identity & conventions — what this project fundamentally is,",
    "key long-lived facts, and how we work on it. Changes rarely. Current state",
    "lives in OVERVIEW.md; per-turn history lives in CHANGELOG.md. Content you",
    "write here is preserved; the curator only APPENDS newly-discovered durable",
    'facts under the "Curated notes" heading below.',
    "-->",
    "",
  ].join("\n");
}
