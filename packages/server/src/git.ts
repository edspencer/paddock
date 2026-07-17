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

  constructor(private readonly projectsRoot: string) {}

  /** Run git in a directory, returning stdout. Throws on non-zero exit. */
  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  }

  /**
   * Whether the backing store is a git working tree. Cached after the first
   * successful check (repo-ness doesn't change under a running server); a thrown
   * git / missing-binary error resolves to `false`.
   */
  async isRepo(): Promise<boolean> {
    if (this.repoFlag !== null) return this.repoFlag;
    try {
      const out = await this.git(this.projectsRoot, [
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      this.repoFlag = out.trim() === "true";
    } catch {
      this.repoFlag = false;
    }
    return this.repoFlag;
  }

  /** Force the next `isRepo()` to re-check (e.g. after `git init` at runtime). */
  resetRepoCache(): void {
    this.repoFlag = null;
  }

  /**
   * Status for one project's subtree. Returns `{ repo: false }` when the store
   * isn't a repo (the UI then hides the git affordance). Paths are relative to
   * `projectDir`.
   */
  async projectStatus(projectDir: string): Promise<GitProjectStatus> {
    if (!(await this.isRepo())) {
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
    if (!(await this.isRepo())) return "";
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

  /** Commit identity, from env with sensible defaults (no global git config needed). */
  private identity(): { name: string; email: string } {
    return {
      name: process.env.PADDOCK_GIT_AUTHOR_NAME ?? "Paddock",
      email: process.env.PADDOCK_GIT_AUTHOR_EMAIL ?? "paddock@localhost",
    };
  }

  /** Origin remote info + ahead/behind vs upstream (best-effort). */
  async remote(): Promise<{
    repo: boolean;
    configured: boolean;
    url?: string;
    branch?: string;
    ahead?: number;
    behind?: number;
  }> {
    if (!(await this.isRepo())) return { repo: false, configured: false };
    let branch: string | undefined;
    try {
      branch = (await this.git(this.projectsRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (branch === "HEAD") branch = undefined;
    } catch {
      /* detached / unborn */
    }
    let url: string | undefined;
    try {
      url = (await this.git(this.projectsRoot, ["remote", "get-url", "origin"])).trim();
    } catch {
      return { repo: true, configured: false, branch };
    }
    let ahead: number | undefined;
    let behind: number | undefined;
    try {
      const counts = (
        await this.git(this.projectsRoot, [
          "rev-list",
          "--left-right",
          "--count",
          "@{upstream}...HEAD",
        ])
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
    if (!(await this.isRepo())) return { committed: false, error: "not a repo" };
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

  /** Push the current branch to origin (sets upstream on first push). */
  async push(): Promise<{ pushed: boolean; error?: string }> {
    if (!(await this.isRepo())) return { pushed: false, error: "not a repo" };
    try {
      const branch = (
        await this.git(this.projectsRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
      ).trim();
      await this.git(this.projectsRoot, ["push", "--set-upstream", "origin", branch]);
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
