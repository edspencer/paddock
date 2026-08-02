#!/usr/bin/env node
/**
 * `paddock` — the npx / global-install entrypoint (#TBD).
 *
 * PROTOTYPE. This is the user-facing front door for `npx @edspencer/paddock`:
 * someone who has never seen this repo runs one command and gets a working
 * instance on localhost. Everything here is preflight and defaults — the server
 * itself is unchanged, and `start()` is the same lifecycle `node dist/index.js`
 * uses.
 *
 * The design constraint that shapes this file: the server is already
 * *tolerant* — every setting has a default, an empty data dir self-initializes,
 * and auth defaults to `none` on a loopback bind. So a bare `start()` would in
 * fact boot. What it would NOT do is tell a first-time user why their chats
 * fail, or where their data went. Hence:
 *
 *   1. Node version — checked explicitly, because the `engines` field only
 *      warns and the eventual failure is an opaque syntax error.
 *   2. Data dir — defaults to `~/.paddock`, NOT the server's `./data`, which is
 *      relative to cwd and would litter whatever directory you happened to run
 *      npx from (and silently give you a different instance next time).
 *   3. `claude` on PATH — prepended from our own node_modules/.bin. Chats do not
 *      need it (the SDK runtime resolves its own bundled binary), but the
 *      sweeper and triggers shell out to `claude` by name.
 *   4. Credentials — a warning, never a hard failure: we cannot reliably detect
 *      a macOS Keychain login, so refusing to start would lock out valid users.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 22;

/** Resolved once: `<pkg>/dist/cli/paddock.js` -> `<pkg>`. */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface CliOptions {
  port?: string;
  host?: string;
  dataDir?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
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
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      default:
        fail(`unknown option: ${arg}\nRun \`paddock --help\` for usage.`);
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
  -v, --version           Print the Paddock version and exit
  -h, --help              Show this help

Credentials
  Paddock drives Claude Code, so it needs Claude credentials in the
  environment: CLAUDE_CODE_OAUTH_TOKEN (Max/Pro) or ANTHROPIC_API_KEY (API
  billing). If you already use Claude Code on this machine, an existing login
  under ~/.claude is picked up automatically. Otherwise run \`claude setup-token\`.

Notes
  Binds loopback with authentication disabled, which is safe for a laptop. To
  expose it on a network, set PADDOCK_AUTH_MODE first — Paddock refuses to bind
  a routable interface wide open. See AUTH.md.

Docs: https://github.com/edspencer/paddock`;

/** Node's own version gate. `engines` only warns by default, and the failure it
 *  eventually produces is an unexplained syntax error deep in a dependency. */
function checkNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    fail(
      `Node ${process.versions.node} is too old — Paddock needs Node ${MIN_NODE_MAJOR}+.\n` +
        `Upgrade Node, then re-run. (nodejs.org, or \`nvm install ${MIN_NODE_MAJOR}\`)`,
    );
  }
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
  const binDir = path.join(packageRoot, "node_modules", ".bin");
  if (!fs.existsSync(binDir)) return;
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.version) {
    console.log(readVersion());
    return;
  }

  checkNodeVersion();
  addBundledBinsToPath();

  // Apply CLI defaults as env vars. This is the whole integration surface: the
  // server resolves config inside `buildApp()`, so anything set before the
  // dynamic import below is picked up with no special-casing in config.ts.
  // Precedence is explicit flag > existing env > our default.
  const dataDir = path.resolve(
    opts.dataDir ?? process.env.PADDOCK_DATA_DIR ?? path.join(os.homedir(), ".paddock"),
  );
  noteFirstRun(dataDir);
  process.env.PADDOCK_DATA_DIR = dataDir;

  if (opts.port) process.env.PORT = opts.port;
  if (opts.host) process.env.HOST = opts.host;

  warnIfNoCredentials(process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude"));

  const port = process.env.PORT ?? "4000";
  const host = process.env.HOST ?? "127.0.0.1";

  // Imported dynamically, AFTER the env above is set: a static import would
  // pull in app.ts -> config.ts and resolve config against the wrong data dir.
  const { start } = await import("../start.js");
  await start();

  console.log(`\n  Paddock is running at http://${host}:${port}\n  Press Ctrl-C to stop.\n`);
}

main().catch((err: unknown) => {
  console.error("fatal:", err);
  process.exit(1);
});
