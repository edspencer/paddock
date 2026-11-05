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

import { EXIT } from "./exit-codes.js";

export interface CliOptions {
  port?: string;
  host?: string;
  dataDir?: string;
  open: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  /**
   * `config show`: print every effective value with its provenance, rather than
   * just the decisions someone actually made.
   *
   * The three `config` flags below are OPTIONAL rather than defaulted booleans,
   * unlike the four above. That is not tidiness — `parseArgs([])` is compared
   * structurally in several tests and is the documented shape of "no flags", so
   * adding always-present keys to it would change the meaning of an invocation
   * that has nothing to do with `config`. Absent-when-unset is also what the
   * value flags (`port`, `host`, `dataDir`) already do.
   */
  resolved?: boolean;
  /** `config show`: emit the whole report as JSON instead of a table. */
  json?: boolean;
  /** `config show`: print the values of fields marked sensitive. */
  showSensitive?: boolean;
  /**
   * `config eject`: actually write the file. Without it the command prints the
   * plan and changes nothing.
   *
   * Preview-by-default is the deliberate shape, and it is not timidity about
   * writing a file: ejecting is the one config operation that changes what the
   * file MEANS rather than what it says. Afterwards the instance stops inheriting
   * improved defaults, and the cost is spread across forty keys where no single
   * one looks like a decision. `--write` is the moment the operator agrees to
   * that, having just read the specific list.
   *
   * A flag rather than an interactive confirm because a prompt cannot be answered
   * by the CI job, container build or Ansible task that is the likeliest caller.
   */
  write?: boolean;
  /**
   * `config eject`: also materialise values an environment variable currently
   * supplies. Off by default — see the argument in config.ts.
   */
  includeEnv?: boolean;
  /** `service logs`: keep printing what gets appended (`-f`). */
  follow?: boolean;
  /** `service logs`: how many lines to print first (`-n`, default 50). */
  lines?: number;
  /**
   * `service stop` / `service restart`: go ahead even though the instance is
   * busy (SPEC §1, §4).
   *
   * The refusal it skips is the only thing it skips. It does not change what the
   * busy check printed — a forced stop prints the same sentence, prefixed
   * `Overriding:` — and in wave C2 it will not skip `update`'s health check or
   * its rollback either.
   */
  force?: boolean;
}

/**
 * A failure with an exit code attached (SPEC §2).
 *
 * Thrown rather than exiting, so parsing stays testable. The code travels with
 * the error because the thing that KNOWS which code applies is whatever threw —
 * `main` cannot tell an unsupported platform (a failure, 1) from a misspelled
 * flag (usage, 2) by looking at a string.
 */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT.failure) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * An unknown command, an unknown flag, or a bad value: exit 2 (SPEC §2).
 *
 * **This is a behaviour change, and a deliberate one.** Every one of these used
 * to exit 1, which is also what a genuine failure exits — so a script could not
 * tell "you typed it wrong" from "it tried and could not". The contract splits
 * them, and a script that tested `$? -eq 1` for a typo now needs `-eq 2`.
 */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
  }
}

export const MIN_NODE_MAJOR = 22;

/**
 * What `paddock service` can be asked to do.
 *
 * `start`/`stop`/`restart` join the original three in #873. Note that `start`
 * is also a top-level VERB — `paddock start` runs a server in this terminal,
 * `paddock service start` asks the supervisor to run one. The overlap is safe
 * because `parseCommand` dispatches on `argv[0]` alone and only then reads an
 * action, so the two never compete for the same token.
 */
export const SERVICE_ACTIONS = [
  "install",
  "uninstall",
  "status",
  "start",
  "stop",
  "restart",
  "logs",
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/**
 * What `paddock config` can be asked to do (#878).
 *
 * `show` reads the resolution; `eject` freezes it into the config file. The two
 * are the halves of #878's "thin by default, explicit on demand" — and they are
 * one verb rather than two because the honest way to present `eject` is next to
 * the command that makes it unnecessary.
 */
export const CONFIG_ACTIONS = ["show", "eject"] as const;
export type ConfigAction = (typeof CONFIG_ACTIONS)[number];

/**
 * The leading words {@link parseCommand} recognises. Anything else is a flag.
 *
 * `serve` is the contract's name for running in the foreground (SPEC §1), and
 * `start` is kept as an alias **for good** — the spec says so explicitly for
 * Paddock and Managers, every existing service unit's `ExecStart` names it, and
 * it is in two years of other people's scripts. They parse to the same command.
 */
export const VERBS = ["serve", "start", "service", "config", "busy"] as const;

/**
 * A parsed invocation: which verb, plus the flags that followed it.
 *
 * `action` is optional on `service` and `config` for exactly one reason —
 * `paddock service --help`, where there is no action to name and printing usage
 * is the whole request. It is `undefined` only when `opts.help` is true.
 */
export type Command =
  | { verb: "serve"; opts: CliOptions }
  | { verb: "service"; action: ServiceAction | undefined; opts: CliOptions }
  | { verb: "config"; action: ConfigAction | undefined; opts: CliOptions }
  /** `busy` takes no action — it is one question with one answer (SPEC §1). */
  | { verb: "busy"; opts: CliOptions };

/**
 * Split an action off a verb's argv, then parse what follows as flags.
 *
 * Shared by `service` and `config` so the two cannot drift: a misspelled action
 * is caught HERE rather than reaching the flag loop, which would call it an
 * "unknown option" and send the reader looking for a flag that does not exist.
 */
function parseAction<T extends string>(
  verb: string,
  actions: readonly T[],
  rest: string[],
): { action: T | undefined; opts: CliOptions } {
  const head = rest[0];
  let action: T | undefined;
  if (head !== undefined && !head.startsWith("-")) {
    if (!(actions as readonly string[]).includes(head)) {
      throw new UsageError(
        `unknown ${verb} action: ${head}\n` +
          `Expected one of: ${actions.join(", ")}.\n` +
          `Run \`paddock ${verb} --help\` for usage.`,
      );
    }
    action = head as T;
  }
  const opts = parseArgs(action === undefined ? rest : rest.slice(1));
  // `--help` wins over a missing action: asking for usage is not a usage error.
  if (action === undefined && !opts.help) {
    throw new UsageError(
      `\`paddock ${verb}\` needs an action: ${actions.join(", ")}.\n` +
        `Run \`paddock ${verb} --help\` for usage.`,
    );
  }
  return { action, opts };
}

/**
 * Split a leading verb off the argv, then parse the rest as flags.
 *
 * The dispatch is deliberately a check on `argv[0]` alone rather than a scan for
 * the first non-flag token, and it happens BEFORE the flag loop. Two properties
 * fall out of that, both of which matter more than the flexibility given up:
 *
 * - **Bare `paddock` is untouched.** No verb means the whole argv goes to
 *   {@link parseArgs} exactly as before, so the demo path cannot change
 *   behaviour, and an unrecognised leading token still produces `unknown
 *   option:` from the flag loop rather than a new and different error.
 * - **Flags parse after a verb**, so `paddock start --port 7299` and
 *   `paddock service install --port 7299` both work, and the flag grammar is
 *   the same one in every position.
 *
 * A verb is only a verb in first position: `paddock --port start` is an error
 * from `--port`, not a `start` invocation, and `paddock start start` is still
 * `unknown option`.
 *
 * That first half used to claim a *missing-value* error, which was wrong (#823):
 * `next()` only rejects `undefined`, so `start` was happily consumed as the port
 * and became `NaN` in `config.ts`. It is now a **value** error — `--port needs a
 * number between 1 and 65535` — which is the behaviour the claim was reaching
 * for. Corrected rather than deleted because the grammar it documents is real
 * and load-bearing; it was only the example's error that was misdescribed.
 */
export function parseCommand(argv: string[]): Command {
  const command = dispatch(argv);
  // `--force` overrides the busy check (SPEC §1, §4) and nothing else, so it
  // only means anything on the two commands that run one. Rejecting it
  // everywhere else, rather than parsing and dropping it, is the difference
  // between being told and guessing: the two readings of a quiet
  // `service uninstall --force` are "it overrode something" and "it did
  // nothing", and the exit code is 0 either way.
  //
  // Checked here, once, rather than in each command: a second copy of this rule
  // is a second chance for the two to drift apart about what `--force` means.
  if (
    command.opts.force === true &&
    // `--help` wins, the same way it wins over a missing action above: asking
    // for the usage is not a usage error.
    !command.opts.help &&
    !(command.verb === "service" && (command.action === "stop" || command.action === "restart"))
  ) {
    const what =
      command.verb === "service" && command.action !== undefined
        ? `\`service ${command.action}\``
        : `\`${command.verb}\``;
    throw new UsageError(
      `--force applies to \`service stop\` and \`service restart\` only, not ${what}.\n` +
        "It overrides the busy check, and those are the two commands that run one.",
    );
  }
  return command;
}

function dispatch(argv: string[]): Command {
  const [first, ...rest] = argv;

  if (first === "service") {
    return { verb: "service", ...parseAction("service", SERVICE_ACTIONS, rest) };
  }

  if (first === "config") {
    return { verb: "config", ...parseAction("config", CONFIG_ACTIONS, rest) };
  }

  // `busy` (SPEC §1, §4). A top-level verb rather than a `service` action
  // because its whole point is to be askable where there is no service to ask:
  // a Docker container, a Watchtower pre-update hook, an Ansible task.
  if (first === "busy") return { verb: "busy", opts: parseArgs(rest) };

  // `serve` and `start` are one command: see VERBS.
  if (first === "serve" || first === "start") return { verb: "serve", opts: parseArgs(rest) };

  return { verb: "serve", opts: parseArgs(argv) };
}

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
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "-p":
      case "--port": {
        // Validate here rather than letting `Number("start")` become NaN three
        // files later, in `config.ts`, with nothing between the typo and a
        // server asked to listen on NaN (#823).
        //
        // Scoped to NON-EMPTY values on purpose. `paddock --port "$PORT"` with
        // PORT unset passes `""`, which is falsy at the one place that reads it
        // (`paddock.ts`: `if (opts.port)`) and so correctly falls through to the
        // default — a working invocation that a bare `/^\d+$/` guard would turn
        // into a hard error.
        const v = next();
        if (v !== "" && (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535)) {
          throw new UsageError(`${arg} needs a number between 1 and 65535, got: ${v}`);
        }
        opts.port = v;
        break;
      }
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
      // `config` flags. Accepted in every position for the reason
      // `parseCommand` documents — one flag grammar everywhere — which is also
      // why `service install --open` has always been silently harmless.
      case "--resolved":
        opts.resolved = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--show-sensitive":
        opts.showSensitive = true;
        break;
      case "--write":
        opts.write = true;
        break;
      case "--include-env":
        opts.includeEnv = true;
        break;
      // `service stop` / `service restart`: override the busy check (SPEC §4).
      case "--force":
        opts.force = true;
        break;
      // `service logs` flags, the names `tail`, `journalctl` and every other
      // log reader uses — this is not the place to be original.
      case "-f":
      case "--follow":
        opts.follow = true;
        break;
      case "-n":
      case "--lines": {
        const v = next();
        if (!/^\d+$/.test(v) || Number(v) < 1) {
          throw new UsageError(`${arg} needs a positive number of lines, got: ${v}`);
        }
        opts.lines = Number(v);
        break;
      }
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
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

/**
 * The command list, on its own.
 *
 * Printed after a usage error, because SPEC §2 says the usage follows the
 * message — and because {@link USAGE} is a thousand words of guide that would
 * bury the one line explaining what went wrong. The full text is one
 * `--help` away, and the last line here says so.
 */
export const USAGE_SYNOPSIS = `Usage
  paddock [serve] [options]               run the server in this terminal
  paddock service <action> [options]      install|uninstall|status|start|stop|restart|logs
  paddock busy [--json]                   is the running instance busy?
  paddock config <show|eject> [options]   what this instance's config resolved to
  paddock -v | --version                  print the version and exit
  paddock -h | --help                     the full help`;

export const USAGE = `paddock — run a Paddock instance locally

Usage
  npx @edspencer/paddock [options]        run the server (the default)
  paddock serve [options]                 the same thing, said out loud
                                          (\`paddock start\` is a permanent alias)
  paddock service install [options]       run it in the background from login
  paddock service uninstall               stop it and remove the unit
  paddock service status [--json]         installed? running? which version?
  paddock service start                   start an installed service
  paddock service stop [--force]          stop it, leave it installed
  paddock service restart [--force]       stop it and start it again
  paddock service logs [-f] [-n <lines>]  the service's log
                                          (\`paddock service --help\`)
  paddock busy [--json]                   is it busy? exit 0 no, 75 yes, 3
                                          nothing answering
                                          (\`paddock busy --help\`)
  paddock config show [--resolved]        what this instance's config resolved
                                          to, and where each value came from
  paddock config eject [--write]          freeze that resolution into
                                          paddock.config.yaml
                                          (\`paddock config --help\`)

Options
  -p, --port <port>       HTTP/WS port (default 7233, or $PORT)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.paddock, or $PADDOCK_DATA_DIR)
  -o, --open              Open the app in your browser once it is listening
      --verbose           Show the server's own logs (quiet by default)
  -v, --version           Print the Paddock version and exit
  -h, --help              Show this help

Exit codes
  0   done; running and answering; not busy
  1   failed
  2   usage: an unknown command or flag, or a bad value
  3   not running: installed, but not running or not answering; nothing answers
  4   not installed: there is no service unit
  75  busy: refused, and why was printed. Try later, or use --force

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

Posture profiles
  One key picks how much Paddock shares and how much its agents may do:

    profile: balanced     # paranoid | balanced | yolo   (PADDOCK_PROFILE)

  paranoid shares nothing but the login and turns every capability off — the
  behaviour Paddock had before profiles existed. balanced (the default)
  inherits the CAPABILITIES your CLI already has — instructions, MCP servers,
  plugins — and adds the read-only self-management tools, while keeping your
  chat history Paddock's own. yolo turns the rest on: your transcripts, host
  hooks, the write and project tools, schedule mutation, deeper spawning, the
  browser.

  A profile only sets defaults — any single key still overrides it, and an
  individual key in the config file beats PADDOCK_PROFILE in the environment.
  Profiles never touch your port, bind address, auth or model list: yolo does
  NOT open the bind or relax auth, which stay a separate, explicit decision.

  What host actually reaches depends on the machine — a workstation has a real
  ~/.claude, a container usually has none. The profile sets the levers, the
  environment sets the blast radius.

  To see what your profile actually expanded to on THIS machine, with the layer
  each value came from:  paddock config show --resolved

Sharing your Claude Code state
  Apart from that login, Paddock writes nothing outside its data dir by
  default: transcripts go to each project's .chats/, and your ~/.claude is read
  for config only. Each thing it can share is one key in
  <data-dir>/paddock.config.yaml, and each defaults to whatever your profile
  says (see Posture profiles below):

    claude:
      transcripts: host   # own | host   host on yolo only
      credentials: host   # own | host   host on every profile
      instructions: host  # own | host   own on paranoid, else host
      hooks: host         # own | host   host on yolo only
      mcpServers: host    # own | host   own on paranoid, else host

  transcripts: host makes a chat and a \`claude --resume\` in the same directory
  the same file, live in both directions; deleting such a chat in Paddock
  releases it rather than removing it, because it is your history rather than
  Paddock's copy. credentials: own is the opt-out from sharing the login above.

  instructions: host loads your ~/.claude CLAUDE.md, agents/, commands/ and
  plugins/. On from balanced up, so your curated CLAUDE.md does reach Paddock's
  agents; profile: paranoid or instructions: own keeps it out. Each project's
  own CLAUDE.md applies either way.

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

export const SERVICE_USAGE = `paddock service — keep Paddock running in the background

Usage
  paddock service install [options]   register it and start it now
  paddock service uninstall           stop it and deregister it
  paddock service status [--json]     is it registered, is it running, which
                                      version, where are the logs
  paddock service start               start an installed service that is stopped
  paddock service stop [--force]      stop it, and leave it installed
  paddock service restart [--force]   stop it and start it again, re-reading config
  paddock service logs [-f] [-n <n>]  the service's log (the last 50 lines)

Options (logs)
  -f, --follow            keep printing what gets appended, until Ctrl-C
  -n, --lines <n>         how many lines to print first (default 50)

Options (stop, restart)
      --force             stop it even though it is busy

Busy
  \`stop\` and \`restart\` ask the running instance whether it is busy first, and
  refuse with exit 75 if it is — a chat turn in flight, a background task, a
  scheduled job. \`paddock busy\` asks the same question on its own.

  Being refused is the useful case: a restart kills a chat turn mid-sentence,
  and the turn cannot be resumed from where it was. Wait, or --force.

  \`uninstall\` does not ask. Removing the service is an explicit act, and
  someone uninstalling it has already decided.

Options (install only — recorded in the generated unit)
  -p, --port <port>       HTTP/WS port (default 7233)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Only if you want an instance SEPARATE from your
                          terminal one. Left out of the unit when you omit it
                          AND \`PADDOCK_DATA_DIR\` is unset in this shell, so
                          \`paddock service\` and a bare \`paddock\` are the same
                          ~/.paddock instance reached two ways. If
                          \`PADDOCK_DATA_DIR\` IS set here, that path is recorded
                          in the unit — the service would otherwise point
                          somewhere your terminal does not.
      --verbose           Record the server's own logs, not just warnings

At login, not at boot
  This registers a per-USER service — a launchd LaunchAgent on macOS, a
  \`systemd --user\` unit on Linux — so it runs as you, with your own Claude
  login. That is not incidental: on macOS your Claude login is a Keychain item
  that only a logged-in user session can read. A boot-time system daemon has no
  such session and could not use it.

  So Paddock starts when you LOG IN, not when the machine boots. After a
  restart that nobody logs into, Paddock is not running. That is the design, not
  a fault.

  On Linux, a user service is also stopped when you log out. To keep it up:

    loginctl enable-linger $USER

Where it lives
  macOS   ~/Library/LaunchAgents/net.edspencer.paddock.plist
  Linux   ~/.config/systemd/user/paddock.service

  Both write stdout and stderr to ONE file, <data-dir>/logs/service.log, which
  is what \`paddock service logs\` reads. Not the journal on Linux: a volatile
  journal has nothing in it after the reboot you are asking about, and one file
  means one answer to "where are the logs" on every OS. Paddock rotates it
  itself at 8 MB, keeping three older generations beside it.

Exit codes
  0   it is installed, running and answering
  3   installed, but not running or not answering
  4   not installed: there is no unit  (status, logs, start, stop, restart)
  1   something failed
  2   usage: an unknown action or flag, or a bad value
  75  busy, and --force was not given  (stop, restart)

Installed from npx?
  \`service install\` refuses. An npx cache path is hash-keyed and npm may prune
  it, so the unit would work until it silently didn't, at some future login.
  Install properly first:

    npm i -g @edspencer/paddock && paddock service install

A note on access
  Paddock binds loopback with authentication off, which is right for a laptop.
  A service is up for as long as you are logged in rather than as long as a
  terminal tab, so that window is longer — but it is not wider: any local
  process that could reach the port could already read the same Claude login as
  you. Set PADDOCK_AUTH_MODE if you want a credential on it anyway.

Docs: https://github.com/edspencer/paddock`;

export const BUSY_USAGE = `paddock busy — is the running instance in the middle of something?

Usage
  paddock busy                        ask, and say so in a sentence
  paddock busy --json                 the same answer as one JSON document
  paddock busy -d <path>              ask a particular instance

Exit codes — this command is FOR its exit code
  0   not busy. Nothing a restart would cut short.
  75  busy. What is running was printed.
  3   nothing answered. No instance is running, so there is nothing to wait for.
  1   something answered, but not as Paddock's busy check.

Options
  -d, --data-dir <path>   Which instance to ask (default ~/.paddock, or
                          \$PADDOCK_DATA_DIR) — the same rule \`paddock serve\`
                          uses, so the two always mean the same instance
      --json              One JSON document on stdout: running, busy, url,
                          version, counts. Prose goes to stderr
  -h, --help              Show this help

What counts as busy
  Only work a restart would LOSE or cut short:

    chat         a chat turn running — a human turn, a fired trigger, a cron
                 fire. A turn is a live claude subprocess writing a transcript,
                 and it cannot be resumed from where it was interrupted.
    background   a background task a live session is still holding after its
                 turn ended: a background shell, a sub-agent, a Monitor.
    job          a scheduled job herdctl is running.

  Not busy: an idle session (it resumes), an open browser tab (it reconnects),
  a pending curation sweep (it re-runs from its watermark).

Where to run it from
  From a terminal. A Paddock chat that runs this is itself one of the chat turns
  it counts, so it will always see itself as busy — and \`service stop --force\`
  from inside a chat stops the service that is running the chat, which does not
  come back with an explanation. That is why the refusal says so.

For scripts, containers and Watchtower
  \`busy\` is there for callers with no service to ask. 75 is EX_TEMPFAIL, which
  is the code Watchtower's pre-update hook reads as "skip this one":

    labels:
      com.centurylinklabs.watchtower.lifecycle.pre-update: paddock busy

  An Ansible task does the same thing with a retry. Nothing here contacts the
  network or the npm registry, and the question is answered from memory — it is
  cheap enough to ask in a loop.

How it finds the instance
  \`<data-dir>/runtime.json\`, written 0600 when the server starts listening and
  removed when it stops. There is no fallback to a default port: guessing one
  would ask whatever else happened to be listening there, and get an answer.

  A Paddock from before this feature shipped writes no such file, so it reads as
  not running (exit 3). Upgrade it and restart it once.

Docs: https://github.com/edspencer/paddock`;

export const CONFIG_USAGE = `paddock config — what this instance's configuration actually resolved to

Usage
  paddock config show                 the decisions: your profile, the keys your
                                      config file sets, the variables your
                                      environment sets
  paddock config show --resolved      EVERY effective value, and which layer it
                                      came from
  paddock config show --json          the same report as JSON, long values in
                                      full (sensitive ones still hidden)
  paddock config eject                what freezing that resolution into
                                      paddock.config.yaml would write — a
                                      preview; writes nothing
  paddock config eject --write        actually write it

Options
  -d, --data-dir <path>   Which instance to inspect (default ~/.paddock, or
                          $PADDOCK_DATA_DIR) — the same rule \`paddock start\`
                          uses, so the two always read the same instance
      --resolved          show: every field, not just the ones someone set
      --json              show: the whole report as JSON (implies --resolved's
                          scope)
      --show-sensitive    show: print the values of fields marked sensitive
      --write             eject: apply the plan. Without it, eject only prints
      --include-env       eject: also freeze values an environment variable
                          currently supplies (see below — off by default)
  -h, --help              Show this help

Where a value can come from
  Config resolves in four layers, and each row of --resolved names the one that
  won:

    default            Paddock's built-in default.
    profile (<name>)   Your posture profile. The twelve levers a profile governs
                       have no code default of their own any more — the profile
                       IS their default — so this is a distinct answer from
                       "default", and switching profile would change it.
    file               A key in paddock.config.yaml.
    env <NAME>         An environment variable, which beats the file for the
                       same key.

  One wrinkle worth knowing, and the command shows it plainly: an individual key
  in the FILE beats PADDOCK_PROFILE in the environment. Specific beats general —
  PADDOCK_PROFILE speaks for the levers you did not mention.

Why show, and not just write it all into the file
  \`show\` is computed by the loader the server boots with, so it cannot drift
  from what the process would actually do. A materialized file can: it stops
  inheriting improved defaults, says nothing about the variables your container
  sets on top, and no longer describes the whole surface the day a lever is
  added. That is why the thin file is the default and \`show\` is the answer to
  "what am I actually running?".

  \`eject\` is there for when you want it written down anyway — frozen, in the
  file, reviewable in git. It is a real tradeoff rather than a better \`show\`,
  so it prints what it would cost you and writes nothing until you pass --write.

What eject writes, and what it leaves alone
  It writes the posture levers your profile expanded to, plus the behavioural
  settings the Config screen already round-trips through this file. It does NOT
  write:

    the bindings     port, host, data dir, projects root, state dir, web dist.
                     These resolve to absolute paths on THIS machine, and the
                     data dir resolves to the directory holding the file — so
                     ejecting them makes the file unportable and unmountable.
    sensitive keys   transcription.endpoint can carry credentials in its URL.
                     Bulk-writing a secret-shaped value to disk should not be
                     one keystroke away; write that key by hand.
    env-owned keys   by default. An environment variable BEATS the file, so
                     writing its value in changes nothing today and everything
                     the day the variable goes away — a deferred, silent change
                     of provenance. eject names each one it skipped instead.
                     --include-env writes them, which is the right flag if you
                     are deliberately migrating from env vars to a file.

  It always writes \`profile:\` as well, even though every key that profile
  governs is now explicit. That line is what a lever added in a FUTURE release
  falls back to: without it, a new capability toggle would resolve against the
  built-in default profile rather than the posture you actually ejected from.

  Your comments and any keys Paddock does not manage survive — the file is
  round-tripped, not regenerated — and the write is atomic.

Reading nothing, writing nothing
  \`show\` resolves config and prints it. It starts no server, contacts nothing,
  and writes no file — including the data dir itself, which it will report as
  missing rather than create. \`eject\` writes exactly one file, and only with
  --write.

  Values are printed to a terminal that often ends up pasted into an issue, so
  fields marked sensitive are shown as (hidden). None of them is a secret —
  Paddock keeps secrets out of this surface entirely, so there is no API key or
  JWT signing material here to hide or reveal.

Docs: https://github.com/edspencer/paddock`;
