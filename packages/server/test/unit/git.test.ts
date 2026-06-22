/**
 * Unit tests for GitService (git.ts) against REAL temp git repos. The git
 * integration test covers status/diff/commit through the app; this reaches the
 * remaining branches directly: not-a-repo guards, the configured-remote +
 * ahead/behind path, push (success + set-upstream), single-file diff, the
 * unborn-branch diff fallback, rename-prefix stripping, and commit error/no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitService } from "../../src/git.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env: GIT_ENV });
  return stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
}

describe("GitService", () => {
  let root: string; // a temp parent holding repos
  beforeEach(async () => {
    root = await makeTmpDir("paddock-gitsvc-");
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  // --- not-a-repo guards ------------------------------------------------------

  describe("when the store is NOT a repo", () => {
    it("reports repo:false / not-a-repo across the surface", async () => {
      const dir = path.join(root, "plain");
      await fs.mkdir(dir, { recursive: true });
      const svc = new GitService(dir);

      expect(await svc.isRepo()).toBe(false);
      expect(await svc.projectStatus(dir)).toEqual({ repo: false, files: [], clean: true });
      expect(await svc.projectDiff(dir)).toBe("");
      expect(await svc.remote()).toEqual({ repo: false, configured: false });
      expect(await svc.commitProject(dir, "msg")).toEqual({
        committed: false,
        error: "not a repo",
      });
      expect(await svc.push()).toEqual({ pushed: false, error: "not a repo" });
    });
  });

  // --- repo, no remote --------------------------------------------------------

  describe("a repo with no configured remote", () => {
    let repo: string;
    let svc: GitService;
    beforeEach(async () => {
      repo = path.join(root, "repo");
      await fs.mkdir(repo, { recursive: true });
      await initRepo(repo);
      await fs.writeFile(path.join(repo, "a.txt"), "one\n", "utf8");
      await git(repo, "add", "-A");
      await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init");
      svc = new GitService(repo);
    });

    it("remote() reports repo:true, configured:false", async () => {
      const r = await svc.remote();
      expect(r.repo).toBe(true);
      expect(r.configured).toBe(false);
      expect(r.branch).toBe("main");
    });

    it("push() fails cleanly when there is no origin", async () => {
      const res = await svc.push();
      expect(res.pushed).toBe(false);
      expect(res.error).toBeTruthy();
    });

    it("commitProject commits a change and returns a 40-char hash; a 2nd is a no-op", async () => {
      await fs.appendFile(path.join(repo, "a.txt"), "two\n", "utf8");
      const c1 = await svc.commitProject(repo, "more");
      expect(c1.committed).toBe(true);
      expect(c1.hash).toMatch(/^[0-9a-f]{40}$/);
      const c2 = await svc.commitProject(repo, "nothing");
      expect(c2.committed).toBe(false);
    });

    it("projectDiff(file) scopes the diff to a single file", async () => {
      await fs.appendFile(path.join(repo, "a.txt"), "changed\n", "utf8");
      await fs.writeFile(path.join(repo, "b.txt"), "new\n", "utf8");
      await git(repo, "add", "b.txt");
      await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add b");
      await fs.appendFile(path.join(repo, "b.txt"), "more\n", "utf8");

      const onlyA = await svc.projectDiff(repo, "a.txt");
      expect(onlyA).toContain("a.txt");
      expect(onlyA).not.toContain("b.txt");
    });

    it("isRepo() caches; resetRepoCache forces a re-check", async () => {
      expect(await svc.isRepo()).toBe(true);
      // cached path (second call returns the same without re-running git)
      expect(await svc.isRepo()).toBe(true);
      svc.resetRepoCache();
      expect(await svc.isRepo()).toBe(true);
    });

    it("reports a renamed file by its destination path (rename record consumed)", async () => {
      await git(repo, "mv", "a.txt", "renamed.txt");
      const status = await svc.projectStatus(repo);
      const paths = status.files.map((f) => f.path);
      expect(paths).toContain("renamed.txt");
    });
  });

  // --- unborn branch (no commits yet) ----------------------------------------

  it("projectDiff falls back to a working-tree diff on an unborn branch", async () => {
    const repo = path.join(root, "unborn");
    await fs.mkdir(repo, { recursive: true });
    await initRepo(repo);
    // No commit yet → HEAD is unborn, so `git diff HEAD` errors and the service
    // falls back to a plain working-tree diff. Stage a file then modify it so the
    // working tree differs from the index (a tracked, unstaged change).
    await fs.writeFile(path.join(repo, "x.txt"), "hello\n", "utf8");
    await git(repo, "add", "x.txt");
    await fs.appendFile(path.join(repo, "x.txt"), "world\n", "utf8");
    const svc = new GitService(repo);
    const diff = await svc.projectDiff(repo);
    expect(diff).toContain("x.txt");
  });

  // --- configured remote + ahead/behind --------------------------------------

  describe("a repo with a bare origin remote", () => {
    let repo: string;
    let svc: GitService;
    beforeEach(async () => {
      const bare = path.join(root, "origin.git");
      await fs.mkdir(bare, { recursive: true });
      await git(bare, "init", "--bare", "-b", "main");

      repo = path.join(root, "work");
      await fs.mkdir(repo, { recursive: true });
      await initRepo(repo);
      await fs.writeFile(path.join(repo, "f.txt"), "1\n", "utf8");
      await git(repo, "add", "-A");
      await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "c1");
      await git(repo, "remote", "add", "origin", bare);
      svc = new GitService(repo);
    });

    it("push() sets upstream on first push and reports pushed:true", async () => {
      const res = await svc.push();
      expect(res.pushed).toBe(true);
    });

    it("remote() reports the configured url + ahead count after a local commit", async () => {
      await svc.push(); // establish upstream
      // One local commit ahead of origin.
      await fs.appendFile(path.join(repo, "f.txt"), "2\n", "utf8");
      await git(repo, "add", "-A");
      await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "c2");

      const r = await svc.remote();
      expect(r.repo).toBe(true);
      expect(r.configured).toBe(true);
      expect(r.url).toContain("origin.git");
      expect(r.branch).toBe("main");
      expect(r.ahead).toBe(1);
      expect(r.behind).toBe(0);
    });
  });
});
