/**
 * Pure argument parsing and message formatting for the `paddock` CLI.
 *
 * ## Why this is its own module
 *
 * These functions want unit tests, and the entrypoint they used to live in
 * cannot be imported without running. The first attempt kept them in
 * `paddock.ts` behind a run-directly guard:
 *
 * ```ts
 * if (pathToFileURL(process.argv[1]).href === import.meta.url) main();
 * ```
 *
 * **That guard shipped a silent no-op to npm.** npm installs a `bin` as a
 * SYMLINK at `node_modules/.bin/paddock`, so `process.argv[1]` is the symlink
 * path while `import.meta.url` is the module's realpath. They never match, the
 * condition is always false, and `npx @edspencer/paddock` printed nothing and
 * exited 0 — in 0.57.0, 0.58.0 and 0.59.0. It went unnoticed because the manual
 * checks invoked `node <file>` directly, which is the one path where the guard
 * does hold.
 *
 * `realpathSync(argv[1])` would fix that instance. Splitting the module removes
 * the need for the guard entirely, so there is no condition left to get wrong on
 * the next shim, platform or package manager. `paddock.ts` now always runs.
 */

export interface CliOptions {
  port?: string;
  host?: string;
  dataDir?: string;
  open: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

/** A usage error. Thrown rather than exiting, so parsing stays testable. */
export class CliError extends Error {}

export const MIN_NODE_MAJOR = 22;

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
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

/**
 * Why this Node is unusable, or `undefined` if it is fine.
 *
 * `engines` only warns by default, and the failure it eventually produces is an
 * unexplained syntax error deep inside a dependency.
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
 * Translate a listen failure into something a human can act on.
 *
 * `EADDRINUSE` is the likeliest first-run failure — usually a second Paddock, or
 * a Temporal frontend, which defaults to the same 7233 — and Node's raw error
 * names neither the port nor the flag that fixes it.
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
      `Ports below 1024 need elevated privileges — use a higher one:  paddock --port 7233`
    );
  }
  return String((err as { message?: string } | undefined)?.message ?? err);
}

export const USAGE = `paddock — run a Paddock instance locally

Usage
  npx @edspencer/paddock [options]

Options
  -p, --port <port>       HTTP/WS port (default 7233, or $PORT)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.paddock, or $PADDOCK_DATA_DIR)
  -o, --open              Open the app in your browser once it is listening
      --verbose           Show the server's own logs (quiet by default)
  -v, --version           Print the Paddock version and exit
  -h, --help              Show this help

Opening your own directories
  Where you run this from does not matter — the instance is decided by its data
  dir alone. Directories are added inside the app, on the Discover screen: it
  reads your Claude Code history, lists the directories you have worked in, and
  links the ones you tick as projects. A new instance opens on it.

  Importing a directory does not write into it. No .paddock/, no .chats/, no
  .gitignore edits, no CLAUDE.md — the project record and the copied transcripts
  both live in the data dir, and the project just points at the path. Your own
  ~/.claude transcripts are copied, never moved or deleted, so your terminal
  \`claude\` keeps working exactly as before.

Credentials
  Paddock drives Claude Code, so it needs Claude credentials — and if you
  already use Claude Code on this machine, it uses the login you already have.
  That is a macOS Keychain entry on a Mac, or your ~/.claude/.credentials.json
  elsewhere (symlinked in, never copied). Reading a login writes nothing.

  Otherwise: a CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment,
  or a one-off \`CLAUDE_CONFIG_DIR=<data-dir>/claude-home claude login\`. With no
  login at all anywhere, run \`claude setup-token\`. Paddock says at startup when
  it can find none.

Sharing your Claude Code state
  Apart from that login, Paddock writes nothing outside its data dir by
  default: transcripts go to each project's .chats/, and your ~/.claude is read
  for config only. Each thing it can share is one key in
  <data-dir>/paddock.config.yaml:

    claude:
      transcripts: host   # own | host, default own
      credentials: host   # own | host, default host
      instructions: host  # own | host, default own
      hooks: host         # own | host, default own
      mcpServers: host    # own | host, default own

  transcripts: host makes a chat and a \`claude --resume\` in the same directory
  the same file, live in both directions; deleting such a chat in Paddock
  releases it rather than removing it, because it is your history rather than
  Paddock's copy. credentials: own is the opt-out from sharing the login above.

  instructions: host loads your ~/.claude CLAUDE.md, agents/, commands/ and
  plugins/. Off by default, which is a change: your curated CLAUDE.md does not
  reach Paddock's agents unless you say so. Each project's own CLAUDE.md always
  does.

  hooks: host runs the shell commands your ~/.claude/settings.json binds to
  tool use. Off by default — inheriting someone's hooks is not something to
  discover after the fact. Its other keys (permissions, model, statusline)
  apply either way: under hooks: own Paddock writes its own settings.json
  carrying them with hooks dropped, regenerated at startup.

  mcpServers: host attaches the MCP servers declared in your ~/.claude.json —
  the top-level ones, plus a project's own when its directory matches. To give
  this instance a server your machine doesn't have, declare it instead in a
  sibling mcpServers: block of the same file; use env:VAR_NAME anywhere a
  string goes so tokens stay out of it. That keeps a token out of the file, not
  out of \`ps\`: leave driveMode on its default (session) for a server holding
  one, since batch passes the definition to claude as a command-line argument.

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
