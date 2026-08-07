/**
 * ProjectStore — the project layer.
 *
 * A "project" is a directory under `projectsRoot` containing:
 *   - project.yaml   (metadata; schema below)
 *   - CHANGELOG.md   (reverse-chron, curator-appended + hand-edited)
 *   - freeform .md / files
 *
 * This mirrors the documented standard at ~/herds/personal/projects/
 * (see _template/ and README.md there). The directory name == slug.
 *
 * The slug-as-directory IS the link to Claude Code sessions: Claude stores
 * transcripts under ~/.claude/projects/<cwd-with-slashes-as-dashes>/, so the
 * keeper agent's working_directory (= the project dir) ties sessions to the
 * project with no extra tagging.
 *
 * The type surface (project.yaml schema + DTOs), the MIME/file-kind helpers, and
 * the pure path/slug helpers were extracted into sibling modules (issue #403) —
 * `project-types.ts`, `project-mime.ts`, `project-paths.ts` — and are re-exported
 * below so every existing `import { ... } from "./projects.js"` keeps resolving.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_MAX_TURNS,
  DEFAULT_DOCKER,
  isKnownModel,
} from "./models.js";
import { cloneRepo } from "./git.js";
import { sanitizeSchedules } from "./schedule-config.js";
import { sanitizeHooks } from "./hook-config.js";
import {
  sanitizeTrigger,
  sanitizeTriggers,
  isValidTriggerName,
} from "./trigger-config.js";
import { sanitizeRecoveryOverride } from "./recovery-config.js";
import { sanitizeCurationOverride } from "./curation-config.js";
import { sanitizeAttachmentsOverride } from "./attachments-config.js";
import {
  PROJECT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  projectSchemaSkip,
} from "./schema-version.js";

// --- re-export barrels (issue #403) ------------------------------------------
// The moved symbols are re-exported from here so external importers keep finding
// them at `./projects.js` — the same one-place-to-import discipline as before.

import {
  IMAGE_MIME,
  VIDEO_MIME,
  DOCUMENT_MIME,
  fileKind,
  contentTypeFor,
} from "./project-mime.js";
export { IMAGE_MIME, VIDEO_MIME, DOCUMENT_MIME, fileKind, contentTypeFor };

import {
  SLUG_RE,
  ROOT_KEY,
  isRootKey,
  isPathInside,
  isManaged,
  contentDirFor,
  isValidRepoUrl,
  repoCheckoutName,
  workingDirFor,
  slugify,
  today,
  claudeTemplate,
  ProjectError,
} from "./project-paths.js";
export {
  ROOT_KEY,
  isRootKey,
  isPathInside,
  isManaged,
  contentDirFor,
  isValidRepoUrl,
  repoCheckoutName,
  workingDirFor,
  slugify,
  ProjectError,
};
import { gitRemotes, normalizeRemote } from "./adoptable.js";

import {
  normalizeLinks,
  type Project,
  type ProjectYaml,
  type ProjectStatus,
  type ProjectVisibility,
  type FileKind,
  type FileEntry,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "./project-types.js";
import * as projectFiles from "./project-files.js";
// Barrel: re-export all type declarations + normalizeLinks + the config-type
// re-exports (PaddockSchedule/PaddockHook/PaddockTrigger/RecoveryOverride/
// AttachmentsOverride) that project-types carries forward.
export * from "./project-types.js";

const PROJECT_FILE = "project.yaml";
const CHANGELOG_FILE = "CHANGELOG.md";
const OVERVIEW_FILE = "OVERVIEW.md";
const CLAUDE_FILE = "CLAUDE.md";

/** Heading under which the sweeper appends newly-discovered durable facts. */
const CLAUDE_CURATED_HEADING = "## Curated notes";

/** Filename of the sidecar `.gitignore` that keeps a nested checkout out of the data repo. */
const GITIGNORE_FILE = ".gitignore";

/**
 * Sanitise a per-project offered-models override (issue #457 Step 2): keep only
 * known catalog ids, trimmed and de-duped, order-preserving. Returns `undefined`
 * when the input isn't a usable non-empty list (absent / not an array / all
 * unknown), so a project with no override — or a corrupt hand-edit — cleanly
 * inherits the instance list rather than persisting/exposing a bad value. The
 * subset-of-instance-list check is enforced separately at PATCH time (the store
 * has no `cfg` handle); this is the shape/known-id backstop.
 */
function sanitizeModelsOverride(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id) || !isKnownModel(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

export class ProjectStore {
  /**
   * @param root The projects root (`cfg.projectsRoot`) — every project's metadata dir.
   * @param dataDir The instance data dir (`cfg.dataDir`), used ONLY to reject a
   *   `path:` that points inside Paddock's own state (issue #206). Optional so the
   *   many tests that construct a bare store keep compiling; when omitted, `root`
   *   alone is the containment check (in the default layout `projectsRoot` is
   *   `<dataDir>/projects`, so it is the tighter of the two anyway).
   * @param log Where non-fatal advisories go — currently only the declared-repo /
   *   actual-remote mismatch on an existing `path` (issue #206), which must be
   *   said out loud rather than silently ignored (#659) but must not fail the
   *   create. Defaults to a no-op so a bare `new ProjectStore(root)` is unchanged.
   */
  constructor(
    private readonly root: string,
    private readonly dataDir?: string,
    private readonly log: { warn: (message: string) => void } = { warn: () => {} },
  ) {}

  /** `${file} ${declaredVersion}` pairs already warned about — see {@link warnOnceAboutSchema}. */
  private readonly schemaWarned = new Set<string>();

  /** Ensure the projects root exists. Call once at startup. */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    // The root workspace always exists, so its transcripts always need ignoring
    // — this is housekeeping, not a feature gate. It writes at most once.
    await this.ensureRootGitignore();
  }

  /**
   * The on-disk directory backing a workspace key.
   *
   * A key is a path RELATIVE to `projectsRoot`, and the root workspace's key is
   * `""` — so `path.join` resolves it with no special case at all. The previous
   * design needed a branch here for a reserved slug, and that branch had to be
   * duplicated in `project-files.ts` (where it was missed, 404ing every root
   * file route). There is now no branch to forget.
   */
  private dirFor(key: string): string {
    return path.join(this.root, key);
  }

  /**
   * Keep the root's `.chats/` out of the backing repo. Root chats are ordinary
   * chats and get the same treatment project chats already do
   * ({@link ensureSidecarGitignore}) — transcripts are append-heavy JSONL and are
   * not tracked anywhere today.
   */
  private async ensureRootGitignore(): Promise<void> {
    const file = path.join(this.root, GITIGNORE_FILE);
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      /* no .gitignore yet */
    }
    const have = new Set(existing.split("\n").map((l) => l.trim()));
    // Tolerate the equivalent forms an instance-wide .gitignore may already use.
    if (have.has("/.chats/") || have.has(".chats/") || have.has(".chats")) return;
    const body = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    await fs.writeFile(
      file,
      `${body}${existing ? "" : "# Paddock instance data repo.\n"}` +
        `# Root chat transcripts (issue #516) — not tracked, like every project's.\n/.chats/\n`,
      "utf8",
    );
  }

  /** List all projects, newest-updated first. Skips `_`-prefixed dirs. */
  async list(): Promise<Project[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const projects: Project[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const p = await this.readSafe(e.name);
      if (p) projects.push(p);
    }
    projects.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    return projects;
  }

  /**
   * Get one workspace by key. Throws `ProjectError("not_found")` if missing.
   *
   * The root key (`""`) always resolves — the instance's own directory is always
   * there — so this never throws for the root.
   */
  async get(slug: string): Promise<Project> {
    const p = await this.readSafe(slug);
    if (!p) throw new ProjectError(`Project not found: ${slug}`, "not_found");
    return p;
  }

  /**
   * Whether a workspace exists. For a project that means a `project.yaml`
   * record; the root workspace always exists, record or not.
   */
  async exists(slug: string): Promise<boolean> {
    if (isRootKey(slug)) return true;
    try {
      await fs.access(path.join(this.dirFor(slug), PROJECT_FILE));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recursively delete `target`, but ONLY if it is strictly inside `projectsRoot`.
   *
   * The single choke point for every recursive delete in this store. Before issue
   * #206 the containment was implicit: everything a project owned — including a
   * repo-backed project's checkout — was nested under `<projectsRoot>/<slug>/`, so
   * `fs.rm(dir, {recursive: true})` could not reach anything that wasn't ours.
   * A LINKED project's working directory is the user's real work repo, outside the
   * root, and that implicit safety is gone.
   *
   * So the check is made explicit and centralised here rather than re-derived at
   * each call site: an `fs.rm` that escapes throws instead of deleting. Every
   * caller already only passes in-root paths — this exists so that stays true
   * when someone later adds another one.
   *
   * `promote()`'s two rollbacks route through here as well. Their target is
   * `<projectsRoot>/<slug>/<checkoutName>`, which is in-root by construction, so
   * the guard is inert there today — that is the point. This is the choke point
   * the comment above promised, and a recursive delete that skips it is exactly
   * the drift it exists to prevent. {@link rollback} is the deliberate exception:
   * it deletes paths that may legitimately sit OUTSIDE the root (a user-nominated
   * clone target), and is safe by a different mechanism — it only ever removes
   * directories this operation created.
   */
  private async rmInsideRoot(target: string): Promise<void> {
    const resolved = path.resolve(target);
    const root = path.resolve(this.root);
    if (resolved === root || !isPathInside(resolved, root)) {
      throw new ProjectError(
        `Refusing to delete outside the projects root: ${target}`,
        "invalid",
      );
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  /**
   * Undo a failed {@link create} by removing the directories it created — and
   * ONLY those.
   *
   * This is the non-negotiable half of the acquisition rules (issue #206). The
   * previous rollback was an unconditional `fs.rm(dir, {recursive, force})` on the
   * slug dir, safe only because everything a project owned was nested inside it.
   * Once `path:` lets a user nominate a clone TARGET, an unconditional recursive
   * delete is a footgun aimed at whatever they typed — a home directory, say. So
   * the caller records what it brought into being and this removes exactly that
   * list; a pre-existing directory is never in it and therefore can never be
   * deleted, no matter how the create failed.
   *
   * Removed deepest-first so a nested pair (slug dir + its checkout) unwinds
   * cleanly. Failures are swallowed: the original error is the one worth
   * reporting, and a rollback that can't finish must not mask it.
   */
  private async rollback(created: string[]): Promise<void> {
    for (const target of [...created].reverse()) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Validate a `path:` (issue #206) and return it canonicalised, along with
   * whether it already exists.
   *
   * This is the ONLY gate between a user-supplied string and a directory Paddock
   * will hand an agent as its cwd (and may `git clone` into), so it is
   * deliberately strict and ordered cheapest-first. It rejects:
   *
   *  - a relative path (a cwd must be unambiguous — it is baked into every
   *    transcript path, and resolving it against the server's cwd is a footgun);
   *  - a path that exists but isn't a directory;
   *  - a path inside `projectsRoot` or the data dir — that is Paddock's own
   *    state, and pointing at it re-creates the nesting this feature exists to
   *    avoid (plus `remove()` would then really delete it);
   *  - a path that is, contains, or sits inside another project's working
   *    directory — two keepers sharing one cwd collide on transcripts (they are
   *    keyed by cwd) and on the working tree itself.
   *
   * It deliberately does NOT reject a directory for not being a git repository.
   * That would be the only mandatory git check in the codebase: everywhere else
   * paddock PROBES and degrades (`GitService.isRepo()` → false, the Changes tab
   * removes itself, commit/push return `{error: "not a repo"}`), and the default
   * E2E server runs on a non-git directory on purpose.
   *
   * A MISSING path is not an error here — it is an acquisition instruction, which
   * {@link acquirePath} resolves. Only the existing-path branch can be
   * canonicalised by `realpath`, so for a missing one the containment checks run
   * against the resolved-but-not-real path plus its nearest existing ancestor —
   * otherwise `/tmp/link -> <projectsRoot>` with a missing leaf would slip past.
   */
  private async validatePath(
    raw: string,
  ): Promise<{ resolved: string; exists: boolean }> {
    const input = raw.trim();
    if (!path.isAbsolute(input)) {
      throw new ProjectError(`Project path must be absolute: ${input}`, "invalid");
    }

    // Resolve symlinks before ANY containment check — otherwise
    // `/tmp/innocent -> <projectsRoot>/victim` would sail through them all. A
    // path that doesn't exist yet can't be realpath'd, so fall back to resolving
    // its nearest existing ancestor and re-appending the missing tail; that keeps
    // a symlinked PARENT from smuggling the target back inside our own state.
    const direct = await fs.realpath(input).catch(() => null);
    const exists = direct !== null;
    const resolved = direct ?? (await this.resolveViaExistingAncestor(input));

    if (exists) {
      const st = await fs.stat(resolved).catch(() => null);
      if (!st?.isDirectory()) {
        throw new ProjectError(`Project path is not a directory: ${input}`, "not_directory");
      }
    }

    if (isPathInside(resolved, this.root)) {
      throw new ProjectError(
        `Project path must be outside the projects root (${this.root}): ${input}`,
        "invalid",
      );
    }
    if (this.dataDir && isPathInside(resolved, this.dataDir)) {
      throw new ProjectError(
        `Project path must be outside the Paddock data dir (${this.dataDir}): ${input}`,
        "invalid",
      );
    }

    // Reject overlap with an existing project's cwd in EITHER direction: pointing
    // at a parent of another project's working dir is just as broken as pointing
    // at a child of one.
    for (const other of await this.list()) {
      const cwd = other.workingDir;
      if (isPathInside(resolved, cwd) || isPathInside(cwd, resolved)) {
        throw new ProjectError(
          `Project path overlaps the working directory of project "${other.slug}" (${cwd}): ${input}`,
          "invalid",
        );
      }
    }

    return { resolved, exists };
  }

  /**
   * Canonicalise a path that does not exist yet, by realpath-ing the deepest
   * ancestor that DOES exist and re-appending the missing segments. Used only by
   * {@link validatePath}, so a clone target under a symlinked parent still gets
   * containment-checked against its real location.
   */
  private async resolveViaExistingAncestor(input: string): Promise<string> {
    let head = path.resolve(input);
    const tail: string[] = [];
    for (;;) {
      const real = await fs.realpath(head).catch(() => null);
      if (real) return path.join(real, ...tail.reverse());
      const parent = path.dirname(head);
      // Hit the filesystem root without finding anything real: nothing left to
      // resolve against, so the already-normalised path is the best answer.
      if (parent === head) return path.resolve(input);
      tail.push(path.basename(head));
      head = parent;
    }
  }

  /**
   * Bring a project's `path` into existence, returning the directories THIS call
   * created so a failure can roll back exactly those and nothing else.
   *
   * The acquisition rules (issue #206):
   *
   *  - path exists ⇒ use it. With `repo` also set, verify the remote matches and
   *    WARN on a mismatch rather than silently ignoring `repo` — that is the #659
   *    bug class (a directory that is a clone of a *different* repo).
   *  - path missing + `repo` ⇒ clone the repo to that path.
   *  - path missing, managed ⇒ create the directory; the user is nominating where
   *    their notes should live, and an empty dir is a valid notebook.
   *  - path missing, unmanaged, no `repo` ⇒ error. There is nothing to acquire
   *    from and an empty directory is not a codebase.
   *
   * **Cleanup rule:** `created` only ever gains directories this call brought into
   * being. A pre-existing directory is never appended, so no rollback can delete
   * one — the target is user-nominated and may be a home directory.
   *
   * `created` is an OUT-parameter rather than a return value on purpose. Returning
   * the list would mean the caller only learns what to clean up on the success
   * path: an `acquirePath` that threw would never hand back the directory it had
   * already made, so a clone that died partway through would orphan it. Recording
   * before the risky step is what makes the rollback complete.
   */
  private async acquirePath(args: {
    resolved: string;
    exists: boolean;
    repo?: string;
    managed: boolean;
    warn: (message: string) => void;
    created: string[];
  }): Promise<void> {
    const { resolved, exists, repo, managed, warn, created } = args;

    if (exists) {
      // Used as-is. Nothing is appended to `created` — this directory is the
      // user's, and it must survive any failure that follows.
      if (repo) await this.warnOnRemoteMismatch(resolved, repo, warn);
      return;
    }

    if (!repo && !managed) {
      throw new ProjectError(
        `Project path does not exist and there is no repo to clone from: ${resolved}`,
        "invalid",
      );
    }

    // From here the directory is ours: record it BEFORE creating it, so a failure
    // midway (a clone that dies after writing some objects) still rolls back.
    created.push(resolved);

    if (repo) {
      try {
        await cloneRepo(repo, resolved);
      } catch (err) {
        throw new ProjectError(
          err instanceof Error ? err.message : `Failed to clone ${repo} to ${resolved}`,
          "invalid",
        );
      }
      return;
    }

    await fs.mkdir(resolved, { recursive: true });
  }

  /**
   * Warn when a directory's git remotes don't include `repo`.
   *
   * Deliberately a warning, not a rejection: the directory the user named is the
   * one they meant, and plenty of legitimate setups (a fork, a mirror, an
   * ssh-vs-https spelling) won't match exactly. But silently ignoring `repo` is
   * how #659 happened, so the mismatch has to be said out loud. A directory with
   * no git at all is not a mismatch — it is just not a repo, which is allowed.
   *
   * Reuses `adoptable.ts`'s reader, which parses `.git/config` directly (no
   * subprocess) and already follows a linked worktree's `gitdir:`/`commondir`
   * pointers, and returns URLs already through {@link normalizeRemote}.
   */
  private async warnOnRemoteMismatch(
    dir: string,
    repo: string,
    warn: (message: string) => void,
  ): Promise<void> {
    const remotes = await gitRemotes(dir);
    if (remotes.length === 0) return;
    if (remotes.includes(normalizeRemote(repo))) return;
    warn(
      `Project path ${dir} is a git repo whose remotes (${remotes.join(", ")}) ` +
        `do not include the declared repo ${repo}. Using the directory as given; ` +
        `the repo URL is recorded as a hint only.`,
    );
  }

  /**
   * Create a project: mkdir + write project.yaml (from template) + seed
   * CHANGELOG.md. Idempotency: throws ProjectError("exists") if the slug
   * directory already holds a project.yaml.
   */
  async create(input: CreateProjectInput): Promise<Project> {
    const name = input.name?.trim();
    if (!name) throw new ProjectError("Project name is required", "invalid");

    const slug = (input.slug?.trim() || slugify(name)) as string;
    if (!SLUG_RE.test(slug)) {
      throw new ProjectError(
        `Invalid slug "${slug}" (must be kebab-case: a-z, 0-9, hyphens)`,
        "invalid",
      );
    }
    if (await this.exists(slug)) {
      throw new ProjectError(`Project already exists: ${slug}`, "exists");
    }

    // Validate the repo URL up front so a bad value never reaches `git clone`
    // and the project isn't half-created (issue #187).
    const repo = input.repo?.trim() || undefined;
    if (repo && !isValidRepoUrl(repo)) {
      throw new ProjectError(`Invalid repo URL: ${repo}`, "invalid");
    }

    const rawPath = input.path?.trim() || undefined;

    // The managed axis (issue #206). Absent input derives the same way a legacy
    // file does, so "what you get by default" is one rule everywhere.
    const managed = isManaged({ managed: input.managed, repo, path: rawPath });

    // Paddock curating its own files INTO a repo it also clones has no sensible
    // meaning, so refuse rather than silently dropping one half. Refusing is the
    // reversible choice: accepting it now and changing what it means later would
    // be a migration.
    if (managed && repo) {
      throw new ProjectError(
        "A managed project cannot have a repo — Paddock would be curating files " +
          "into a checkout it clones. Use managed: false to work in the repo, or " +
          "drop `repo` for a notebook.",
        "invalid",
      );
    }
    if (!managed && !repo && !rawPath) {
      throw new ProjectError(
        "An unmanaged project needs a `path` (a directory to work in) or a `repo` " +
          "(one to clone), or both.",
        "invalid",
      );
    }

    // Validate BEFORE anything is created, so a bad path leaves nothing behind.
    const checked = rawPath ? await this.validatePath(rawPath) : undefined;
    const linkedPath = checked?.resolved;

    const now = today();
    const yaml: ProjectYaml = {
      name,
      slug,
      status: input.status ?? "active",
      domain: input.domain ?? [],
      // Keep `group` off the yaml when empty so unsorted projects round-trip
      // without a noisy `group: ""` line (mirrors the optional `model` handling).
      ...(input.group?.trim() ? { group: input.group.trim().toLowerCase() } : {}),
      visibility: input.visibility ?? "public",
      started: now,
      updated: now,
      summary: input.summary ?? "",
      links: input.links ?? [],
      pinned: [],
      // ALWAYS written explicitly, even though it is optional on disk: the
      // derived default exists to give LEGACY files their old meaning, not to be
      // relied on by files we write ourselves.
      managed,
      // Carry `repo` only when set (same round-trip discipline as model).
      ...(repo ? { repo } : {}),
      // Carry the canonicalised path only when set (issue #206).
      ...(linkedPath ? { path: linkedPath } : {}),
    };

    // Everything this call brings into being, newest last — the ONLY things a
    // failure below is allowed to remove. A pre-existing directory is never in
    // here, which is what stops a rollback deleting a user-nominated target that
    // might be their home directory.
    const created: string[] = [];
    const dir = this.dirFor(slug);
    if (!(await fs.stat(dir).then(() => true).catch(() => false))) created.push(dir);
    await fs.mkdir(dir, { recursive: true });

    try {
      if (linkedPath && checked) {
        // Acquire the nominated path: use it, clone into it, or create it.
        // `created` is threaded in so a mid-acquisition failure still rolls back
        // what was made — see acquirePath.
        await this.acquirePath({
          resolved: linkedPath,
          exists: checked.exists,
          repo,
          managed,
          warn: (message) => this.log.warn(message),
          created,
        });
      } else if (repo) {
        // No path nominated: clone into the nested checkout, as before (#187).
        const checkoutName = repoCheckoutName(repo);
        const checkoutDir = path.join(dir, checkoutName);
        created.push(checkoutDir);
        try {
          await cloneRepo(repo, checkoutDir);
        } catch (err) {
          throw new ProjectError(
            err instanceof Error ? err.message : `Failed to clone ${repo}`,
            "invalid",
          );
        }
        // Keep the nested checkout (a full git repo) OUT of the instance data
        // repo: a sidecar `.gitignore` ignores the checkout dir (git-in-git per
        // #187's option A). `.chats/` is likewise data-repo noise.
        await this.ensureSidecarGitignore(dir, checkoutName);
      }
      await this.finishCreate({ slug, yaml, dir, name, now, managed });
    } catch (err) {
      // ONE rollback covering everything after the slug dir, not just the
      // acquisition: a `writeYaml` or seed-file failure used to leave the
      // directories we had just made (a clone target, a created notes dir) behind
      // with no project to own them.
      await this.rollback(created);
      throw err;
    }

    // No OVERVIEW.md at creation — the first sweep writes it.
    return this.toDto(dir, yaml, false);
  }

  /**
   * Write a new project's `project.yaml` and seed its content files. Split out of
   * {@link create} so the whole sequence sits inside that method's single
   * try/rollback rather than trailing off the end of it.
   */
  private async finishCreate(args: {
    slug: string;
    yaml: ProjectYaml;
    dir: string;
    name: string;
    now: string;
    managed: boolean;
  }): Promise<void> {
    const { slug, yaml, dir, name, now, managed } = args;
    await this.writeYaml(slug, yaml);
    const contentDir = contentDirFor(dir, yaml);
    // The curated trio follows the content (issue #206): for a managed project
    // with an external `path` these land out there rather than in the data dir.
    // `dir` is already made; `contentDir` may be the same directory or the
    // freshly-acquired path, both of which exist by now.
    //
    // Never clobber: a managed `path` may point at a folder of notes that already
    // has a CHANGELOG.md, and seeding "Project opened." over the user's history
    // would be the worst kind of data loss — silent and plausible. For a fresh
    // project dir the file is always absent, so this only bites in the new case.
    const changelogFile = path.join(contentDir, CHANGELOG_FILE);
    const changelogExists = await fs
      .access(changelogFile)
      .then(() => true)
      .catch(() => false);
    if (!changelogExists) {
      await fs.writeFile(
        changelogFile,
        [
          `# Changelog — ${name}`,
          "",
          "<!--",
          "Reverse-chronological. Newest entry on top, under a `## YYYY-MM-DD` heading.",
          "-->",
          "",
          `## ${now}`,
          "- Project opened.",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    // Seed a minimal per-project CLAUDE.md (issue #177) — but ONLY for a MANAGED
    // project, and never over an existing one. An UNMANAGED project's working
    // directory owns its own `CLAUDE.md` (upstream's, in a checkout the user
    // source-controls); the sweeper must never write that file, so we don't seed a
    // competing one. A managed project with an external `path` DOES get one, out
    // there with the rest of its content — but if that directory already has a
    // `CLAUDE.md` (a pre-existing notes folder), it is the user's and stays.
    if (managed) {
      const claudeFile = path.join(contentDir, CLAUDE_FILE);
      const claudeExists = await fs
        .access(claudeFile)
        .then(() => true)
        .catch(() => false);
      if (!claudeExists) {
        await fs.writeFile(claudeFile, claudeTemplate(name, yaml.summary), "utf8");
      }
    }
  }

  /**
   * Promote an existing NOTEBOOK project into a REPO-BACKED one IN PLACE (issue
   * #213), preserving its chats + sidecar metadata. This relaxes #187's create-time
   * `repo` immutability on this ONE path: an existing project (a subdir of the data
   * repo) gains an external git repo as its keeper's working directory.
   *
   * What it does (mirrors `create()`'s repo-backed branch, but non-destructively):
   *   1. Clone the repo into the nested checkout `<dir>/<repo-name>/` — FIRST, so a
   *      clone failure rolls back (rm just the checkout) and leaves the notebook
   *      wholly intact (project.yaml, `.chats/`, OVERVIEW/CHANGELOG untouched).
   *   2. Write the sidecar `.gitignore` (`/<repo-name>/` + `/.chats/`) so the
   *      checkout + transcript store stay out of the data repo.
   *   3. Set `repo:` in project.yaml → the DTO flips to repo-backed and the keeper's
   *      cwd becomes the checkout ({@link workingDirFor}).
   *   4. Drop the sweeper-owned per-project `CLAUDE.md`: a repo-backed project defers
   *      to the repo's OWN `CLAUDE.md` (loaded natively from the checkout). Leaving
   *      the notebook's would leak into the checkout's cwd walk-up (the metadata dir
   *      is an ancestor of the nested checkout) — so it's removed (it survives in the
   *      data repo's git history).
   *
   * The existing chats need NO transcript surgery: they already live in `<dir>/.chats/`;
   * the caller's {@link import("./herdctl.js").HerdctlService.ensureProjectAgent} re-runs
   * `ensureProjectChats(newWorkingDir, dir)` which re-symlinks the new cwd's encoded
   * transcript path at that same `.chats/` store, so every chat stays listed + resumable
   * (issue #213 open-question #1, resolved: Claude Code tolerates recorded-cwd ≠ process-cwd).
   *
   * Guards: throws `ProjectError("invalid")` for a not-yet-notebook (already
   * repo-backed) project or a bad URL, and `ProjectError("exists")` if a
   * `<repo-name>/` directory is already present (never clobber existing files).
   */
  async promote(slug: string, repoUrl: string): Promise<Project> {
    // The root workspace IS `projectsRoot`, already the instance's own backing
    // repo — cloning a second repo inside it is never what's meant.
    if (isRootKey(slug)) {
      throw new ProjectError("The root workspace cannot be repo-backed", "invalid");
    }
    const current = await this.get(slug); // throws not_found
    // Promotion means "start working in a clone of this repo", so it only makes
    // sense for a project Paddock currently manages. An UNMANAGED project already
    // works in code somebody source-controls (issue #206).
    if (!current.managed) {
      throw new ProjectError(
        `Project is already backed by a repo or directory: ${slug}`,
        "invalid",
      );
    }
    // A managed project with its own `path` is a notes folder the user nominated;
    // promoting it would clone into that directory. Say so specifically — the
    // generic message above would be misleading.
    if (current.path) {
      throw new ProjectError(
        `Project "${slug}" keeps its content in ${current.path} and cannot be promoted; ` +
          `create an unmanaged project pointing at the repo instead`,
        "invalid",
      );
    }
    const repo = repoUrl?.trim();
    if (!repo || !isValidRepoUrl(repo)) {
      throw new ProjectError(`Invalid repo URL: ${repoUrl}`, "invalid");
    }
    const dir = current.dir;
    const checkoutName = repoCheckoutName(repo);
    const checkoutDir = path.join(dir, checkoutName);

    // Never clobber an existing dir of that name (e.g. a stray checkout or a real
    // subdirectory of the notebook) — refuse before cloning.
    if (
      await fs
        .access(checkoutDir)
        .then(() => true)
        .catch(() => false)
    ) {
      throw new ProjectError(
        `A "${checkoutName}" directory already exists in ${slug}; refusing to overwrite`,
        "exists",
      );
    }

    // Clone FIRST so a failure rolls back to a clean notebook (rm the checkout only,
    // never the project dir + its chats). Mirrors create()'s rollback discipline.
    try {
      await cloneRepo(repo, checkoutDir);
    } catch (err) {
      await this.rmInsideRoot(checkoutDir).catch(() => undefined);
      throw new ProjectError(
        err instanceof Error ? err.message : `Failed to clone ${repo}`,
        "invalid",
      );
    }

    // `writeYaml` is the atomic COMMIT point: until it succeeds the notebook is
    // byte-identical to before (only the checkout dir exists), so a failure here
    // rolls back by removing JUST the checkout — nothing else has been mutated.
    // We deliberately DON'T touch the sidecar `.gitignore` or the notebook's
    // CLAUDE.md until after the commit, so a rare `writeYaml` failure can't leave a
    // botched promote's notebook altered (e.g. a `.gitignore` that now ignores
    // `/.chats/`). (Warren #370.)
    const next: ProjectYaml = {
      ...this.stripDto(current),
      repo,
      // Promotion crosses the managed axis (issue #206): the keeper's cwd becomes
      // a checkout that owns its own CLAUDE.md, which is exactly what unmanaged
      // means. Set explicitly — `stripDto` carries the notebook's concrete
      // `managed: true` forward, and leaving it would persist the one combination
      // `create()` rejects (managed + repo).
      managed: false,
      updated: today(),
    };
    try {
      await this.writeYaml(slug, next);
    } catch (err) {
      await this.rmInsideRoot(checkoutDir).catch(() => undefined);
      throw err;
    }

    // Post-commit finalization — the project is now validly repo-backed; these
    // steps must NOT roll the promotion back (they only tidy up), so they're
    // best-effort: keep the nested checkout + transcript store out of the data repo,
    // and drop the notebook's sweeper-owned CLAUDE.md so the repo's OWN one applies
    // (it survives in the data-repo history). A failure here leaves a valid
    // repo-backed project, matching create()'s own non-transactional finalization.
    await this.ensureSidecarGitignore(dir, checkoutName).catch(() => undefined);
    await fs.rm(path.join(dir, CLAUDE_FILE), { force: true }).catch(() => undefined);
    return this.toDto(dir, next, await this.overviewExists(slug));
  }

  /** Update mutable metadata fields and bump `updated`. */
  async update(slug: string, patch: UpdateProjectInput): Promise<Project> {
    const current = await this.get(slug);
    // driveMode + maxSpawnDepth are tri-state (set / clear / leave), so they're
    // applied explicitly below rather than via the blanket spread — a plain spread
    // can't express "delete this field", which is how an override is cleared back
    // to inherit.
    const {
      driveMode: driveModePatch,
      maxSpawnDepth: maxSpawnDepthPatch,
      hooksMcpEnabled: hooksMcpPatch,
      recovery: recoveryPatch,
      attachments: attachmentsPatch,
      curation: curationPatch,
      models: modelsPatch,
      ...rest
    } = patch;
    const next: ProjectYaml = {
      ...this.stripDto(current),
      ...rest,
      slug: current.slug, // immutable
      started: current.started, // immutable
      updated: today(),
    };
    // `path` and `managed` are immutable (issue #206), enforced here rather than
    // by their absence from UpdateProjectInput — that type is a compile-time shape
    // while `rest` is spread from a request body.
    //
    // For `path` both directions matter: a project must not be RE-POINTED (its cwd
    // is baked into every transcript path, so moving it strands the history), and
    // one must not be given a path by a stray key, which would silently hand its
    // keeper a cwd somewhere else on the box that never went through
    // `validatePath`. `managed` is re-asserted from `current` for the same reason
    // — flipping it would move where the curated trio lives and either start the
    // sweeper writing into a checkout or orphan the existing notes. (Changing it
    // deliberately is a migration, not a PATCH; see #708 for what a silent
    // location flip does to history.)
    if (current.path) next.path = current.path;
    else delete next.path;
    next.managed = current.managed;
    if (driveModePatch === null) {
      // Clear the per-project override -> inherit the global default (issue #122).
      delete next.driveMode;
    } else if (driveModePatch !== undefined) {
      next.driveMode = driveModePatch;
    }
    if (maxSpawnDepthPatch === null) {
      // Clear the per-project override -> inherit the instance default (#262).
      delete next.maxSpawnDepth;
    } else if (maxSpawnDepthPatch !== undefined) {
      next.maxSpawnDepth = maxSpawnDepthPatch;
    }
    if (hooksMcpPatch === null) {
      // Clear the per-project override -> inherit the instance default (G5).
      delete next.hooksMcpEnabled;
    } else if (hooksMcpPatch !== undefined) {
      next.hooksMcpEnabled = hooksMcpPatch;
    }
    if (recoveryPatch === null) {
      // Clear the per-project override -> inherit every instance default (#301).
      delete next.recovery;
    } else if (recoveryPatch !== undefined) {
      // Sanitise the incoming override; an all-invalid object clears it (undefined).
      const clean = sanitizeRecoveryOverride(recoveryPatch);
      if (clean) next.recovery = clean;
      else delete next.recovery;
    }
    if (attachmentsPatch === null) {
      // Clear the per-project override -> inherit every instance default (#328).
      delete next.attachments;
    } else if (attachmentsPatch !== undefined) {
      const clean = sanitizeAttachmentsOverride(attachmentsPatch);
      if (clean) next.attachments = clean;
      else delete next.attachments;
    }
    if (curationPatch === null) {
      // Clear the per-project override -> inherit every instance default (#384).
      delete next.curation;
    } else if (curationPatch !== undefined) {
      // Sanitise the incoming override; an all-invalid object clears it (undefined).
      const clean = sanitizeCurationOverride(curationPatch);
      if (clean) next.curation = clean;
      else delete next.curation;
    }
    if (modelsPatch === null) {
      // Clear the per-project override -> offer the instance list again (#457).
      delete next.models;
    } else if (modelsPatch !== undefined) {
      // Sanitise; an empty/all-invalid list clears the override (undefined). The
      // subset-of-instance-list check is enforced upstream at the route.
      const clean = sanitizeModelsOverride(modelsPatch);
      if (clean) next.models = clean;
      else delete next.models;
    }
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  // --- overview (sweep-curated current state) ----------------------------

  /** Read OVERVIEW.md, or "" if it doesn't exist yet. */
  async readOverview(slug: string): Promise<string> {
    try {
      return await fs.readFile(path.join(await this.contentDirOf(slug), OVERVIEW_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /** Replace OVERVIEW.md wholesale (the sweep regenerates it each time). */
  async writeOverview(slug: string, content: string): Promise<void> {
    await fs.writeFile(path.join(await this.contentDirOf(slug), OVERVIEW_FILE), content, "utf8");
  }

  /** Read CHANGELOG.md, or "" if it doesn't exist yet (issue #188). */
  async readChangelog(slug: string): Promise<string> {
    try {
      return await fs.readFile(path.join(await this.contentDirOf(slug), CHANGELOG_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /** Whether OVERVIEW.md exists for this project. */
  async overviewExists(slug: string): Promise<boolean> {
    return this.overviewExistsIn(await this.contentDirOf(slug));
  }

  /**
   * {@link overviewExists} for a content dir already in hand.
   *
   * `readSafe` needs this: it has just parsed the yaml, so it can derive the
   * content dir for free, whereas going through the slug would re-read
   * `project.yaml` on every project of every `list()`.
   */
  private async overviewExistsIn(contentDir: string): Promise<boolean> {
    try {
      await fs.access(path.join(contentDir, OVERVIEW_FILE));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Where this project's curated trio lives (issue #206) — see
   * {@link contentDirFor}. Falls back to the metadata dir for a slug that names
   * no project, so a caller reading a missing project still gets "" rather than
   * throwing.
   */
  private async contentDirOf(slug: string): Promise<string> {
    const project = await this.readSafe(slug);
    return project?.contentDir ?? this.dirFor(slug);
  }

  // --- CLAUDE.md (durable identity & conventions, sweep-amended) ----------

  /** Read CLAUDE.md, or "" if it doesn't exist yet (issue #177). */
  async readClaudeMd(slug: string): Promise<string> {
    try {
      return await fs.readFile(path.join(await this.contentDirOf(slug), CLAUDE_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /**
   * Replace the CLAUDE.md "Curated notes" section wholesale with a sweeper-
   * curated body (issue #379), preserving ALL human-authored content above the
   * managed heading. This supersedes the old amend-only `appendClaudeMd`, which
   * blind-appended and could never dedup — the sweeper only ever saw the first
   * 2000 chars of the file, so it re-added "known" facts believing they were new.
   * The sweeper now sees the full file and returns the ENTIRE curated-notes body,
   * dedup'd/pruned to fit its budget. Everything up to and including the
   * `## Curated notes` heading is kept verbatim; only the body below is rewritten.
   * The file/heading is seeded if absent (older projects predating #177). A blank
   * body is a no-op — the caller passes content only when there's something to
   * write (NOCHANGE means "leave the file untouched", not "empty it").
   */
  async writeClaudeCurated(slug: string, curatedBody: string): Promise<void> {
    const trimmed = curatedBody.trim();
    if (!trimmed) return;
    const file = path.join(await this.contentDirOf(slug), CLAUDE_FILE);
    let body: string;
    try {
      body = await fs.readFile(file, "utf8");
    } catch {
      body = claudeTemplate(slug, "");
    }
    const idx = body.indexOf(CLAUDE_CURATED_HEADING);
    const head =
      idx === -1
        ? `${body.trimEnd()}\n\n${CLAUDE_CURATED_HEADING}`
        : body.slice(0, idx + CLAUDE_CURATED_HEADING.length);
    await fs.writeFile(file, `${head.trimEnd()}\n\n${trimmed}\n`, "utf8");
  }

  // --- pins (sibling-tab files) ------------------------------------------

  /**
   * Pin a file: validate it exists in the project dir, dedupe, persist in
   * project.yaml. Returns the updated project. Throws ProjectError("invalid")
   * if the file doesn't exist or escapes the project dir.
   */
  async pinFile(slug: string, file: string): Promise<Project> {
    const current = await this.get(slug);
    const name = file?.trim();
    if (!name) throw new ProjectError("File name is required", "invalid");
    // Reuse readFile's traversal guard + existence check (throws if missing).
    await this.readFile(slug, name).catch(() => {
      throw new ProjectError(`File not found: ${name}`, "invalid");
    });
    const pinned = current.pinned.includes(name)
      ? current.pinned
      : [...current.pinned, name];
    const next: ProjectYaml = { ...this.stripDto(current), pinned, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /** Unpin a file (no-op if not pinned). Returns the updated project. */
  async unpinFile(slug: string, file: string): Promise<Project> {
    const current = await this.get(slug);
    const pinned = current.pinned.filter((f) => f !== file);
    const next: ProjectYaml = { ...this.stripDto(current), pinned, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /**
   * Add or replace one unified trigger in `project.yaml`, keyed by name (Epic T /
   * T1) — the persistence half of a trigger mutation (the caller arms it against
   * herdctl separately via `TriggerService`/`HerdctlService`). The record is validated
   * + normalised by the Zod schema ({@link sanitizeTrigger}); an invalid name or record
   * throws `ProjectError("invalid")`. Returns the updated project DTO.
   */
  async setTrigger(slug: string, name: string, trigger: unknown): Promise<Project> {
    const current = await this.get(slug);
    if (!isValidTriggerName(name)) {
      throw new ProjectError(`Invalid trigger name: ${name}`, "invalid");
    }
    const clean = sanitizeTrigger(trigger);
    if (!clean) throw new ProjectError("Invalid trigger definition", "invalid");
    const triggers = { ...(current.triggers ?? {}), [name]: clean };
    const next: ProjectYaml = { ...this.stripDto(current), triggers, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /**
   * Remove a trigger from `project.yaml` (no-op if absent). Returns the updated
   * project DTO. The caller disarms the trigger's agent / schedule via `TriggerService`.
   *
   */
  async removeTrigger(slug: string, name: string): Promise<Project> {
    const current = await this.get(slug);
    const rest = { ...(current.triggers ?? {}) };
    delete rest[name];
    const stripped = this.stripDto(current);
    if (Object.keys(rest).length > 0) stripped.triggers = rest;
    else delete stripped.triggers;
    const next: ProjectYaml = { ...stripped, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /**
   * Delete a project directory and everything in it (project.yaml, CHANGELOG.md,
   * and any files the keeper agent created). Throws ProjectError("not_found")
   * if the slug has no project.yaml, so callers can return a clean 404.
   *
   * Note: this removes the project DIRECTORY only. The caller (server) is
   * responsible for dropping the generated keeper-agent yaml + regenerating
   * herdctl.yaml + reloading the fleet — the inverse of the create flow.
   */
  async remove(slug: string): Promise<Project> {
    // The root workspace's directory IS the projects root — deleting
    // it would take every project with it. The resolved-path guard below already
    // refuses, but say so explicitly rather than leaning on a coincidence.
    if (isRootKey(slug)) {
      throw new ProjectError("Refusing to delete the root workspace", "invalid");
    }
    const project = await this.get(slug); // throws not_found
    // Only ever the METADATA dir — never `project.workingDir`. For a LINKED
    // project (issue #206) those differ and the working dir is the user's real
    // clone: deleting the project unlinks it, it does not delete their work.
    // `rmInsideRoot` enforces that structurally (a linked path is outside the
    // root by validation, so it cannot be reached from here at all).
    await this.rmInsideRoot(this.dirFor(slug));
    return project;
  }

  /**
   * Replace CHANGELOG.md wholesale with a sweeper-curated body (issue #379). The
   * sweeper now returns the FULL changelog — adding a dated entry for genuinely-
   * new activity, coalescing duplicates, and dropping/summarizing the oldest to
   * stay under its token budget — instead of one blind-appended bullet. That's
   * what stops the file (and the per-chat preload that injects it) growing without
   * bound. The `# Changelog — <slug>` title is owned by Paddock and re-asserted
   * here so the model never has to reproduce it; if the model included its own
   * top-level heading we drop it to avoid a duplicate title. A blank body is a
   * no-op (guards against wiping the file on a malformed reply).
   */
  async writeChangelog(slug: string, body: string): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) return;
    const file = path.join(await this.contentDirOf(slug), CHANGELOG_FILE);
    const title = `# Changelog — ${slug}`;
    // Drop a leading top-level heading the model may have emitted, so the
    // Paddock-owned title isn't duplicated.
    const withoutTitle = /^#\s/.test(trimmed) ? trimmed.replace(/^#[^\n]*\n+/, "") : trimmed;
    await fs.writeFile(file, `${title}\n\n${withoutTitle.trim()}\n`, "utf8");
  }

  // --- freeform file serving (delegated to project-files.ts, issue #403) ---
  // Thin wrappers over the pure `(root, slug, …)` helpers so `ProjectStore`'s
  // public file-read API (and its ProjectError codes) is unchanged.

  /**
   * List one level of a project directory (issue #259). See
   * {@link import("./project-files.js").listFiles}.
   */
  async listFiles(slug: string, subpath = ""): Promise<FileEntry[]> {
    return projectFiles.listFiles(this.root, slug, subpath);
  }

  /** Read a freeform file's contents as UTF-8 text (path-traversal guarded). */
  async readFile(slug: string, name: string): Promise<string> {
    return projectFiles.readProjectFile(this.root, slug, name);
  }

  /**
   * Read a file's raw bytes + its MIME type (issue #61), for the binary/image
   * endpoint. See {@link import("./project-files.js").readFileBytes}.
   */
  async readFileBytes(slug: string, name: string): Promise<{ bytes: Buffer; mime: string }> {
    return projectFiles.readFileBytes(this.root, slug, name);
  }

  /**
   * Read a file plus a render-kind hint derived from its extension (issues #3 /
   * #61). See {@link import("./project-files.js").readFileWithKind}.
   */
  async readFileWithKind(
    slug: string,
    name: string,
  ): Promise<{ name: string; kind: FileKind; content: string }> {
    return projectFiles.readFileWithKind(this.root, slug, name);
  }

  // --- internals ---------------------------------------------------------

  /**
   * Read one workspace, or `null` if the key doesn't name one.
   *
   * **The root workspace always exists.** For a project, `project.yaml` IS the
   * existence gate — no record, not a project. But the root is the instance
   * itself: its directory is always there, so a missing record just means
   * "nothing has been customised yet" and every field falls back to a default
   * (see {@link normalize}). The record is written lazily, on the first setting
   * that actually changes.
   *
   * This is what removes the whole opt-in apparatus the previous design needed —
   * no `createRoot`, no enable card, and no `/chat` that 404s on a fresh box.
   */
  private async readSafe(key: string): Promise<Project | null> {
    const dir = this.dirFor(key);
    const file = path.join(dir, PROJECT_FILE);
    let yaml: ProjectYaml;
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = YAML.parse(raw) as Partial<ProjectYaml> | null;
      if (!parsed || typeof parsed !== "object") {
        if (!isRootKey(key)) return null;
        yaml = this.normalize({}, key);
      } else {
        // The downgrade guard (#724), BEFORE `normalize` gets to be lenient with
        // it. A file from the future is skipped whole — including the root's,
        // which falls through to a `not_found` rather than to the empty-record
        // defaults, because those defaults are precisely what a subsequent write
        // would flatten it to. Nothing is written here, and every mutator reaches
        // the file through `get()`, so a skipped record cannot be rewritten.
        const declared = (parsed as Record<string, unknown>)[SCHEMA_VERSION_KEY];
        const skip = projectSchemaSkip(declared, file);
        if (skip !== undefined) {
          this.warnOnceAboutSchema(file, declared, skip);
          return null;
        }
        yaml = this.normalize(parsed, key);
      }
    } catch {
      if (!isRootKey(key)) return null;
      yaml = this.normalize({}, key);
    }
    // A cheap fs.access, done after the yaml parse succeeds. Deliberately the
    // content-dir-in-hand variant: the slug-taking `overviewExists` would re-read
    // this very `project.yaml` to find the content dir, once per project of every
    // `list()`.
    const hasOverview = await this.overviewExistsIn(contentDirFor(dir, yaml));
    return this.toDto(dir, yaml, hasOverview);
  }

  /** Fill defaults / coerce a parsed project.yaml into a complete ProjectYaml. */
  private normalize(p: Partial<ProjectYaml>, key: string): ProjectYaml {
    const started = p.started ?? today();
    return {
      // The root workspace has no slug to fall back to, so it reads as its own
      // directory's basename. (No instance-name config field exists yet; when
      // one lands, this is the single place it should feed.)
      name: p.name ?? (isRootKey(key) ? path.basename(path.resolve(this.root)) : key),
      slug: p.slug ?? key,
      status: (p.status as ProjectStatus) ?? "active",
      domain: Array.isArray(p.domain) ? p.domain : [],
      // Carry `group` through only when it's a non-empty string (an absent area
      // stays absent on disk — same round-trip discipline as `model`).
      ...(typeof p.group === "string" && p.group.trim()
        ? { group: p.group.trim().toLowerCase() }
        : {}),
      visibility: (p.visibility as ProjectVisibility) ?? "public",
      started,
      updated: p.updated ?? started,
      summary: p.summary ?? "",
      // Coerce to well-formed {label,url} objects — a legacy/hand-edited file may
      // carry a bare string list, which otherwise crashes the Settings pane.
      links: normalizeLinks(p.links),
      pinned: Array.isArray(p.pinned)
        ? p.pinned.filter((f): f is string => typeof f === "string")
        : [],
      // Carry model through only when present on disk; the DTO resolves the
      // default (an absent model stays absent in the yaml so existing files
      // without `model` still round-trip unchanged).
      ...(typeof p.model === "string" ? { model: p.model } : {}),
      // models allow-list (issue #457 Step 2): carried only when at least one known
      // catalog id survives sanitization — an absent/all-invalid override stays
      // absent so files without it round-trip unchanged, and the offered list is
      // resolved against the instance list in the web, NOT baked concrete here.
      ...(() => {
        const m = sanitizeModelsOverride(p.models);
        return m ? { models: m } : {};
      })(),
      // Keeper-agent overrides (issue #12): same round-trip discipline as model
      // — carried only when present so files without them are unchanged.
      ...(typeof p.permissionMode === "string" ? { permissionMode: p.permissionMode } : {}),
      ...(typeof p.maxTurns === "number" ? { maxTurns: p.maxTurns } : {}),
      ...(typeof p.docker === "boolean" ? { docker: p.docker } : {}),
      // driveMode (Paddock#111): carried only when explicitly set — an absent
      // value means "inherit the global default" and is resolved at dispatch
      // (`project.driveMode ?? cfg.driveMode`), NOT here, so the env-level
      // global can still take effect for projects that don't override it.
      ...(typeof p.driveMode === "string" ? { driveMode: p.driveMode } : {}),
      // maxSpawnDepth (issue #262): carried only when explicitly set — an absent
      // value means "inherit the instance default" and is resolved at dispatch
      // (`resolveMaxSpawnDepth(project.maxSpawnDepth, cfg.maxSpawnDepth)`), NOT
      // here, so the instance default still applies to non-overriding projects.
      ...(typeof p.maxSpawnDepth === "number" ? { maxSpawnDepth: p.maxSpawnDepth } : {}),
      // hooksMcpEnabled (Epic G / G5): carried only when explicitly set — an absent
      // value means "inherit the instance default" and is resolved at dispatch
      // (`resolveHooksMcpEnabled(project.hooksMcpEnabled, cfg.hooksMcpEnabled)`), NOT
      // here, so the instance default still applies to non-overriding projects.
      ...(typeof p.hooksMcpEnabled === "boolean" ? { hooksMcpEnabled: p.hooksMcpEnabled } : {}),
      // recovery (issue #301): carried only when at least one valid field survives
      // sanitization — an absent/all-invalid override stays absent so files without
      // it round-trip unchanged, and each field is resolved at dispatch
      // (`resolveRecoveryConfig(project.recovery, cfg.recovery)`), NOT here.
      ...(() => {
        const r = sanitizeRecoveryOverride(p.recovery);
        return r ? { recovery: r } : {};
      })(),
      // curation (issue #384): carried only when at least one valid field survives
      // sanitization — an absent/all-invalid override stays absent so files without
      // it round-trip unchanged, and each field is resolved at sweep time
      // (`resolveCurationConfig(project.curation, cfg.curation)`), NOT here.
      ...(() => {
        const c = sanitizeCurationOverride(p.curation);
        return c ? { curation: c } : {};
      })(),
      // repo (issue #187): carried only when present — its presence is what marks
      // the project repo-backed and drives the workingDir resolution in toDto.
      ...(typeof p.repo === "string" && p.repo.trim() ? { repo: p.repo.trim() } : {}),
      // path (issue #206): carried only when present AND absolute — its presence
      // is what makes workingDirFor return the cwd verbatim. The absolute check is
      // a read-boundary backstop against a hand-edited relative value, which would
      // otherwise resolve against the server's cwd; dropping it degrades the
      // project to an unbacked one rather than pointing an agent somewhere
      // arbitrary. Existence/containment were checked at create time and are NOT
      // re-checked here — `normalize` runs on every list() and must stay pure +
      // cheap, and a path that has since gone away should surface as a broken cwd,
      // not silently mutate into a different kind of project.
      ...(typeof p.path === "string" && path.isAbsolute(p.path.trim())
        ? { path: p.path.trim() }
        : {}),
      // managed (issue #206): carried ONLY when explicitly set on disk. An absent
      // value must stay absent so it keeps deriving from the backing
      // (`!(repo || path)`) — baking a concrete `true` in here would flip every
      // legacy repo-backed project to managed the first time its yaml was
      // re-written, and the sweeper would start writing CLAUDE.md into a checkout.
      // Same round-trip discipline as `driveMode`, and for a much sharper reason.
      ...(typeof p.managed === "boolean" ? { managed: p.managed } : {}),
      // schedules (issue #265): carried only when at least one well-formed entry
      // survives sanitization — an absent/empty map stays absent on disk, so files
      // without schedules round-trip unchanged. A malformed entry is dropped (not
      // thrown) so a bad hand-edit can't brick the project's keeper registration.
      ...(() => {
        const s = sanitizeSchedules(p.schedules);
        return s && Object.keys(s).length > 0 ? { schedules: s } : {};
      })(),
      // hooks (Epic G / G1): same discipline as schedules — carried only when at
      // least one well-formed entry survives sanitization, so hook-less files
      // round-trip byte-identically and a malformed hand-edit is dropped (not thrown)
      // rather than bricking the project's agent registration.
      ...(() => {
        const h = sanitizeHooks(p.hooks);
        return h && Object.keys(h).length > 0 ? { hooks: h } : {};
      })(),
      // triggers (Epic T / T1): same discipline as schedules/hooks — carried only
      // when at least one well-formed entry survives Zod validation, so trigger-less
      // files round-trip byte-identically and a malformed hand-edit is dropped (not
      // thrown) rather than bricking the project's agent registration.
      ...(() => {
        const t = sanitizeTriggers(p.triggers);
        return t && Object.keys(t).length > 0 ? { triggers: t } : {};
      })(),
    };
  }

  /**
   * Ensure the project dir's sidecar `.gitignore` ignores the nested repo-backed
   * checkout (`/<checkoutName>/`) and the transcript store (`/.chats/`), so neither
   * is tracked by the instance data repo (issue #187 option A). Idempotent and
   * merge-aware: an existing `.gitignore` (rare for a notebook, but possible) keeps
   * its lines and only the missing entries are appended — used by both `create()`
   * and the in-place `promote()` (#213).
   */
  private async ensureSidecarGitignore(dir: string, checkoutName: string): Promise<void> {
    const file = path.join(dir, GITIGNORE_FILE);
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      /* no .gitignore yet — write a fresh one below */
    }
    const want = [`/${checkoutName}/`, `/.chats/`];
    const have = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = want.filter((l) => !have.has(l));
    if (existing && missing.length === 0) return; // already covers everything
    if (!existing) {
      await fs.writeFile(
        file,
        [
          `# Repo-backed project checkout (issue #187) — not tracked by the data repo.`,
          ...want,
          "",
        ].join("\n"),
        "utf8",
      );
      return;
    }
    // Append only the missing lines to the existing file (preserve user content).
    const body = existing.endsWith("\n") ? existing : `${existing}\n`;
    await fs.writeFile(file, `${body}${missing.join("\n")}\n`, "utf8");
  }

  private async writeYaml(slug: string, yaml: ProjectYaml): Promise<void> {
    const header =
      "# Paddock project metadata. Directory name MUST equal `slug`.\n" +
      "# status: idea | active | paused | blocked | done | abandoned\n";
    // Stamped here rather than threaded through ProjectYaml/the DTO, because
    // this is the one write choke point and because what it describes is the
    // FILE, not the project (#724). Unconditional and first: every write is a
    // full rewrite from the normalized record, so what lands on disk is by
    // construction this build's shape whatever the file said before. A legacy
    // file therefore gains the key the next time it is saved for some other
    // reason — there is no backfill pass, and merely reading one writes nothing.
    const body = YAML.stringify({ [SCHEMA_VERSION_KEY]: PROJECT_SCHEMA_VERSION, ...yaml });
    await fs.writeFile(path.join(this.dirFor(slug), PROJECT_FILE), header + body, "utf8");
  }

  /**
   * Say out loud that a project was skipped for being from the future (#724),
   * once per (file, declared version).
   *
   * `list()` runs on every `GET /api/projects`, so an unconditional warn would
   * bury the log. Keyed on the declared version as well as the path so a
   * hand-edit — or the same instance being downgraded further — speaks up again.
   */
  private warnOnceAboutSchema(file: string, declared: unknown, message: string): void {
    const seen = `${file} @ ${JSON.stringify(declared) ?? "?"}`;
    if (this.schemaWarned.has(seen)) return;
    this.schemaWarned.add(seen);
    this.log.warn(message);
  }

  private toDto(dir: string, yaml: ProjectYaml, hasOverview: boolean): Project {
    return {
      ...yaml,
      // Always concrete in the DTO; "" means Unsorted.
      group: yaml.group ?? "",
      pinned: yaml.pinned ?? [],
      // Always concrete in the DTO: an absent on-disk model resolves to the
      // keeper default (CONTRACT-v3 §4).
      model: yaml.model ?? DEFAULT_MODEL,
      // Offered-models override stays RAW (per-project only — resolved against the
      // instance allow-list in the web, never baked concrete here; the `model`/
      // `recovery` discipline), re-sanitised so a corrupt hand-edit never reaches
      // the web. Absent ⇒ omitted (undefined), so the project offers the instance
      // list (issue #457 Step 2).
      models: sanitizeModelsOverride(yaml.models),
      // Keeper-agent overrides — always concrete in the DTO (issue #12).
      permissionMode: yaml.permissionMode ?? DEFAULT_PERMISSION_MODE,
      maxTurns: yaml.maxTurns ?? DEFAULT_MAX_TURNS,
      docker: yaml.docker ?? DEFAULT_DOCKER,
      // Recovery override stays RAW (per-project only — resolved against the
      // instance default at dispatch, never baked concrete here; the `driveMode`
      // discipline), but re-sanitised so a corrupt hand-edit never reaches the
      // web. Absent ⇒ omitted (undefined), so the project inherits every default.
      recovery: sanitizeRecoveryOverride(yaml.recovery),
      // Attachment override stays RAW (per-project only — resolved against the
      // instance default at request time, never baked concrete here), re-sanitised
      // so a corrupt hand-edit never reaches the web. Absent ⇒ omitted (#328).
      attachments: sanitizeAttachmentsOverride(yaml.attachments),
      // Curation-budget override stays RAW (per-project only — resolved against
      // the instance default at sweep time, never baked concrete here), re-
      // sanitised so a corrupt hand-edit never reaches the web. Absent ⇒ omitted (#384).
      curation: sanitizeCurationOverride(yaml.curation),
      dir,
      // The keeper's cwd: `path` verbatim (#206), else the nested checkout for a
      // repo-backed project (#187), else the metadata dir.
      workingDir: workingDirFor(dir, yaml.repo, yaml.path),
      // Where the curated trio lives, and whether Paddock curates at all — the
      // two facts that replaced `repoBacked` (#206). Both ALWAYS concrete here,
      // with `managed` resolved through the derived default so a legacy file
      // without the key keeps the meaning it has always had.
      contentDir: contentDirFor(dir, yaml),
      managed: isManaged(yaml),
      hasOverview,
    };
  }

  /**
   * Drop the derived DTO-only fields, leaving the on-disk shape.
   *
   * `managed` deliberately SURVIVES: it is a real `project.yaml` key, and because
   * the DTO's value is always concrete, the first `update()` of a legacy project
   * pins its derived value explicitly on disk. That is the desired direction —
   * the file stops depending on a default — and it is safe precisely because the
   * value written is the one the derivation already produced.
   */
  private stripDto(p: Project): ProjectYaml {
    const {
      dir: _dir,
      workingDir: _workingDir,
      contentDir: _contentDir,
      hasOverview: _hasOverview,
      group,
      ...rest
    } = p;
    void _dir;
    void _workingDir;
    void _contentDir;
    void _hasOverview;
    // Keep an empty area off the yaml so it isn't persisted as `group: ""`.
    return group?.trim() ? { ...rest, group } : rest;
  }
}
