import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureGitignoreEntries, ensureRootGitignore } from "../../src/gitignore.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("ensureGitignoreEntries", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir("paddock-ignore-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  const read = () => fs.readFile(path.join(dir, ".gitignore"), "utf8");

  it("creates the file with the header + entries when absent", async () => {
    await ensureGitignoreEntries(dir, ["/a/", "/b/"], "# why");
    expect(await read()).toBe("# why\n/a/\n/b/\n");
  });

  it("appends ONLY the missing entries, preserving operator content", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), "# mine\nnode_modules\n/a/\n", "utf8");
    await ensureGitignoreEntries(dir, ["/a/", "/b/"], "# why");
    expect(await read()).toBe("# mine\nnode_modules\n/a/\n/b/\n");
  });

  it("leaves a file that already covers everything byte-identical", async () => {
    const before = "/a/\n/b/";
    await fs.writeFile(path.join(dir, ".gitignore"), before, "utf8");
    await ensureGitignoreEntries(dir, ["/a/", "/b/"], "# why");
    expect(await read()).toBe(before);
  });
});

describe("ensureRootGitignore (#512 — the root agent's cwd IS the backing repo)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir("paddock-root-ignore-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  const ignorePath = () => path.join(dir, ".gitignore");

  it("ignores the root chat's working state once the projects root is a repo", async () => {
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await ensureRootGitignore(dir);
    const body = await fs.readFile(ignorePath(), "utf8");
    // Anchored so they match ONLY at the repo root and don't shadow a project's
    // own sidecar rules one level down.
    expect(body).toContain("/.chats/\n");
    expect(body).toContain("/.playwright-mcp/\n");
  });

  it("writes nothing when the projects root is not a git repo", async () => {
    await ensureRootGitignore(dir);
    await expect(fs.stat(ignorePath())).rejects.toThrow();
  });

  it("accepts a `.git` FILE (worktree/submodule checkout)", async () => {
    await fs.writeFile(path.join(dir, ".git"), "gitdir: /elsewhere\n", "utf8");
    await ensureRootGitignore(dir);
    expect(await fs.readFile(ignorePath(), "utf8")).toContain("/.chats/");
  });

  it("is idempotent and never rewrites an operator's existing rules", async () => {
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(ignorePath(), "*/.chats/\n*/.playwright-mcp/\n", "utf8");
    await ensureRootGitignore(dir);
    const once = await fs.readFile(ignorePath(), "utf8");
    await ensureRootGitignore(dir);
    expect(await fs.readFile(ignorePath(), "utf8")).toBe(once);
    // The operator's own `*/` rules survive; only the missing anchored ones are added.
    expect(once.startsWith("*/.chats/\n*/.playwright-mcp/\n")).toBe(true);
    expect(once).toContain("/.chats/\n");
  });

  it("never throws when the projects root does not exist", async () => {
    await expect(ensureRootGitignore(path.join(dir, "nope"))).resolves.toBeUndefined();
  });
});
