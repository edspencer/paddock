/**
 * Making a failed agent run readable (#684).
 *
 * A credential-less `npx @edspencer/paddock --here` — the path the README, the
 * docs site and the front page all point new users at — greeted them with a
 * multi-screen stack trace containing the entire sweeper system prompt, four
 * times over: once in the `ExecaError`, once in the `[fleet-manager]` line, once
 * in the serialised `err.message` and once inside `err.stack`. The one useful
 * string, `Not logged in · Please run /login`, was on line 40 of the dump. The
 * server was fine and still serving; nothing about the output said so.
 *
 * Three separate things produce that wall, and only one of them is ours:
 *
 *  1. `sweep.ts` logging `{ err }` at pino level 50 — ours, fixed there.
 *  2. `[CLIRuntime] Process failed: …` — `@herdctl/core`.
 *  3. `[fleet-manager] Job … error: …` — `@herdctl/core`.
 *
 * We cannot edit core from here, but we do not have to: `setLogHandler` is an
 * exported hook that replaces the `console.*` output of EVERY `createLogger` in
 * the engine. {@link installHerdctlLogBridge} uses it to shape both of core's
 * lines on the way past. That is a better fix than patching core anyway — it
 * keeps the decision about how much noise a paddock instance emits inside
 * paddock, where the CLI's quiet mode lives.
 */
import { setLogHandler, getLogLevel, LOG_LEVEL_ORDER } from "@herdctl/core";

/**
 * Failures that are USER STATE, not exceptions — a known cause with a known
 * remedy, where a stack trace tells the reader nothing they can act on.
 *
 * Matched against the whole error text because the signal arrives in the failed
 * command's own output, not in the message execa constructs.
 */
const KNOWN_CAUSES: ReadonlyArray<{ pattern: RegExp; cause: string }> = [
  {
    pattern: /Not logged in|Please run \/login|Invalid API key|OAuth token has expired/i,
    cause:
      "Claude Code is not logged in — run `claude setup-token`, " +
      "or set CLAUDE_CODE_OAUTH_TOKEN",
  },
  {
    pattern: /Credit balance is too low|insufficient[_ ]quota/i,
    cause: "the Claude account is out of credit",
  },
  {
    // Anchored to `claude` specifically. A bare /ENOENT/ would claim a missing
    // CLI for any file the engine failed to open, which is a confident wrong
    // answer — worse than the raw error it replaces.
    pattern: /ENOENT[^\n]{0,40}claude|claude: (command )?not found/i,
    cause: "the `claude` CLI is not on PATH (needed by the sweeper and triggers)",
  },
];

/**
 * The one-line, actionable reason this failed, if it is one we recognise.
 *
 * `undefined` means "no idea" — and an unknown failure keeps its full detail,
 * because that is exactly the case where somebody needs it.
 */
export function classifyAgentError(err: unknown): string | undefined {
  const text = agentErrorText(err);
  return KNOWN_CAUSES.find((k) => k.pattern.test(text))?.cause;
}

/** Everything an error carries as text — message, and stdio execa attached. */
function agentErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  const e = err as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  } | null;
  return [e?.message, e?.stdout, e?.stderr].filter((v) => typeof v === "string").join("\n");
}

/**
 * The same error with the reconstructed `claude` argv cut out.
 *
 * execa's message quotes the entire command it ran, which for the sweeper is
 * ~2 KB of system prompt followed by the full `--disallowedTools` list. It is
 * noise to an end user and it buries the signal; it also means the curator
 * prompt is copied into any log or paste of the failure. Everything before the
 * argv (`Command failed with exit code 1`) is kept, because the exit status is
 * the part that is actually diagnostic.
 *
 * Full text is still one env var away — see {@link installHerdctlLogBridge}.
 */
export function summariseAgentError(message: string): string {
  return message.replace(
    // Up to and including "claude", then a flag, then everything after it.
    /(:\s*)claude(\.exe)?\s+-{1,2}[\s\S]*/,
    "$1claude … (argv omitted — set HERDCTL_LOG_LEVEL=debug for the full command)"
  );
}

/**
 * Route `@herdctl/core`'s logging through a handler that shapes agent failures.
 *
 * Two behaviours, and they are separate on purpose:
 *
 *  - **Always** summarise the argv. The system prompt in a `claude -p` command
 *    line is never what somebody is reading the log for, on a laptop or a
 *    server. `HERDCTL_LOG_LEVEL=debug` turns it back on — at debug you have
 *    asked for everything, and the argv is genuinely useful there.
 *  - **In quiet mode** (the CLI's default), collapse a recognised failure to its
 *    cause. `LOG_LEVEL=warn` was never enough for this: core logs these at
 *    `error`, which passes every level filter there is, and one of them is a
 *    bare `console.error`. Quiet-by-default meant "quiet when nothing goes
 *    wrong", which is the easy half.
 *
 * Idempotent; installing again replaces the handler. Call `setLogHandler(null)`
 * to restore core's own output.
 */
export function installHerdctlLogBridge(options: { quiet: boolean }): void {
  const debug = LOG_LEVEL_ORDER[getLogLevel()] <= LOG_LEVEL_ORDER.debug;
  setLogHandler((level, prefix, message, data) => {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[getLogLevel()]) return;

    let text = debug ? message : summariseAgentError(message);
    if (options.quiet && level === "error") {
      const cause = classifyAgentError(message);
      // A known cause replaces the message rather than annotating it: the
      // reader does not need the exit code as well as the reason, and the
      // failure is non-fatal — the server is still up and still serving.
      if (cause !== undefined) text = `${cause} — run with --verbose for the full error`;
    }
    const line =
      data === undefined ? `[${prefix}] ${text}` : `[${prefix}] ${text} ${JSON.stringify(data)}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else if (level === "info") console.info(line);
    else console.debug(line);
  });
}
