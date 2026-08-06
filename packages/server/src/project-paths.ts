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
 * A **workspace key** is a workspace's path RELATIVE to `projectsRoot`.
 *
 * The root workspace's key is the empty string. That is not a sentinel — it is
 * the zero value already present in the key space, and it is what makes the
 * resolution seam vanish instead of branch:
 *
 * ```ts
 * dirFor(key) => path.join(this.root, key)   // path.join(root, "") === root
 * ```
 *
 * The previous design (issue #516) modelled the root as a *project* with a
 * reserved slug `__root`, which forced a `dirFor` branch — duplicated in
 * `project-files.ts`, where it was missed, 404ing every root file route. With a
 * relative-path key there is no branch to forget.
 *
 * A project is a workspace with a non-empty key. Nested workspaces (`repo/sub`)
 * are simply longer relative paths; nothing here assumes a single segment.
 */
export type WorkspaceKey = string;

/** The root workspace's key: its path relative to `projectsRoot` is empty. */
export const ROOT_KEY: WorkspaceKey = "";

/** Whether a key addresses the root workspace (i.e. `projectsRoot` itself). */
export function isRootKey(key: WorkspaceKey): boolean {
  return key === ROOT_KEY;
}

/**
 * The root workspace's name in the **herdctl agent namespace**.
 *
 * This is the one place a sentinel is unavoidable, because that namespace
 * genuinely cannot represent the empty key: herdctl agent names must be
 * non-empty and must satisfy TWO disagreeing patterns — `AGENT_NAME_PATTERN`
 * (`/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`, used by `addAgent`) and the session store's
 * `SAFE_IDENTIFIER_PATTERN` (`/^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/`,
 * which requires a trailing alphanumeric). A bare `keeper-` fails both, and the
 * shape #516 originally proposed (`keeper-__root__`) registered cleanly and then
 * threw PathTraversalError on the first resume.
 *
 * `_root` satisfies both patterns and can never collide with a project, because
 * {@link SLUG_RE} rejects underscores — no slug can equal it.
 *
 * **This is a NAME, not an identity.** A workspace is identified by its relative
 * path ({@link WorkspaceKey}); this encoding exists only at the herdctl
 * boundary, is applied in one function, and keeps the four agent-name builders
 * (`keeper-`/`sweeper-`/`hook-`/`trigger-`) uniform with no root branch.
 */
export const ROOT_AGENT_KEY = "_root";

/** Encode a workspace key for use inside a herdctl agent name. */
export function agentKeyFor(key: WorkspaceKey): string {
  return isRootKey(key) ? ROOT_AGENT_KEY : key;
}

/** Decode a herdctl agent-name segment back to a workspace key. */
export function keyFromAgentKey(agentKey: string): WorkspaceKey {
  return agentKey === ROOT_AGENT_KEY ? ROOT_KEY : agentKey;
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
 * Whether `child` is `parent` itself or lives underneath it. Both are resolved
 * first, so this compares real path strings rather than the caller's spelling
 * (it does NOT follow symlinks — callers that care resolve them beforehand).
 *
 * The `+ path.sep` is load-bearing: a plain `startsWith(parent)` would call
 * `/data/projects-old` a child of `/data/projects`.
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Resolve a project's working directory (keeper cwd) from its metadata dir plus
 * whichever backing field is set. Three shapes:
 *
 *  - **linked** (`linkedPath`, issue #206) — the cwd IS a directory the user
 *    already has (`~/Code/foo`), returned verbatim, used in place with no copy.
 *    Nothing is nested under the metadata dir, so Paddock writes nothing into it.
 *  - **repo-backed** (`repo`, issue #187) — the nested checkout Paddock cloned.
 *  - **notebook** — the metadata dir itself.
 *
 * `linkedPath` WINS over `repo`: the two are deliberately not mutually exclusive
 * (issue #206 findings §4). A linked project may also record a `repo` URL, which
 * stays useful for the adoption matcher's remote-URL check (`adoptable.ts`, #659)
 * and as a re-clone hint for disaster recovery — but it must never trigger a
 * clone or move the cwd off the directory the user pointed at.
 */
export function workingDirFor(dir: string, repo?: string, linkedPath?: string): string {
  if (linkedPath) return linkedPath;
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
