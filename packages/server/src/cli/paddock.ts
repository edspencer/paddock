#!/usr/bin/env node
/**
 * `paddock` — the npx / global-install entrypoint (#637, #638).
 *
 * The user-facing front door for `npx @edspencer/paddock`: someone who has never
 * seen this repo runs one command and gets a working instance on localhost.
 * Everything here is preflight, defaults and presentation — the server itself is
 * untouched, and `start()` is the same lifecycle `node dist/index.js` uses.
 *
 * The design constraint that shapes this file: the server is already *tolerant*
 * — every setting has a default, an empty data dir self-initializes, and auth
 * defaults to `none` on a loopback bind. So a bare `start()` would in fact boot.
 * What it would NOT do is tell a first-time user why their chats fail, where
 * their data went, or which of the several hundred lines of JSON that just
 * scrolled past contained the URL.
 *
 * Everything below the arg parser is side-effecting by nature, so the pure parts
 * (`parseArgs`, `nodeVersionProblem`, `explainListenError`) are exported and
 * unit-tested; the rest is exercised by running the built binary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type CliOptions,
  type Command,
  CliError,
  USAGE,
  SERVICE_USAGE,
  CONFIG_USAGE,
  parseCommand,
  nodeVersionProblem,
  explainListenError,
} from "./args.js";
import { runService, safeHomeDir } from "./service/index.js";

/**
 * This module's own file and directory: `<…>/packages/server/dist/cli/`.
 *
 * `import.meta.url` is the module's REALPATH, which is why the service unit
 * names this rather than `process.argv[1]` — npm installs a `bin` as a symlink,
 * and a unit file pointing at `node_modules/.bin/paddock` would depend on that
 * symlink surviving. (The same realpath-vs-argv[1] mismatch is what shipped a
 * silent no-op to npm three times; see args.ts.)
 */
const entryScript = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(entryScript);

/**
 * Walk up from this module looking for `rel`, returning the containing dir.
 *
 * Two layouts have to work and they nest differently:
 *
 *   repo       `<repo>/packages/server/dist/cli/paddock.js`
 *              deps at `<repo>/packages/server/node_modules` AND `<repo>/node_modules`
 *   published  `<pkg>/packages/server/dist/cli/paddock.js`
 *              deps at `<pkg>/node_modules` only — two levels FURTHER up
 *
 * A fixed `../..` hop is right for the repo and wrong for the published tarball,
 * where it lands on `packages/server` and finds no `node_modules` at all.
 */
function findUp(rel: string): string | undefined {
  let dir = moduleDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, rel))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Nearest ancestor holding a `package.json` — `packages/server` in both layouts. */
const packageRoot = findUp("package.json") ?? path.resolve(moduleDir, "../..");

function fail(message: string): never {
  console.error(`paddock: ${message}`);
  process.exit(1);
}

function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Put our bundled `claude` on PATH for child processes.
 *
 * Chat turns do NOT need this on the default `driveMode: session`: they run
 * herdctl's SDK runtime, which resolves the binary from the Claude Agent SDK's
 * own platform package via `require.resolve` and never consults PATH. The
 * post-turn sweeper is the one unconditional user: always a one-shot
 * `trigger()` call on the CLI runtime, which does `execa("claude", …)` — by
 * name, without execa's `preferLocal`, so a local install is invisible to it
 * unless PATH says otherwise. Triggers join it there only on `driveMode:
 * batch`: a trigger resolves its drive mode exactly like a chat does
 * (per-project override else `cfg.driveMode` — `resolveDriveMode` in
 * ws-triggers.ts), so on a stock instance no trigger consults PATH either.
 *
 * Without this, chats work and every sweep fails (logged, non-fatal) — plus
 * every trigger and turn on `driveMode: batch`.
 */
function addBundledBinsToPath(): void {
  const owner = findUp(path.join("node_modules", ".bin"));
  if (owner === undefined) return;
  const binDir = path.join(owner, "node_modules", ".bin");
  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH ?? "";
  if (current.split(sep).includes(binDir)) return;
  process.env.PATH = current ? `${binDir}${sep}${current}` : binDir;
}

/**
 * Report where the data lives, the first time we create it.
 *
 * `npx` is stateless enough that people reasonably assume the whole thing is
 * ephemeral. It is not — projects, chat transcripts, and settings all persist
 * here across runs, so say so once, at the moment the directory appears.
 *
 * The third line replaces `--here`'s discovery hint (#798). That hint scanned
 * the CURRENT directory's Claude Code history and named a flag; both halves are
 * gone. What a new instance actually offers is Discover (#745), which reads the
 * whole history rather than one directory — so the CLI names it and lets the
 * UI, which can show the list with tick-boxes against it, do the work. No
 * filesystem scan happens here: the line is true whatever a scan would find,
 * and an empty instance's Home leads with the same thing.
 */
function noteFirstRun(dataDir: string): void {
  if (fs.existsSync(dataDir)) return;
  console.log(
    [
      "",
      `  Welcome to Paddock. Creating a new instance in ${dataDir}`,
      "  Projects, chats and settings persist there between runs.",
      "  Open the app to find directories you have used Claude Code in.",
      "",
    ].join("\n"),
  );
}

/** Open `url` in the default browser. Best-effort: failing is never fatal. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32", // `start` is a cmd builtin, not a binary
    });
    // A headless box has no xdg-open. The URL is printed either way, so an
    // unopenable browser is a non-event rather than a failed run.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* as above */
  }
}

/**
 * `paddock service …` — register/inspect the background service (#796).
 *
 * Split out so `main` stays the start path. Note what it is handed: the
 * interpreter and script by absolute path, and `packageRoot` — which is tested
 * for npx's cache, because a unit file pointing into a prunable hash-keyed
 * directory rots at some future login with nobody watching.
 */
async function service(command: Extract<Command, { verb: "service" }>): Promise<void> {
  const { action, opts } = command;
  // Unreachable: `parseCommand` only omits the action when `--help` was given,
  // which `main` has already handled. Typed rather than asserted.
  if (action === undefined) {
    console.log(SERVICE_USAGE);
    return;
  }
  try {
    await runService(action, opts, {
      platform: process.platform,
      nodePath: process.execPath,
      scriptPath: entryScript,
      packageRoot,
      homeDir: safeHomeDir(),
      ...(process.env.PADDOCK_DATA_DIR !== undefined
        ? { envDataDir: process.env.PADDOCK_DATA_DIR }
        : {}),
      ...(process.env.XDG_CONFIG_HOME !== undefined
        ? { xdgConfigHome: process.env.XDG_CONFIG_HOME }
        : {}),
      ...(process.env.PATH !== undefined ? { pathEnv: process.env.PATH } : {}),
    });
  } catch (err) {
    if (err instanceof CliError) fail(err.message);
    if (err instanceof Error) fail(err.message);
    throw err;
  }
}

/**
 * Which instance this invocation is about: an explicit flag, else the
 * environment, else `~/.paddock`.
 *
 * Shared by `start` and `config` deliberately. A `config show` that resolved its
 * data dir even slightly differently would report on an instance other than the
 * one `paddock start` runs — and would do it convincingly, since every value it
 * printed would be real. One function, so the two cannot diverge.
 */
function resolveDataDir(opts: CliOptions): string {
  return path.resolve(
    opts.dataDir ?? process.env.PADDOCK_DATA_DIR ?? path.join(os.homedir(), ".paddock"),
  );
}

/**
 * `paddock config …` — print the resolved configuration (#878).
 *
 * Sets `PADDOCK_DATA_DIR` before the dynamic import for the same reason the
 * start path does: `loadPaddockConfig` reads the environment, so the environment
 * has to be finished first. Nothing else `main` does on the way to `start()` —
 * the PATH edit, the first-run notice, the log-level defaults — applies to a
 * command that only reads.
 */
async function config(command: Extract<Command, { verb: "config" }>): Promise<void> {
  const { action, opts } = command;
  // Unreachable: `parseCommand` only omits the action when `--help` was given,
  // which `main` has already handled. Typed rather than asserted.
  if (action === undefined) {
    console.log(CONFIG_USAGE);
    return;
  }
  process.env.PADDOCK_DATA_DIR = resolveDataDir(opts);
  const { runConfig } = await import("./config.js");
  try {
    await runConfig(action, opts);
  } catch (err) {
    // A malformed config file throws out of the loader. That is the RIGHT
    // answer — it is exactly what `paddock start` would fail with — but on its
    // own it reads like the inspection tool is broken rather than the file, so
    // say which one it is.
    if (err instanceof Error) {
      fail(`${err.message}\n\`paddock start\` would fail on the same file.`);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  let command: Command;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) fail(err.message);
    throw err;
  }
  const opts = command.opts;

  if (opts.help) {
    console.log(
      command.verb === "service" ? SERVICE_USAGE : command.verb === "config" ? CONFIG_USAGE : USAGE,
    );
    return;
  }
  if (opts.version) {
    console.log(readVersion());
    return;
  }

  const problem = nodeVersionProblem(process.versions.node);
  if (problem !== undefined) fail(problem);

  if (command.verb === "service") {
    await service(command);
    return;
  }

  if (command.verb === "config") {
    await config(command);
    return;
  }

  addBundledBinsToPath();

  // NOTHING here reads `process.cwd()`, and that is the point (#798). `--here`
  // used to make the current directory the workspace by setting
  // `PADDOCK_PROJECTS_DIR = cwd`, which was the only place that variable was
  // ever set from cwd. It also made the instance you got depend on where you
  // stood — and because its marker directory was `.paddock`, the same name as
  // the default data dir, a bare run from `$HOME` on any machine that had ever
  // run paddock resumed `$HOME` itself as the workspace, silently, even with an
  // explicit `--data-dir`. An instance is now decided by its data dir alone;
  // directories are added inside the app as linked projects (Discover, #745),
  // and the CLI writes nothing into any of them.

  // No Claude-home choice happens here any more (#691). The CLI used to point
  // `CLAUDE_HOME` at `~/.claude` so a macOS Keychain login would be visible
  // (#683); paddock now always owns its home, and what a user actually wanted
  // from that — shared transcripts, shared login — are separate `claude:` config
  // keys. `claude.credentials` restores the Keychain half and defaults to `host`,
  // so a Mac whose only login is a `claude /login` still works out of the box
  // with no flag: see `claude-credentials.ts`.

  // Apply CLI defaults as env vars. This is the whole integration surface: the
  // server resolves config inside `buildApp()`, so anything set before the
  // dynamic import below is picked up with no special-casing in config.ts.
  // Precedence is explicit flag > existing env > our default.
  const dataDir = resolveDataDir(opts);

  noteFirstRun(dataDir);

  process.env.PADDOCK_DATA_DIR = dataDir;

  if (opts.port) process.env.PORT = opts.port;
  if (opts.host) process.env.HOST = opts.host;

  // Quiet by default. The server emits a few hundred lines on the way up, which
  // scrolls the one line the user actually needs — the URL — off the top of the
  // terminal. TWO loggers have to be told, and they are unrelated:
  //   LOG_LEVEL          Paddock's own pino logger (config.ts).
  //   HERDCTL_LOG_LEVEL  @herdctl/core's `createLogger`, which writes the
  //                      `[fleet-manager] …` lines via console.info — pino's
  //                      level cannot reach those.
  // An explicit value for either is left alone, and `--verbose` skips both.
  // A LEVEL is not enough, which is what #684 was about. Background job failures
  // are logged at `error` — level 50, above every threshold either variable can
  // set — and one of them is a bare `console.error` inside the engine. So quiet
  // mode is also stated as a fact the server can act on: `agent-errors.ts` reads
  // this to collapse a recognised, non-fatal failure to its cause instead of
  // printing a stack trace with 2 KB of system prompt in it. Internal to the
  // CLI; `--verbose` leaves it unset and nothing is suppressed.
  if (!opts.verbose) {
    if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = "warn";
    if (process.env.HERDCTL_LOG_LEVEL === undefined) process.env.HERDCTL_LOG_LEVEL = "warn";
    process.env.PADDOCK_QUIET = "1";
  }

  // No credential preflight here: `ensureClaudeHome` (claude-home.ts) already
  // warns at boot, and it is the only check that can be right. It tests the home
  // paddock will ACTUALLY use — after the bridge has symlinked in any
  // `~/.claude/.credentials.json`, and, on darwin, after probing the Keychain for
  // the login `CLAUDE_CONFIG_DIR` scoping hides (#683). It logs at `warn`, which
  // survives the quiet default set just above. Continuity (chosen above) usually
  // means it has nothing to say, because there is nothing left to bridge.

  const port = process.env.PORT ?? "7233";
  const host = process.env.HOST ?? "127.0.0.1";

  // Imported dynamically, AFTER the env above is set: a static import would
  // pull in app.ts -> config.ts and resolve config against the wrong data dir.
  const { start } = await import("../start.js");
  try {
    await start();
  } catch (err) {
    fail(explainListenError(err, host, port));
  }

  const url = `http://${host}:${port}`;
  // Still name the data dir, even though it no longer varies with cwd: "which
  // instance am I looking at" is a real question the moment anyone passes
  // `--data-dir`, and the answer should be readable off the two lines the tool
  // just printed rather than inferred.
  console.log(
    [
      "",
      `  Paddock is running at ${url}`,
      `  Data: ${dataDir}`,
      "  Press Ctrl-C to stop.",
      "",
    ].join("\n"),
  );
  if (opts.open) openBrowser(url);
}

main().catch((err: unknown) => {
  console.error("fatal:", err);
  process.exit(1);
});
