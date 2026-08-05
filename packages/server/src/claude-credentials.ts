/**
 * The `claude.credentials` lever (#691): whose Claude Code LOGIN this instance
 * uses.
 *
 * Paddock always owns its Claude home (`<dataDir>/claude-home`, #691), and that
 * is what made a macOS login invisible (#683). Claude Code files its secure
 * storage entry under a service name derived from the config dir, so the moment
 * paddock points `CLAUDE_CONFIG_DIR` at its own home, `claude /login`'s Keychain
 * entry is under a name paddock's agents never look up. On a Mac with no token in
 * the environment that is an instance which boots cleanly and fails every single
 * turn with "Not logged in".
 *
 * ## The mechanism
 *
 * Read out of the SDK bundle (`@anthropic-ai/claude-agent-sdk/sdk.mjs`), which
 * derives the service name like this:
 *
 * ```js
 * var _z = "-credentials";
 * function yz(e = "") {
 *   let t = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
 *       r = t !== undefined ? !t : !process.env.CLAUDE_CONFIG_DIR,
 *       n = t !== undefined ? t.normalize("NFC") : Yt(),
 *       o = r ? "" : `-${sha256(n).digest("hex").substring(0, 8)}`;
 *   return `Claude Code${OAUTH_FILE_SUFFIX}${e}${o}`;
 * }
 * ```
 *
 * `OAUTH_FILE_SUFFIX` is `""` in production and the only caller passes `_z`, so a
 * plain `claude /login` files under exactly **`Claude Code-credentials`** — which
 * is the name `probeMacosKeychainLogin` looks for, now confirmed rather than
 * guessed.
 *
 * The load-bearing line is `r`. **`CLAUDE_SECURESTORAGE_CONFIG_DIR`, when
 * DEFINED, overrides `CLAUDE_CONFIG_DIR` for secure storage only.** Define it as
 * the EMPTY STRING and `!t` is true, so the hash suffix is dropped and the
 * plain-name entry — the user's real login — is the one read, while
 * `CLAUDE_CONFIG_DIR` still points at paddock's own home. That decoupling is the
 * whole lever: one variable, no home moved, nothing else shared.
 *
 * The empty string is a value, not a mistake. Anywhere it looks like a bug to
 * "clean up", it is the signal.
 *
 * ## Why this defaults to `host`, against the pattern
 *
 * Every other key in the `claude:` block defaults to `own`, and this one does
 * not. **Isolation is about writes.** Reading a Keychain entry (or a symlinked
 * `~/.claude/.credentials.json`) puts no file of the user's at risk: nothing is
 * created, moved or deleted, and the user's own `claude` is unaffected. What
 * defaulting to `own` WOULD do is recreate #683 — a first run that boots fine,
 * says everything is ready, and fails every turn — which is the worst first
 * impression paddock can make and the one it just made.
 *
 * So the guarantee `own` everywhere buys ("nothing outside the data dir is
 * written") survives this default intact, and the deliberate exception is stated
 * here rather than left to be inferred from a table.
 */

/**
 * Whose Claude Code login this instance uses — the `claude.credentials` key.
 *
 * `own` = only what is inside paddock's own Claude home: a token in the
 * environment, or a `.credentials.json` an operator put there / logged in with.
 * `host` = this machine's Claude Code login as well — the macOS Keychain entry on
 * darwin, and the user's `~/.claude/.credentials.json` (bridged by symlink) on
 * everything else.
 */
export type CredentialsMode = "own" | "host";

/** Sharing a login writes nothing. See the module doc for why this is not `own`. */
export const DEFAULT_CREDENTIALS_MODE: CredentialsMode = "host";

/** Type guard, so an unknown config value falls back instead of failing a boot. */
export function isKnownCredentialsMode(value: string): value is CredentialsMode {
  return value === "own" || value === "host";
}

/**
 * The variable Claude Code resolves its SECURE-STORAGE scope from, independently
 * of `CLAUDE_CONFIG_DIR`. Not exported by the SDK; read from its bundle.
 */
export const SECURE_STORAGE_DIR_VAR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/**
 * The value that means "use the unsuffixed service name" — i.e. the entry a
 * plain `claude /login` wrote. Empty on purpose; see the module doc.
 */
export const HOST_SECURE_STORAGE_DIR = "";

/** What {@link applyCredentialsMode} did, for the boot notice. */
export type CredentialsDecision =
  /** `host`: the variable was set to `""`, so the plain-name login is used. */
  | { action: "shared" }
  /** `own`: the variable is unset, so the login is scoped to paddock's home. */
  | { action: "isolated" }
  /** An operator set the variable to something of their own; left alone. */
  | { action: "deferred"; value: string };

/**
 * Put this instance's credentials mode into the environment Claude Code runs in.
 *
 * **Mutates `env`, and by default that is `process.env` — deliberately.** There
 * is no per-invocation seam to use instead: herdctl builds the SDK's `options.env`
 * itself (`withClaudeConfigDir`, which spreads `process.env`) and the CLI runtime
 * lets execa merge over the inherited environment, and neither takes an env
 * contribution from paddock. Unlike the Claude home — which herdctl warns must be
 * per-invocation because one process hosts many agents with potentially different
 * homes — the credentials mode is a property of the INSTANCE: every agent in it
 * has the same answer, so a process-wide value cannot leak one agent's setting
 * into another's. Called once, at boot, before the fleet starts.
 *
 * An operator who set the variable to a non-empty value themselves is honoured
 * rather than clobbered, the same courtesy `CLAUDE_CONFIG_DIR` gets (herdctl#423):
 * they have named a third secure-storage scope that neither mode can express. An
 * EMPTY value is not treated that way — it is exactly what `host` writes, so it is
 * ours by construction and `own` clears it.
 */
export function applyCredentialsMode(
  mode: CredentialsMode,
  env: NodeJS.ProcessEnv = process.env,
): CredentialsDecision {
  const operator = env[SECURE_STORAGE_DIR_VAR];
  if (operator !== undefined && operator !== "") return { action: "deferred", value: operator };
  if (mode === "host") {
    env[SECURE_STORAGE_DIR_VAR] = HOST_SECURE_STORAGE_DIR;
    return { action: "shared" };
  }
  delete env[SECURE_STORAGE_DIR_VAR];
  return { action: "isolated" };
}
