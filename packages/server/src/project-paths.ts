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
 * `/data/projects-old` a child of `/data/projects`. It does NOT hold for the one
 * parent whose string already ends in a separator — the filesystem root — where
 * appending would ask for `"//"` and report every child as outside (issue #719).
 * That made the bidirectional overlap guard in `validatePath` fail open in both
 * directions once any project's working dir was `/`, so two keepers could be
 * created with overlapping working trees. Append the separator only when the
 * parent doesn't already end in one.
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Directories beneath which a project may never be linked (issue #720) — the
 * operating system rather than anybody's work.
 *
 * Each entry denies itself and everything under it. The filesystem root is
 * handled separately in {@link isSystemPath}: it is refused by exact match, not
 * by containment, because since #719 EVERY absolute path is "inside" `/`.
 *
 * This is a floor, not an allow-list. The alternative the issue floated —
 * requiring linked paths to sit under a configurable allowed root — is a bigger
 * lever than the problem needs: it adds a config dimension and would invalidate
 * every already-linked project the day it shipped. A denylist only ever refuses
 * paths nobody legitimately links a project at.
 *
 * Deliberately NOT here: `/opt`, `/srv`, `/mnt`, `/tmp`, `/root` and `/var` —
 * each is somewhere a real checkout or notebook plausibly lives (`/var` in
 * particular holds Paddock's own data dir on some boxes, and macOS temp dirs
 * canonicalise under `/private/var`).
 *
 * On most distros `/bin`, `/sbin` and `/lib*` are symlinks into `/usr`;
 * {@link import("./projects.js").ProjectStore.validatePath} canonicalises before
 * checking, so those are caught by the `/usr` entry too. They are listed anyway
 * for the systems where they are real directories.
 */
export const SYSTEM_PATH_DENYLIST = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/proc",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
] as const;

/**
 * Whether a (resolved) path is the filesystem root or sits inside a system
 * directory — the floor beneath which {@link
 * import("./projects.js").ProjectStore.validatePath} refuses to link a project
 * (issue #720).
 *
 * This is a FOOTGUN guard, not a privilege boundary: anyone who can reach the
 * projects API can already create projects and run turns as whoever Paddock runs
 * as. It exists because the failure is silent and the blast radius is large — a
 * linked project's directory becomes a keeper's cwd, that keeper runs
 * `acceptEdits` by default, and a MANAGED project's `contentDir` IS that
 * directory, so the sweeper writes `CLAUDE.md`/`CHANGELOG.md` into it.
 */
export function isSystemPath(candidate: string): boolean {
  const p = path.resolve(candidate);
  if (p === path.parse(p).root) return true;
  return SYSTEM_PATH_DENYLIST.some((root) => isPathInside(p, root));
}

/**
 * Resolve a project's working directory (keeper cwd) from its metadata dir plus
 * whichever backing field is set:
 *
 *  - **`linkedPath`** (issue #206) — the cwd IS that directory, returned
 *    verbatim, used in place with no copy. Applies on BOTH sides of the
 *    managed/unmanaged axis: an unmanaged project links a code checkout you
 *    already have, a managed one nominates where its notes should live.
 *  - **`repo`** (issue #187) — the nested checkout Paddock cloned.
 *  - **neither** — the metadata dir itself.
 *
 * `linkedPath` WINS over `repo`, which is why the two are not mutually exclusive:
 * `repo` alongside a path is an ACQUISITION hint (clone here if the path is
 * missing) plus a remote-match for adoption (`adoptable.ts`, #659) and a re-clone
 * hint for disaster recovery. It never moves the cwd off the nominated path.
 */
export function workingDirFor(dir: string, repo?: string, linkedPath?: string): string {
  if (linkedPath) return linkedPath;
  return repo ? path.join(dir, repoCheckoutName(repo)) : dir;
}

/** The subset of `project.yaml` that decides a project's shape. */
export interface ProjectBacking {
  managed?: boolean;
  repo?: string;
  path?: string;
}

/**
 * Whether Paddock looks after this project's own files — the real axis, and the
 * one that replaced the overloaded `repoBacked` boolean (issue #206).
 *
 * **managed** — Paddock curates `CLAUDE.md` / `OVERVIEW.md` / `CHANGELOG.md`
 * here. This is what "notebook" used to mean.
 * **unmanaged** — the content is code that you or your agents source-control
 * OUTSIDE Paddock. Paddock never writes project files into it.
 *
 * Whether a git repo sits behind it is an INDEPENDENT question (just which of
 * `path`/`repo` are set), not a type. See `docs/DESIGN-backing-store.md` §2 goal
 * 4: the base store is a plain directory and git is an optional layer.
 *
 * ## The default is derived, never constant
 *
 * `managed ?? !(repo || path)` — an absent key means "whatever this project's
 * backing implies". That is load-bearing for the upgrade path: every existing
 * `project.yaml` predates the key, and if absent meant `true`, every existing
 * repo-backed project would flip to managed on upgrade and the sweeper would
 * start writing `CLAUDE.md` into somebody's checkout. New projects write the key
 * explicitly, so the derivation only ever has to serve legacy files.
 */
export function isManaged(backing: ProjectBacking): boolean {
  return backing.managed ?? !(backing.repo || backing.path);
}

/**
 * Where a project's CURATED CONTENT lives — `OVERVIEW.md`, `CHANGELOG.md` and
 * `CLAUDE.md`, the three files the sweeper writes.
 *
 * Content follows the working directory; application state does not. So:
 *
 *  - **managed** ⇒ the working dir. For a classic notebook that IS the metadata
 *    dir (unchanged). For a managed project with an external `path`, the curated
 *    files live out there with the content — an accepted consequence being that
 *    they then do NOT live in the Paddock data dir.
 *  - **unmanaged** ⇒ the metadata dir, always. The working dir is somebody
 *    else's tree and Paddock does not write project files into it; `OVERVIEW.md`
 *    and `CHANGELOG.md` are still curated, just sidecarred (issue #187), and
 *    `CLAUDE.md` is not curated at all (the checkout owns its own).
 *
 * `project.yaml` and `.chats/` are NOT content and never move — see
 * {@link import("./projects.js").ProjectStore.dirFor}.
 */
export function contentDirFor(dir: string, backing: ProjectBacking): string {
  return isManaged(backing) ? workingDirFor(dir, backing.repo, backing.path) : dir;
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
