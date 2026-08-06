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
  /**
   * Instance offered-models allow-list (issue #457 Step 2). Sets `PADDOCK_MODELS`
   * (comma-separated) before build so it lands in `cfg.models` — narrows what
   * `/api/models` offers and what a per-project `models` override may subset.
   */
  models?: string[];
  /**
   * Instance YAML config (issue #270) for this app, written to the temp dir and
   * pointed at via `PADDOCK_CONFIG`. Use for config that has no env equivalent —
   * e.g. the `managementApi.clients` block (#312), which is file-only by design.
   */
  configFile?: Record<string, unknown>;
  /**
   * A synthetic `~/.claude.json` written into the throwaway HOME before build
   * (#691 step 5). That file is the host's MCP-server declaration and it lives
   * BESIDE the Claude home rather than inside it, so no other helper reaches it.
   * Always synthetic: the real one on a dev box holds a user's own servers.
   */
  hostClaudeJson?: Record<string, unknown>;
  /**
   * Synthetic host Claude Code PLUGINS (#700), planted under
   * `<home>/.claude/plugins/`: one `installed_plugins.json` registry entry per
   * key, each pointing at a directory with a `.claude-plugin/plugin.json` and
   * (when given) a `.mcp.json`.
   *
   * Always synthetic, and nothing ever runs them — a plugin directory is data
   * until a turn loads it, and no turn runs in these tests. The real plugin root
   * on a dev box holds a user's own plugins and their credentials.
   */
  hostPlugins?: Record<string, { mcpServers?: Record<string, unknown> }>;
  /**
   * Extra environment variables to set before build (restored on teardown).
   * Needed for config that is REFERENCED from the YAML rather than inlined —
   * management-API tokens are `ref: env:VAR`, so the test must supply the var.
   */
  env?: Record<string, string>;
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
    PADDOCK_WEB_DIST: process.env.PADDOCK_WEB_DIST,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    PADDOCK_CLAUDE_CREDENTIALS: process.env.PADDOCK_CLAUDE_CREDENTIALS,
    PADDOCK_CLAUDE_INSTRUCTIONS: process.env.PADDOCK_CLAUDE_INSTRUCTIONS,
    PADDOCK_CLAUDE_HOOKS: process.env.PADDOCK_CLAUDE_HOOKS,
    PADDOCK_CLAUDE_MCP_SERVERS: process.env.PADDOCK_CLAUDE_MCP_SERVERS,
    PADDOCK_FAKE_SCRIPT: process.env.PADDOCK_FAKE_SCRIPT,
    PADDOCK_FAKE_SWEEP: process.env.PADDOCK_FAKE_SWEEP,
    PADDOCK_SWEEP_MIN_INTERVAL_MS: process.env.PADDOCK_SWEEP_MIN_INTERVAL_MS,
    PADDOCK_DRIVE_MODE: process.env.PADDOCK_DRIVE_MODE,
    PADDOCK_GITHUB_CLIENT_ID: process.env.PADDOCK_GITHUB_CLIENT_ID,
    PADDOCK_MODELS: process.env.PADDOCK_MODELS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    HOST: process.env.HOST,
    PADDOCK_HOST: process.env.PADDOCK_HOST,
    PADDOCK_DANGEROUSLY_ALLOW_OPEN: process.env.PADDOCK_DANGEROUSLY_ALLOW_OPEN,
    PADDOCK_CONFIG: process.env.PADDOCK_CONFIG,
    PADDOCK_ENVIRONMENT_PROMPT: process.env.PADDOCK_ENVIRONMENT_PROMPT,
    PADDOCK_FAKE_INVOCATION_LOG: process.env.PADDOCK_FAKE_INVOCATION_LOG,
    ...Object.fromEntries(Object.keys(opts.env ?? {}).map((k) => [k, process.env[k]])),
  };

  process.env.HOME = home;
  // Hermetic bind: the safe-by-default guard (#435) refuses a non-loopback bind
  // under auth=none, and a dev box may export HOST=0.0.0.0. Pin loopback so the
  // in-process app builds deterministically regardless of the ambient env (CI
  // leaves HOST unset, where the new loopback default applies anyway).
  process.env.HOST = "127.0.0.1";
  delete process.env.PADDOCK_HOST;
  delete process.env.PADDOCK_DANGEROUSLY_ALLOW_OPEN;
  // Cleared so the suite exercises the DEFAULT resolution —
  // `<dataDir>/claude-home`. A dev box may export `CLAUDE_CONFIG_DIR`, and it is
  // honoured (#691), so without this the whole suite would silently run against
  // the ambient home — or, if that home is the user's own `~/.claude`, refuse to
  // boot at all.
  delete process.env.CLAUDE_CONFIG_DIR;
  // Same reasoning for the secure-storage scope (#691, `claude.credentials`).
  // `buildApp` WRITES this variable — it is how the credentials mode reaches the
  // runtime — so it must start from a known state, and the snapshot above
  // restores whatever the box had. An operator-set value is honoured over the
  // config key, so an ambient one would make the mode untestable; a stale ""
  // from a previous app in this same worker would be indistinguishable from
  // paddock's own.
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete process.env.PADDOCK_CLAUDE_CREDENTIALS;
  // And the two levers #691 step 4 added, for the same reason: an ambient
  // PADDOCK_CLAUDE_HOOKS=host on a dev box would make the suite assert the
  // opposite of the shipped default.
  delete process.env.PADDOCK_CLAUDE_INSTRUCTIONS;
  delete process.env.PADDOCK_CLAUDE_HOOKS;
  // And step 5's, which would otherwise make `buildApp` read the DEV BOX's real
  // ~/.claude.json — the one file this suite must never depend on the contents of.
  delete process.env.PADDOCK_CLAUDE_MCP_SERVERS;
  // Hermetic drive mode: this integration harness drives turns through a fake
  // `claude` on PATH, which only the CLI (batch) runtime uses — the SDK/session
  // runtime needs a real login ("Not logged in"). The built-in default is now
  // `session` (#316) and the projects box also exports
  // PADDOCK_DRIVE_MODE=session, so we can't rely on the default or on
  // deleting the var; explicitly PIN `batch` so the suite is deterministic
  // regardless of the box env (CI has it unset; a dev box may not). The session
  // path has its own coverage (unit/mocked harnesses).
  process.env.PADDOCK_DRIVE_MODE = "batch";
  // #635: a defined-but-blank PADDOCK_ENVIRONMENT_PROMPT is the opt-out, so an
  // ambient value on a dev box would silently change what every turn's system
  // prompt looks like. Clear it; tests that want one pass it via `opts.env`.
  delete process.env.PADDOCK_ENVIRONMENT_PROMPT;
  delete process.env.PADDOCK_FAKE_INVOCATION_LOG;
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

  if (opts.models !== undefined) {
    process.env.PADDOCK_MODELS = opts.models.join(",");
  } else {
    delete process.env.PADDOCK_MODELS;
  }

  // Instance YAML config (#270). Written before build and pointed at explicitly,
  // so it layers under env exactly as a real deployment's file does.
  if (opts.configFile) {
    const YAML = await import("yaml");
    const configPath = path.join(tmp, "paddock.config.yaml");
    await fs.writeFile(configPath, YAML.stringify(opts.configFile), "utf8");
    process.env.PADDOCK_CONFIG = configPath;
  } else {
    delete process.env.PADDOCK_CONFIG;
  }

  // The host's MCP declarations (#691 step 5). `<home>/.claude.json`, not
  // `<home>/.claude/.claude.json` — that asymmetry is the whole reason the lever
  // could not be a symlink bridge.
  if (opts.hostClaudeJson) {
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify(opts.hostClaudeJson, null, 2),
      "utf8",
    );
  }

  // The host's plugins (#700). `<home>/.claude/plugins/`, enumerated from the
  // CLI's own `installed_plugins.json` registry rather than by scanning — see
  // `claude-plugins.ts` for why that file is the source of truth.
  if (opts.hostPlugins) {
    const root = path.join(home, ".claude", "plugins");
    const registry: Record<string, unknown[]> = {};
    for (const [name, decl] of Object.entries(opts.hostPlugins)) {
      const dir = path.join(root, "cache", "test-marketplace", name, "1.0.0");
      await fs.mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name }),
        "utf8",
      );
      if (decl.mcpServers) {
        await fs.writeFile(
          path.join(dir, ".mcp.json"),
          JSON.stringify({ mcpServers: decl.mcpServers }),
          "utf8",
        );
      }
      registry[`${name}@test-marketplace`] = [{ scope: "user", installPath: dir }];
    }
    await fs.writeFile(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: registry }, null, 2),
      "utf8",
    );
  }

  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;

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
