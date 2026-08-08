/**
 * GitService — the git-aware capability layer over the projects directory
 * (backing-store design, Phase 1: read surface).
 *
 * The base backing store is just a filesystem directory (`projectsRoot`). When
 * that directory is a git working tree, paddock "lights up" git features. This
 * module is the read half: detect whether the store is a repo, and report a
 * single project's uncommitted changes + diff. Commit/push/auth come in Phase 2.
 *
 * It shells out to the `git` binary via `execFile` (no shell, arg arrays — no
 * injection surface) so there's no new dependency. Every method degrades safely:
 * if `git` is missing or the directory isn't a repo, it reports "not a repo"
 * rather than throwing, so the rest of paddock is unaffected.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Cap for reading an untracked file to count its added lines (bigger ⇒ skip). */
const UNTRACKED_STAT_CAP = 2 * 1024 * 1024;

/**
 * Clone an external git repo into `dest` — the checkout that becomes a
 * repo-backed project's working directory (issue #187). Shells out to the `git`
 * binary via execFile (arg array, no shell → no injection surface), the same
 * discipline as {@link GitService}.
 *
 * A FULL clone (not `--depth 1`): a repo-backed project is where you *do
 * engineering*, so the keeper wants real history — `git log`, blame, bisect, and
 * a non-shallow base for branches/PRs — from the start. Credentials are the
 * ambient git environment's job (a public URL needs none; a private repo needs a
 * box-level credential helper / token — per-project scoped credentials are a
 * documented #187 follow-up). Throws with git's stderr on failure so the caller
 * can surface a clean error and roll back the half-created project.
 */
export async function cloneRepo(url: string, dest: string): Promise<void> {
  try {
    await run("git", ["clone", "--", url, dest], {
      maxBuffer: MAX_BUFFER,
      // Never let git prompt for credentials on a private URL — fail fast so the
      // create request returns an error instead of hanging the server.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (err) {
    throw new Error(`git clone failed: ${errText(err)}`);
  }
}

/** A single changed path within a project (porcelain v1 semantics). */
export interface GitFileChange {
  /** Path relative to the project directory. */
  path: string;
  /** Two-letter porcelain code, trimmed (e.g. "M", "??", "A", "RM"). */
  status: string;
  /** Whether the change is staged (index differs from HEAD). */
  staged: boolean;
  /** True for an untracked ("??") path. */
  untracked: boolean;
  /** Lines added (undefined for a binary change). Untracked text files count as all-added. */
  added?: number;
  /** Lines removed (undefined for a binary change / an untracked file). */
  removed?: number;
  /** True when the change is binary (no line-level stat). */
  binary?: boolean;
}

/** A project's git status (or `repo: false` when the store isn't a repo). */
export interface GitProjectStatus {
  /** Whether `projectsRoot` is a git working tree at all. */
  repo: boolean;
  /** Current branch (omitted when not a repo / detached). */
  branch?: string;
  /** Changes confined to this project's subtree. */
  files: GitFileChange[];
  /** True when the project subtree has no pending changes. */
  clean: boolean;
}

const MAX_BUFFER = 16 * 1024 * 1024; // generous cap for status/diff output

export class GitService {
  /** Cached repo-detection result for `projectsRoot` (null = not yet checked). */
  private repoFlag: boolean | null = null;

  /** Cached per-directory repo detection, keyed by resolved path (#597 / #206). */
  private readonly repoAt = new Map<string, boolean>();

  /**
   * @param projectsRoot Absolute path to the projects root the service operates on.
   * @param author Commit identity used when Paddock commits on a project's behalf.
   *   Folded into PaddockConfig from `PADDOCK_GIT_AUTHOR_*` (issue #269); defaults
   *   preserve the pre-fold values so a bare `new GitService(root)` is unchanged.
   */
  constructor(
    private readonly projectsRoot: string,
    private readonly author: { name: string; email: string } = {
      name: "Paddock",
      email: "paddock@localhost",
    },
  ) {}

  /** Run git in a directory, returning stdout. Throws on non-zero exit. */
  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  }

  /**
   * Whether the backing store is a git working tree. Cached after the first
   * successful check (repo-ness doesn't change under a running server); a thrown
   * git / missing-binary error resolves to `false`.
   *
   * Store-wide, so it still gates the one genuinely store-wide operation,
   * {@link dirtyCounts} — a single `git status` over the whole root. Everything
   * else asks {@link isRepoAt} about the directory it is about to act on: the
   * project's own working directory for status/diff/commit (#597, #206) and for
   * remote/push (#710). See {@link isRepoAt} for why the two had to be separated.
   */
  async isRepo(): Promise<boolean> {
    if (this.repoFlag !== null) return this.repoFlag;
    this.repoFlag = await this.probeRepo(this.projectsRoot);
    return this.repoFlag;
  }

  /**
   * Whether `dir` is inside a git working tree, cached per directory.
   *
   * The per-project git surface used to gate on {@link isRepo} — "is the PROJECTS
   * ROOT a repo?" — which was right only while every project's tree lived under
   * that root. It stopped being right twice over (issue #597, issue #206):
   *
   *  - a project whose working directory is a linked checkout outside the root
   *    would report "not a repo" whenever the root itself wasn't one, hiding the
   *    Changes tab for the exact directory that IS a repo;
   *  - conversely a non-repo directory inside a repo root would claim to be one.
   *
   * Asking about the directory the project actually works in answers both. For
   * every pre-existing shape it returns what {@link isRepo} did, because a
   * project dir under a repo root is itself inside that work tree.
   *
   * Probing rather than requiring is the house style: nothing here refuses a
   * directory for not being a repo, it just doesn't light up the git features.
   */
  async isRepoAt(dir: string): Promise<boolean> {
    const key = path.resolve(dir);
    const cached = this.repoAt.get(key);
    if (cached !== undefined) return cached;
    const found = await this.probeRepo(key);
    this.repoAt.set(key, found);
    return found;
  }

  /** One `rev-parse`, false on any failure (missing binary, missing dir, not a repo). */
  private async probeRepo(dir: string): Promise<boolean> {
    try {
      const out = await this.git(dir, ["rev-parse", "--is-inside-work-tree"]);
      return out.trim() === "true";
    } catch {
      return false;
    }
  }

  /** Force the next repo check to re-run (e.g. after `git init` at runtime). */
  resetRepoCache(): void {
    this.repoFlag = null;
    this.repoAt.clear();
  }

  /**
   * Status for one project's subtree. Returns `{ repo: false }` when the store
   * isn't a repo (the UI then hides the git affordance). Paths are relative to
   * `projectDir`.
   */
  async projectStatus(projectDir: string): Promise<GitProjectStatus> {
    // Per-DIRECTORY, not store-wide: callers pass the project's workingDir, which
    // may be a linked checkout outside `projectsRoot` entirely (#597 / #206).
    if (!(await this.isRepoAt(projectDir))) {
      return { repo: false, files: [], clean: true };
    }
    let branch: string | undefined;
    try {
      branch = (await this.git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (branch === "HEAD") branch = undefined; // detached
    } catch {
      /* leave branch undefined */
    }

    // git reports porcelain paths relative to the REPO ROOT, but the UI (and the
    // /git/diff ?file= param) want them relative to the PROJECT dir. show-prefix
    // is the repo-root→projectDir path (e.g. "garage-water-heater/"); strip it.
    let prefix = "";
    try {
      prefix = (await this.git(projectDir, ["rev-parse", "--show-prefix"])).trim();
    } catch {
      /* leave prefix empty (project dir is the repo root) */
    }

    let files: GitFileChange[] = [];
    try {
      const out = await this.git(projectDir, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
      ]);
      files = parsePorcelainZ(out).map((f) => ({
        ...f,
        path: prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path,
      }));
    } catch {
      /* treat an unreadable status as clean rather than erroring the request */
    }

    // Attach per-file line stats (+/-) for the Changes tab. Tracked changes come
    // from `git diff --numstat`; untracked (new) files count as all-added by
    // reading them (bounded, binary-detected). Best-effort — a stat failure just
    // leaves the counts undefined and the UI degrades to no badge.
    if (files.length) {
      const numstat = await this.trackedNumstat(projectDir);
      for (const f of files) {
        if (f.untracked) {
          Object.assign(f, await untrackedStat(projectDir, f.path));
        } else {
          const s = numstat.get(f.path);
          if (s) Object.assign(f, s);
        }
      }
    }

    return { repo: true, branch, files, clean: files.length === 0 };
  }

  /**
   * Whether `relPath` is a file git currently reports as UNTRACKED in
   * `projectDir` — the read gate for the Changes tab's new-file view (#710).
   *
   * ## Why git's own answer, and not a path guard
   *
   * The Changes tab renders an untracked file's CONTENT (it has no diff), and
   * until #710 it did so through the metadata-dir file surface — which 404'd for
   * every project whose working directory is somewhere else. Serving the file
   * from the working directory instead needs a guard, and the obvious one to
   * reach for is `project-files.ts`'s: refuse any path descending through a
   * dot-prefixed directory. That guard is right for the metadata dir and wrong
   * here, in both directions:
   *
   *  - **It under-blocks on a worktree.** A linked worktree's `.git` is a FILE,
   *    not a directory, so it is the LEAF — and the leaf is deliberately allowed
   *    there (an untracked `.gitignore` has to render). The file is only a
   *    `gitdir:` pointer, but serving it discloses the main checkout's path for
   *    no reason.
   *  - **It over-blocks on a real repo.** A brand-new untracked
   *    `.github/workflows/ci.yml` is an ordinary Changes-tab row, and a
   *    dot-directory rule refuses to render exactly the file the UI is listing.
   *
   * Asking git is both tighter and looser in the right places. `git status`
   * never reports `.git` (file or directory), never reports an IGNORED path —
   * so `.chats/` and anything else the repo excludes stays unreadable — and does
   * report `.github/…`. The set the route may serve is then, by construction,
   * exactly the set the pane already displays: no third notion of "allowed" to
   * keep in step with the other two.
   *
   * `:(literal)` disables pathspec magic, so a filename containing `*` or `[` is
   * matched as itself rather than as a pattern. False on any git failure.
   */
  async isUntrackedFile(projectDir: string, relPath: string): Promise<boolean> {
    if (!isSafeRelPath(relPath)) return false;
    if (!(await this.isRepoAt(projectDir))) return false;
    // Porcelain paths are REPO-ROOT relative; the caller's path is PROJECT
    // relative. Rebase with the same `--show-prefix` the status route uses, so
    // a project dir below the repo root compares like for like.
    let prefix = "";
    try {
      prefix = (await this.git(projectDir, ["rev-parse", "--show-prefix"])).trim();
    } catch {
      /* project dir is the repo root */
    }
    try {
      const out = await this.git(projectDir, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        `:(literal)${relPath}`,
      ]);
      return parsePorcelainZ(out).some(
        (f) =>
          f.untracked &&
          (prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path) === relPath,
      );
    } catch {
      return false;
    }
  }

  /**
   * `git diff --numstat` for a project's tracked working-tree changes, keyed by
   * PROJECT-relative path (`--relative` makes git emit paths relative to the
   * project dir, matching the porcelain paths). Binary changes report `-\t-` and
   * are flagged `binary`. Returns an empty map on any failure.
   */
  private async trackedNumstat(
    projectDir: string,
  ): Promise<Map<string, { added?: number; removed?: number; binary?: boolean }>> {
    const args = ["diff", "HEAD", "--numstat", "-z", "--relative", "--", "."];
    let out = "";
    try {
      out = await this.git(projectDir, args);
    } catch {
      // No HEAD yet (unborn branch) → plain working-tree numstat.
      try {
        out = await this.git(projectDir, ["diff", "--numstat", "-z", "--relative", "--", "."]);
      } catch {
        return new Map();
      }
    }
    return parseNumstatZ(out);
  }

  /**
   * Unified diff for a project's tracked changes (working tree vs HEAD), or for
   * a single file when `file` is given. Untracked files don't appear in a diff
   * (they're listed by `projectStatus`). Returns "" when not a repo / no diff.
   */
  async projectDiff(projectDir: string, file?: string): Promise<string> {
    if (!(await this.isRepoAt(projectDir))) return "";
    const args = ["diff", "HEAD", "--", file ?? "."];
    try {
      return await this.git(projectDir, args);
    } catch {
      // No HEAD yet (unborn branch) → fall back to a plain working-tree diff.
      try {
        return await this.git(projectDir, ["diff", "--", file ?? "."]);
      } catch {
        return "";
      }
    }
  }

  // --- phase 2: write surface (commit / push / remote) -------------------

  /** Commit identity (from config, no global git config needed). */
  private identity(): { name: string; email: string } {
    return this.author;
  }

  /**
   * Origin remote info + ahead/behind vs upstream (best-effort) for ONE
   * directory's repository, defaulting to the backing store.
   *
   * The `dir` parameter is issue #710. `remote()` and {@link push} were the last
   * two members of the per-project Changes surface still hard-wired to
   * `projectsRoot` after #597/#709 moved status/diff/commit onto the project's
   * `workingDir` — which made the pane's header self-contradictory: it showed the
   * WORKTREE's branch beside an ahead-count, a remote URL and a Push button that
   * all belonged to Paddock's own notes repo. Passing the working directory makes
   * every field in that header describe one repository.
   *
   * For a notebook project (and for the root workspace) the working directory is
   * inside `projectsRoot`, so this resolves to the same repo, same branch, same
   * upstream as before — the generalisation costs those shapes nothing.
   */
  async remote(dir: string = this.projectsRoot): Promise<{
    repo: boolean;
    configured: boolean;
    url?: string;
    branch?: string;
    ahead?: number;
    behind?: number;
  }> {
    if (!(await this.isRepoAt(dir))) return { repo: false, configured: false };
    let branch: string | undefined;
    try {
      branch = (await this.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (branch === "HEAD") branch = undefined;
    } catch {
      /* detached / unborn */
    }
    let url: string | undefined;
    try {
      url = (await this.git(dir, ["remote", "get-url", "origin"])).trim();
    } catch {
      return { repo: true, configured: false, branch };
    }
    let ahead: number | undefined;
    let behind: number | undefined;
    try {
      const counts = (
        await this.git(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
      ).trim();
      const [b, a] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
      behind = Number.isFinite(b) ? b : undefined;
      ahead = Number.isFinite(a) ? a : undefined;
    } catch {
      /* no upstream yet */
    }
    return { repo: true, configured: true, url, branch, ahead, behind };
  }

  /**
   * Stage + commit a single project's changes (tracked mods, deletions, and
   * untracked files within its subtree). `committed: false` when nothing was
   * pending. Explicit identity so the LXC needs no global git config.
   *
   * When `paths` (project-relative) is given, commit ONLY those files — the
   * pathspec scopes both the staging and the commit, so unselected changes stay
   * uncommitted (issue #258). Paths are validated to stay inside the subtree; an
   * all-invalid selection is an error rather than a silent commit-everything.
   * Omitting `paths` keeps the legacy commit-the-whole-subtree behavior.
   */
  async commitProject(
    projectDir: string,
    message: string,
    paths?: string[],
  ): Promise<{ committed: boolean; hash?: string; error?: string }> {
    if (!(await this.isRepoAt(projectDir))) return { committed: false, error: "not a repo" };
    const msg = message.trim() || "Update project";
    let pathspec: string[];
    if (paths && paths.length) {
      const safe = paths.filter(isSafeRelPath);
      if (!safe.length) return { committed: false, error: "no valid files selected" };
      pathspec = safe;
    } else {
      pathspec = ["."];
    }
    try {
      await this.git(projectDir, ["add", "-A", "--", ...pathspec]);
      const staged = (
        await this.git(projectDir, ["diff", "--cached", "--name-only", "--", ...pathspec])
      ).trim();
      if (!staged) return { committed: false };
      const { name, email } = this.identity();
      await this.git(projectDir, [
        "-c",
        `user.name=${name}`,
        "-c",
        `user.email=${email}`,
        "commit",
        "-m",
        msg,
        "--",
        ...pathspec,
      ]);
      const hash = (await this.git(projectDir, ["rev-parse", "HEAD"])).trim();
      return { committed: true, hash };
    } catch (err) {
      return { committed: false, error: errText(err) };
    }
  }

  /**
   * Uncommitted-file counts per top-level project subtree, in ONE `git status`
   * over the whole store (cheap — no per-project fan-out) so the projects grid
   * can flag "N uncommitted" without opening each project (issue #258). Keyed by
   * the first path segment (= project slug); only dirty projects appear. `{}`
   * when the store isn't a repo.
   */
  async dirtyCounts(): Promise<Record<string, number>> {
    if (!(await this.isRepo())) return {};
    try {
      const out = await this.git(this.projectsRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      const counts: Record<string, number> = {};
      for (const f of parsePorcelainZ(out)) {
        const slug = f.path.split("/")[0];
        if (slug) counts[slug] = (counts[slug] ?? 0) + 1;
      }
      return counts;
    } catch {
      return {};
    }
  }

  /**
   * Uncommitted-file count for ONE directory's own repository.
   *
   * The companion to {@link dirtyCounts} for a project whose working directory
   * lives outside `projectsRoot` (issue #206). That method answers the whole grid
   * in a single `git status` over the store, which is why it is cheap — and also
   * why it structurally cannot see a linked checkout: it buckets paths by their
   * first segment relative to the store, and a directory outside it has no such
   * segment. This one costs a subprocess, so callers use it only for the projects
   * the cheap sweep genuinely cannot cover.
   *
   * Returns 0 for a directory that isn't a repo, matching "nothing to report".
   */
  async dirtyCountAt(dir: string): Promise<number> {
    if (!(await this.isRepoAt(dir))) return 0;
    try {
      const out = await this.git(dir, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      return parsePorcelainZ(out).length;
    } catch {
      return 0;
    }
  }

  /**
   * Push one directory's current branch to origin (sets upstream on first push),
   * defaulting to the backing store. See {@link remote} for why `dir` exists —
   * in a linked WORKTREE `--abbrev-ref HEAD` is per-worktree, so this pushes the
   * branch the user is actually looking at rather than the store's.
   */
  async push(dir: string = this.projectsRoot): Promise<{ pushed: boolean; error?: string }> {
    if (!(await this.isRepoAt(dir))) return { pushed: false, error: "not a repo" };
    try {
      const branch = (await this.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      await this.git(dir, ["push", "--set-upstream", "origin", branch]);
      return { pushed: true };
    } catch (err) {
      return { pushed: false, error: errText(err) };
    }
  }
}

/**
 * A project-relative path is safe to hand to `git add`/`commit` as a pathspec
 * iff it stays inside the subtree: not absolute, no `..` segment, no NUL. Guards
 * the selective-commit `paths` param against escaping the project (issue #258).
 */
function isSafeRelPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\0")) return false;
  return !p.split("/").includes("..");
}

/**
 * Parse `git diff --numstat -z` output into a path→stat map. Each record is
 * `added\tremoved\t<path>`; a rename emits `added\tremoved\t` followed by two
 * extra NUL-separated tokens (old, new) — we key on the new path. `-` for
 * added/removed marks a binary change (no line stat).
 */
function parseNumstatZ(
  out: string,
): Map<string, { added?: number; removed?: number; binary?: boolean }> {
  const map = new Map<string, { added?: number; removed?: number; binary?: boolean }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const a = entry.slice(0, firstTab);
    const r = entry.slice(firstTab + 1, secondTab);
    let filePath = entry.slice(secondTab + 1);
    if (filePath === "") {
      // Rename/copy: the next two tokens are the old then new path.
      i++; // old
      filePath = parts[++i] ?? "";
    }
    if (!filePath) continue;
    const binary = a === "-" || r === "-";
    map.set(
      filePath,
      binary ? { binary: true } : { added: Number(a) || 0, removed: Number(r) || 0 },
    );
  }
  return map;
}

/**
 * All-added line stat for an UNTRACKED file (it has no diff): read it (bounded)
 * and count lines, flagging binary on a NUL byte or when it's too large to read.
 * Best-effort — returns `{}` when the file can't be read.
 */
async function untrackedStat(
  projectDir: string,
  relPath: string,
): Promise<{ added?: number; removed?: number; binary?: boolean }> {
  const abs = path.join(projectDir, relPath);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return {};
    if (st.size > UNTRACKED_STAT_CAP) return { binary: true };
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return { binary: true };
    if (buf.length === 0) return { added: 0, removed: 0 };
    let added = 0;
    for (const byte of buf) if (byte === 10) added++;
    if (buf[buf.length - 1] !== 10) added++; // last line without a trailing newline
    return { added, removed: 0 };
  } catch {
    return {};
  }
}

/** Best-effort error text from an execFile rejection (prefers stderr). */
function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim();
}

/**
 * Parse `git status --porcelain=v1 -z` output. Records are NUL-separated; a
 * rename/copy record is followed by an extra NUL-separated source path which we
 * consume (and ignore for display — the destination path is what's shown).
 */
function parsePorcelainZ(out: string): GitFileChange[] {
  const parts = out.split("\0");
  const files: GitFileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    // Rename/copy: the next token is the source path — skip it.
    if (x === "R" || x === "C") i++;
    const untracked = x === "?" && y === "?";
    files.push({
      path,
      status: `${x}${y}`.trim(),
      staged: !untracked && x !== " ",
      untracked,
    });
  }
  return files;
}
