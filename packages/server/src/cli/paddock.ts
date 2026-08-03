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
import { fileURLToPath, pathToFileURL } from "node:url";
import { HERE_MARKER, isHereWorkspace, countClaudeSessions, ensureGitignored } from "./here.js";

const MIN_NODE_MAJOR = 22;

/** This module's own directory: `<…>/packages/server/dist/cli`. */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

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

export interface CliOptions {
  port?: string;
  host?: string;
  dataDir?: string;
  here: boolean;
  open: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

/** A usage error. Thrown rather than exiting, so `parseArgs` stays testable. */
export class CliError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    here: false,
    open: false,
    verbose: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "-p":
      case "--port":
        opts.port = next();
        break;
      case "--host":
        opts.host = next();
        break;
      case "-d":
      case "--data-dir":
        opts.dataDir = next();
        break;
      case "--here":
        opts.here = true;
        break;
      case "-o":
      case "--open":
        opts.open = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      default:
        throw new CliError(`unknown option: ${arg}\nRun \`paddock --help\` for usage.`);
    }
  }
  return opts;
}

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

const USAGE = `paddock — run a Paddock instance locally

Usage
  npx @edspencer/paddock [options]

Options
  -p, --port <port>       HTTP/WS port (default 4000, or $PORT)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.paddock, or $PADDOCK_DATA_DIR)
      --here              Open the CURRENT directory as the workspace (see below)
  -o, --open              Open the app in your browser once it is listening
      --verbose           Show the server's own logs (quiet by default)
  -v, --version           Print the Paddock version and exit
  -h, --help              Show this help

Opening a directory (--here)
  Run \`paddock --here\` inside a project and Paddock opens THAT directory as its
  workspace: Claude works in your files, and any Claude Code sessions you already
  have for the directory are offered for import. It:

    · creates .paddock/ in the directory for this workspace's own state
    · creates .chats/ for transcripts, and adds both to .gitignore
    · links ~/.claude/projects/<encoded-dir> at this workspace

  Once done, later runs in the same directory resume it — no flag needed.
  Without --here, Paddock never touches the directory you ran it from.

Credentials
  Paddock drives Claude Code, so it needs Claude credentials in the
  environment: CLAUDE_CODE_OAUTH_TOKEN (Max/Pro) or ANTHROPIC_API_KEY (API
  billing). If you already use Claude Code on this machine, an existing login
  under ~/.claude is picked up automatically. Otherwise run \`claude setup-token\`.

Your data
  Everything lives in one directory — ~/.paddock unless you pass --data-dir.
  Projects, chat transcripts and settings all persist there between runs. Move
  that directory to move your instance; delete it to start over. Nothing is
  stored anywhere else.

Notes
  Binds loopback with authentication disabled, which is safe for a laptop. To
  expose it on a network, set PADDOCK_AUTH_MODE first — Paddock refuses to bind
  a routable interface wide open. See AUTH.md.

Docs: https://github.com/edspencer/paddock`;

/**
 * Why this Node is unusable, or `undefined` if it is fine.
 *
 * Split from the exit so it can be tested. `engines` only warns by default, and
 * the failure it eventually produces is an unexplained syntax error deep inside
 * a dependency — which is nobody's idea of a first-run experience.
 */
export function nodeVersionProblem(nodeVersion: string): string | undefined {
  const major = Number(nodeVersion.split(".")[0]);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return undefined;
  return (
    `Node ${nodeVersion} is too old — Paddock needs Node ${MIN_NODE_MAJOR}+.\n` +
    `Upgrade Node, then re-run. (nodejs.org, or \`nvm install ${MIN_NODE_MAJOR}\`)`
  );
}

/**
 * Put our bundled `claude` on PATH for child processes.
 *
 * Chat turns do NOT need this: they run herdctl's SDK runtime, which resolves
 * the binary from the Claude Agent SDK's own platform package via
 * `require.resolve` and never consults PATH. But the post-turn sweeper and all
 * triggers are one-shot `trigger()` calls on the CLI runtime, which does
 * `execa("claude", …)` — by name, without execa's `preferLocal`, so a local
 * install is invisible to it unless PATH says otherwise.
 *
 * Without this, chats work and every sweep/trigger fails (logged, non-fatal).
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
 * Best-effort credential check — WARNS, never blocks.
 *
 * Claude Code stores credentials differently per platform (a file under
 * ~/.claude on Linux, the Keychain on macOS), so absence of a file does not
 * prove absence of a login. Refusing to start on a false negative would be
 * worse than a chat that fails with the runtime's own error, so this only
 * prints guidance.
 */
function warnIfNoCredentials(claudeHome: string): void {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return;
  const looksLoggedIn =
    fs.existsSync(path.join(claudeHome, ".credentials.json")) ||
    fs.existsSync(path.join(os.homedir(), ".claude.json"));
  if (looksLoggedIn) return;

  console.warn(
    [
      "",
      "  ⚠ No Claude credentials found.",
      "",
      "    Paddock will start, but chats will fail until it has credentials.",
      "    Fix with either:",
      "",
      "      claude setup-token                  # Claude Max/Pro",
      "      export ANTHROPIC_API_KEY=sk-ant-…   # API billing",
      "",
    ].join("\n"),
  );
}

/**
 * Report where the data lives, the first time we create it.
 *
 * `npx` is stateless enough that people reasonably assume the whole thing is
 * ephemeral. It is not — projects, chat transcripts, and settings all persist
 * here across runs, so say so once, at the moment the directory appears.
 */
function noteFirstRun(dataDir: string): void {
  if (fs.existsSync(dataDir)) return;
  console.log(
    [
      "",
      `  Welcome to Paddock. Creating a new instance in ${dataDir}`,
      "  Projects, chats and settings persist there between runs.",
      "",
    ].join("\n"),
  );
}

/**
 * Say what `--here` is about to do to this directory, on the run that does it.
 *
 * The flag IS the consent — there is no prompt, and no `--yes` to remember.
 * But consent only means something if you can know what you agreed to, so the
 * effects are announced rather than asked about. Printed only on the first
 * `--here` in a directory; resuming an already-opened one says nothing.
 */
function announceHereConsent(dir: string, dataDir: string): void {
  console.log(
    [
      "",
      `  Opening ${dir} as a Paddock workspace.`,
      `    · ${path.relative(dir, dataDir) || HERE_MARKER}/ and .chats/ created here, and added to .gitignore`,
      "    · ~/.claude sessions for this directory are linked at the workspace",
      "  Later runs here resume it — no flag needed.",
      "",
    ].join("\n"),
  );
}

/**
 * Tell the user their existing Claude history could be opened here.
 *
 * The only way anyone discovers `--here` exists. Read-only: a bare run counts
 * transcripts and prints, and changes nothing on disk.
 */
function offerHereIfSessionsExist(dir: string): void {
  const claudeHome = process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
  let sessions = 0;
  try {
    sessions = countClaudeSessions(claudeHome, dir);
  } catch {
    return; // detection is a courtesy; never let it break a boot
  }
  if (sessions === 0) return;
  console.log(
    [
      "",
      `  This directory has ${sessions} Claude Code session${sessions === 1 ? "" : "s"}.`,
      "  Run `paddock --here` to open it as a workspace and import them.",
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
 * Translate a listen failure into something a human can act on.
 *
 * `EADDRINUSE` on 4000 is the single most likely first-run failure — it is a
 * popular port and Paddock's own default — and Node's raw error names neither
 * the port nor the flag that fixes it.
 */
export function explainListenError(err: unknown, host: string, port: string): string {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === "EADDRINUSE") {
    return (
      `port ${port} is already in use.\n` +
      `Something else is listening on ${host}:${port} — possibly another Paddock.\n` +
      `Pick a different port:  paddock --port ${Number(port) + 1}`
    );
  }
  if (code === "EACCES") {
    return (
      `not allowed to bind ${host}:${port}.\n` +
      `Ports below 1024 need elevated privileges — use a higher one:  paddock --port 4000`
    );
  }
  return String((err as { message?: string } | undefined)?.message ?? err);
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) fail(err.message);
    throw err;
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.version) {
    console.log(readVersion());
    return;
  }

  const problem = nodeVersionProblem(process.versions.node);
  if (problem !== undefined) fail(problem);

  addBundledBinsToPath();

  // Canonical, because working directories "MUST be canonical so session
  // discovery (which encodes the real path) can find Claude transcripts"
  // (config.ts). On macOS a /tmp vs /private/tmp divergence would silently
  // break adoption — and macOS is most laptops.
  let cwd = process.cwd();
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    /* keep the literal path; the server will surface any real problem */
  }

  // `--here` is the consent. A flagless run in a directory ALREADY opened this
  // way resumes it — the git model, where `--here` is `git init` and `.paddock/`
  // is `.git`. A flagless run anywhere else touches nothing.
  const resuming = !opts.here && isHereWorkspace(cwd);
  const hereMode = opts.here || resuming;

  // Apply CLI defaults as env vars. This is the whole integration surface: the
  // server resolves config inside `buildApp()`, so anything set before the
  // dynamic import below is picked up with no special-casing in config.ts.
  // Precedence is explicit flag > existing env > our default.
  const dataDir = path.resolve(
    opts.dataDir ??
      process.env.PADDOCK_DATA_DIR ??
      (hereMode ? path.join(cwd, HERE_MARKER) : path.join(os.homedir(), ".paddock")),
  );

  if (hereMode) {
    if (!resuming) announceHereConsent(cwd, dataDir);
    // The root workspace IS `projectsRoot` (its key is ""), so pointing this at
    // the user's directory makes that directory the workspace. No schema change,
    // no new project type — see cli/here.ts.
    process.env.PADDOCK_PROJECTS_DIR = cwd;
    fs.mkdirSync(dataDir, { recursive: true });
    ensureGitignored(cwd, `/${HERE_MARKER}/`);
    ensureGitignored(cwd, "/.chats/");
  } else {
    noteFirstRun(dataDir);
    offerHereIfSessionsExist(cwd);
  }

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
  if (!opts.verbose) {
    if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = "warn";
    if (process.env.HERDCTL_LOG_LEVEL === undefined) process.env.HERDCTL_LOG_LEVEL = "warn";
  }

  warnIfNoCredentials(process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude"));

  const port = process.env.PORT ?? "4000";
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
  // ALWAYS name the workspace, not just in --here mode. Behaviour that varies
  // with cwd is only safe if it is observable: "why is this instance different
  // today" should be answerable by reading the two lines the tool just printed.
  console.log(
    [
      "",
      `  Paddock is running at ${url}`,
      `  Workspace: ${hereMode ? cwd : dataDir}${resuming ? "  (resumed)" : ""}`,
      "  Press Ctrl-C to stop.",
      "",
    ].join("\n"),
  );
  if (opts.open) openBrowser(url);
}

// Run only when executed directly, so the unit tests can import the pure parts.
// `pathToFileURL`, not `"file://" + argv[1]`: the naive concatenation breaks on
// any path containing a space or non-ASCII character — the same percent-encoding
// trap as #636.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
