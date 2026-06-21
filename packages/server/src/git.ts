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
import { promisify } from "node:util";

const run = promisify(execFile);

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

    return { repo: true, branch, files, clean: files.length === 0 };
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
