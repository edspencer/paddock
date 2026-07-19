/**
 * Integration test-app factory.
 *
 * Boots the REAL paddock app (buildApp) + REAL @herdctl/core FleetManager + the
 * REAL CLI runtime against a temp data dir, with the fake `claude` first on
 * PATH so NO Anthropic calls happen. Returns the BuiltApp plus the temp paths
 * and a teardown that closes the fleet/server and restores env + cwd.
 *
 * Why we set HOME: the CLI runtime locates session transcripts via
 * os.homedir()/.claude/projects/<encoded-cwd>, and paddock's transcripts.ts
 * symlinks that encoded path to <projectDir>/.chats using the same home. Both
 * must agree, so each test gets a throwaway HOME under its temp dir.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp, type BuiltApp } from "../../src/app.js";
import { makeTmpDir, rmTmpDir } from "./tmp.js";

// The fake `claude` lives at the repo root: <repo>/test/bin/claude. This file
// is packages/server/test/helpers/app.ts, so the repo root is four levels up.
const FAKE_BIN = fileURLToPath(new URL("../../../../test/bin", import.meta.url));

export interface TestApp extends BuiltApp {
  /** Root temp dir holding data/, home/, etc. */
  tmp: string;
  /** The throwaway HOME (== ~/.claude lives under here). */
  home: string;
  /** The projects root (PADDOCK_PROJECTS_DIR). */
  projectsRoot: string;
  /** Teardown: close fleet+server, restore env, remove temp dirs. */
  teardown: () => Promise<void>;
}

interface StartOptions {
  /** Optional JSON map of prompt→reply handed to the fake claude. */
  script?: Record<string, string>;
  /** Pre-create the projects root as a git repo (for git tests). */
  gitRepo?: boolean;
  /**
   * Override the post-turn sweep's min interval (ms). Set to 0 to make the sweep
   * fire on the next tick instead of waiting the 5-min default — lets a test
   * drive the curation path deterministically. Sets PADDOCK_SWEEP_MIN_INTERVAL_MS.
   */
  sweepIntervalMs?: number;
  /**
   * Configure the GitHub device-flow client id (folded into PaddockConfig, issue
   * #269). Sets `PADDOCK_GITHUB_CLIENT_ID` before build so it lands in `cfg`; a
   * bare app (no value) reports the GitHub feature as "not configured".
   */
  githubClientId?: string;
}

/**
 * Resolve the fake-claude bin dir to an absolute path. Exposed so the E2E
 * harness can prepend it to PATH too.
 */
export function fakeBinDir(): string {
  return FAKE_BIN;
}

export async function startTestApp(opts: StartOptions = {}): Promise<TestApp> {
  const tmp = await makeTmpDir("paddock-it-");
  const home = path.join(tmp, "home");
  const dataDir = path.join(tmp, "data");
  const projectsRoot = path.join(dataDir, "projects");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });

  // Snapshot env we mutate so teardown can restore it.
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PADDOCK_DATA_DIR: process.env.PADDOCK_DATA_DIR,
    PADDOCK_PROJECTS_DIR: process.env.PADDOCK_PROJECTS_DIR,
    PADDOCK_STATE_DIR: process.env.PADDOCK_STATE_DIR,
    PADDOCK_HERDCTL_CONFIG: process.env.PADDOCK_HERDCTL_CONFIG,
    PADDOCK_SCRATCH_DIR: process.env.PADDOCK_SCRATCH_DIR,
    PADDOCK_WEB_DIST: process.env.PADDOCK_WEB_DIST,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    PADDOCK_FAKE_SCRIPT: process.env.PADDOCK_FAKE_SCRIPT,
    PADDOCK_FAKE_SWEEP: process.env.PADDOCK_FAKE_SWEEP,
    PADDOCK_SWEEP_MIN_INTERVAL_MS: process.env.PADDOCK_SWEEP_MIN_INTERVAL_MS,
    PADDOCK_KEEPER_DRIVE_MODE: process.env.PADDOCK_KEEPER_DRIVE_MODE,
    PADDOCK_GITHUB_CLIENT_ID: process.env.PADDOCK_GITHUB_CLIENT_ID,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };

  process.env.HOME = home;
  delete process.env.CLAUDE_HOME; // fall back to $HOME/.claude, matching the CLI runtime
  // Hermetic drive mode: this integration harness drives turns through a fake
  // `claude` on PATH, which only the CLI (batch) runtime uses — the SDK/session
  // runtime needs a real login ("Not logged in"). The built-in default is now
  // `session` (#316) and the projects box also exports
  // PADDOCK_KEEPER_DRIVE_MODE=session, so we can't rely on the default or on
  // deleting the var; explicitly PIN `batch` so the suite is deterministic
  // regardless of the box env (CI has it unset; a dev box may not). The session
  // path has its own coverage (unit/mocked harnesses).
  process.env.PADDOCK_KEEPER_DRIVE_MODE = "batch";
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.PADDOCK_DATA_DIR = dataDir;
  process.env.PADDOCK_PROJECTS_DIR = projectsRoot;
  process.env.LOG_LEVEL = process.env.PADDOCK_TEST_LOG ?? "silent";
  // Point the web-dist somewhere that does not exist so the app runs API-only
  // (component/E2E tests build + serve the SPA via a different harness).
  process.env.PADDOCK_WEB_DIST = path.join(tmp, "no-web-dist");

  let scriptPath: string | undefined;
  if (opts.script) {
    scriptPath = path.join(tmp, "fake-script.json");
    await fs.writeFile(scriptPath, JSON.stringify(opts.script), "utf8");
    process.env.PADDOCK_FAKE_SCRIPT = scriptPath;
  } else {
    delete process.env.PADDOCK_FAKE_SCRIPT;
  }

  if (opts.sweepIntervalMs !== undefined) {
    process.env.PADDOCK_SWEEP_MIN_INTERVAL_MS = String(opts.sweepIntervalMs);
  } else {
    delete process.env.PADDOCK_SWEEP_MIN_INTERVAL_MS;
  }

  if (opts.githubClientId !== undefined) {
    process.env.PADDOCK_GITHUB_CLIENT_ID = opts.githubClientId;
  } else {
    delete process.env.PADDOCK_GITHUB_CLIENT_ID;
  }

  if (opts.gitRepo) {
    await initGitRepo(projectsRoot);
  }

  const built = await buildApp({ serveStatic: false });
  await built.app.ready();

  const teardown = async () => {
    await built.close().catch(() => undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rmTmpDir(tmp);
  };

  return {
    ...built,
    tmp,
    home,
    projectsRoot,
    teardown,
  };
}

/** Initialize a git repo at `dir` with an initial empty commit on `main`. */
async function initGitRepo(dir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  await run("git", ["init", "-b", "main"], { cwd: dir, env });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir, env });
  await run("git", ["config", "user.name", "Test"], { cwd: dir, env });
  await fs.writeFile(path.join(dir, ".gitkeep"), "", "utf8");
  await run("git", ["add", "-A"], { cwd: dir, env });
  await run("git", ["commit", "-m", "init"], { cwd: dir, env });
}
