/**
 * #955: the auto-memory dir paddock hands Claude Code must be (a) the SAME
 * directory Claude Code would pick on its own, and (b) spelled without any
 * symlink in it — the harness resolves symlinks before matching a write
 * against the memory dir, and paddock's `<home>/projects/<enc>` is always one.
 *
 * The write itself is exercised against the real binary in
 * `test/integration/auto-memory-write.test.ts`; this pins the path logic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  memoryRoot,
  realpathLenient,
  resolveAutoMemoryDir,
} from "../../src/auto-memory.js";
import { buildAgentConfig, buildTriggerConfig } from "../../src/herdctl-agent-config.js";
import { EMPTY_MCP_SOURCES } from "../../src/claude-mcp.js";
import { EMPTY_HOST_PLUGINS } from "../../src/claude-plugins.js";
import {
  ensureProjectChats,
  encodedTranscriptDir,
  projectChatsDir,
  type ClaudeHomeTarget,
} from "../../src/transcripts.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";
import type { PaddockTrigger } from "../../src/trigger-config.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

/** True when no prefix of `p` that exists on disk is a symlink. */
async function hasNoSymlinkComponent(p: string): Promise<boolean> {
  const parts = path.resolve(p).split(path.sep).filter(Boolean);
  let cur = path.sep;
  for (const part of parts) {
    cur = path.join(cur, part);
    const st = await fs.lstat(cur).catch(() => null);
    if (!st) return true; // the rest does not exist yet — nothing to follow
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

let tmp: string;
beforeEach(async () => {
  tmp = await makeTmpDir("paddock-auto-memory-");
});
afterEach(async () => {
  await rmTmpDir(tmp);
});

describe("memoryRoot — the directory Claude Code keys memory on", () => {
  it("is the cwd itself outside git", async () => {
    const dir = path.join(tmp, "plain");
    await fs.mkdir(dir);
    expect(await memoryRoot(dir)).toBe(dir);
  });

  it("is the repo root for the root and for a subdirectory", async () => {
    const repo = path.join(tmp, "repo");
    await fs.mkdir(path.join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    expect(await memoryRoot(repo)).toBe(repo);
    expect(await memoryRoot(path.join(repo, "sub"))).toBe(repo);
  });

  // A notebook project inside the notes repo is the subdirectory case: it must
  // keep landing on the notes repo's memory, which is what it uses today.
  it("is the MAIN checkout's root for a linked worktree", async () => {
    const repo = path.join(tmp, "repo");
    await fs.mkdir(repo);
    git(repo, "init", "-q");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
    const wt = path.join(tmp, "wt");
    git(repo, "worktree", "add", "-q", wt);
    expect(await memoryRoot(wt)).toBe(repo);
  });

  it("falls back to the cwd when the directory does not exist", async () => {
    const missing = path.join(tmp, "nope");
    expect(await memoryRoot(missing)).toBe(missing);
  });

  // Claude Code's own cwd is a realpath, so a symlinked non-git cwd keys on its target.
  it("keys a symlinked non-git cwd on its realpath", async () => {
    const real = path.join(tmp, "plain");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(tmp, "link"));
    expect(await memoryRoot(path.join(tmp, "link"))).toBe(real);
  });

  // A `.git` FILE that is not a linked worktree (a submodule's gitdir has no
  // commondir) keys on the checkout itself.
  it("keys a .git file with no commondir (submodule shape) on the checkout", async () => {
    const sub = path.join(tmp, "outer", "sub");
    const modDir = path.join(tmp, "outer", ".git", "modules", "sub");
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(modDir, { recursive: true });
    await fs.writeFile(path.join(sub, ".git"), `gitdir: ${modDir}\n`);
    expect(await memoryRoot(path.join(sub))).toBe(sub);
  });

  // The review of #972 found `git rev-parse` re-keying memory whenever git
  // disagreed with Claude Code's filesystem walk. No git is consulted now: an
  // inherited GIT_DIR, which would have pointed every project at one repo, is inert.
  it("ignores GIT_DIR / GIT_WORK_TREE in the environment", async () => {
    const repo = path.join(tmp, "repo");
    const other = path.join(tmp, "other");
    await fs.mkdir(repo);
    await fs.mkdir(other);
    git(repo, "init", "-q");
    git(other, "init", "-q");
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      expect(await memoryRoot(repo)).toBe(repo);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("realpathLenient", () => {
  it("resolves the existing prefix and keeps the missing tail", async () => {
    const real = path.join(tmp, "real");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(tmp, "link"));
    expect(await realpathLenient(path.join(tmp, "link", "memory", "x"))).toBe(
      path.join(real, "memory", "x"),
    );
  });
});

describe("resolveAutoMemoryDir under paddock's transcript symlink", () => {
  const home = () => path.join(tmp, "claude-home");
  const userHome = () => path.join(tmp, "user", ".claude");

  it.each(["own", "host"] as const)(
    "names the symlink's TARGET under transcripts: %s, and the same directory",
    async (transcripts) => {
      const projectDir = path.join(tmp, "proj");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(userHome(), { recursive: true });
      const target: ClaudeHomeTarget = { path: home(), transcripts, userHome: userHome() };
      await ensureProjectChats(projectDir, projectDir, target);

      const literal = path.join(encodedTranscriptDir(home(), projectDir), "memory");
      // The fixture must be able to fail: the default spelling runs through a symlink.
      expect(await hasNoSymlinkComponent(literal)).toBe(false);

      const resolved = await resolveAutoMemoryDir(home(), projectDir);
      expect(await hasNoSymlinkComponent(resolved)).toBe(true);
      // Same directory, different spelling.
      await fs.mkdir(literal, { recursive: true });
      expect(await fs.realpath(literal)).toBe(resolved);
      expect(resolved).toBe(
        transcripts === "own"
          ? path.join(projectChatsDir(projectDir), "memory")
          : path.join(userHome(), "projects", path.basename(encodedTranscriptDir(home(), projectDir)), "memory"),
      );
    },
  );

  // `memory` itself is a symlink: following it would aim Claude Code's
  // write-without-approval grant wherever it points, so the setting is withheld.
  it("refuses a memory entry that is itself a symlink", async () => {
    const projectDir = path.join(tmp, "proj");
    await fs.mkdir(projectDir, { recursive: true });
    await ensureProjectChats(projectDir, projectDir, {
      path: home(),
      transcripts: "own",
      userHome: userHome(),
    });
    const elsewhere = path.join(tmp, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(projectChatsDir(projectDir), "memory"));
    expect(await resolveAutoMemoryDir(home(), projectDir)).toBeUndefined();
  });

  it("keys a repo-backed checkout on its repo root and follows the .chats link", async () => {
    const projectDir = path.join(tmp, "proj");
    const checkout = path.join(projectDir, "proj");
    await fs.mkdir(checkout, { recursive: true });
    git(checkout, "init", "-q");
    await ensureProjectChats(checkout, projectDir, {
      path: home(),
      transcripts: "own",
      userHome: userHome(),
    });
    expect(await resolveAutoMemoryDir(home(), checkout)).toBe(
      path.join(projectChatsDir(projectDir), "memory"),
    );
  });
});

describe("agent configs carry autoMemoryDirectory as a flag setting", () => {
  const cfg = { nativeSystemPrompt: true, browserMcp: false, dataDir: "/tmp/x" } as unknown as PaddockConfig;
  const project = (docker = false) =>
    ({ slug: "api", name: "API", dir: "/w/api", workingDir: "/w/api", docker }) as unknown as Project;
  const trigger = {
    trigger: { type: "event", event: "afterTurn" },
    run: { prompt: "x" },
  } as unknown as PaddockTrigger;
  const keeper = (p: Project, dir?: string) =>
    buildAgentConfig(cfg, p, undefined, EMPTY_MCP_SOURCES, EMPTY_HOST_PLUGINS, undefined, dir);

  it("sets it on the keeper and on a trigger agent", () => {
    expect(keeper(project(), "/real/memory").settings).toEqual({
      autoMemoryDirectory: "/real/memory",
    });
    expect(
      buildTriggerConfig(cfg, project(), "t", trigger, undefined, "/real/memory").settings,
    ).toEqual({ autoMemoryDirectory: "/real/memory" });
  });

  it("omits settings when unresolved, so the config is unchanged", () => {
    expect(keeper(project())).not.toHaveProperty("settings");
  });

  it("omits it for a docker project, whose container cannot see a host path", () => {
    expect(keeper(project(true), "/real/memory")).not.toHaveProperty("settings");
  });
});
