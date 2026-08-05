/**
 * The `claude.instructions` lever (#691): whose CLAUDE.md, subagents and slash
 * commands this instance runs with.
 *
 * Paddock always owns its Claude home (`<dataDir>/claude-home`, #691), and
 * relocating a home means the user-level config that lives in `~/.claude` is no
 * longer on Claude Code's path. Since #620 paddock has symlinked it back in
 * unconditionally. This key makes that a choice.
 *
 * ## What is in scope
 *
 * {@link INSTRUCTION_ENTRIES} — `CLAUDE.md`, `agents/`, `commands/`, `plugins/`.
 * Content the model reads, or definitions it can invoke by name: prompts,
 * subagent descriptions, slash commands. Nothing here runs a command on this
 * machine of its own accord, which is what separates it from `claude.hooks`.
 *
 * Bridged by SYMLINK, as before — user-level config is the user's to maintain,
 * and a copy would go stale the moment they edited it.
 *
 * ## The case against `own` as the default, which is real
 *
 * This default reverses the argument #620 shipped with, and that argument is
 * worth keeping rather than deleting. Verbatim, from the docstring that used to
 * sit on `BRIDGED_ENTRIES`:
 *
 * > Without this, relocating the home silently changes agent behaviour: the
 * > user's `~/.claude/CLAUDE.md` is auto-loaded into every session,
 * > `settings.json` carries permissions and hooks, and `agents/` `commands/`
 * > `plugins/` are capability. Dropping them is not "a clean home", it is a
 * > behaviour regression nobody asked for.
 *
 * All of that is still true, and `instructions: own` is exactly that regression
 * for anyone who has curated a `~/.claude/CLAUDE.md`: their agents stop knowing
 * things they knew yesterday, and the change is invisible — no error, just
 * different behaviour. Someone who hits it has no reason to suspect a config key
 * they never set.
 *
 * It is nonetheless the default (#691), because the counter-argument is about
 * what a user can *state* rather than what is convenient. "`own` everywhere means
 * nothing outside the data dir is read or written" is a guarantee an operator can
 * read off a config file; "…except your CLAUDE.md, agents, commands and plugins,
 * always, with no key to turn them off" is not a guarantee, it is a footnote. A
 * regression that is one documented key away from being undone is recoverable;
 * an inherited capability with no lever at all is the thing #691 exists to end.
 *
 * The cost is real and lands on exactly the users who invested most in their own
 * Claude Code setup, so the boot notice names the key rather than leaving them to
 * find it — see `ensureClaudeHome`.
 *
 * ## Not in scope, deliberately
 *
 * - **`settings.json`** — a mixed bag whose executable half is `claude.hooks`
 *   and whose remaining keys (permissions, model, statusline) are inherited
 *   either way. See `claude-settings.ts`.
 * - **`enabledPlugins`**, which lives inside `settings.json` and is therefore
 *   still inherited under `instructions: own`, orphaned from the `plugins/` dir
 *   it names. Harmless as long as bridging `plugins/` is inert (below); if step 5
 *   of #691 makes plugins load, this key has to move under this lever with them.
 * - **`.credentials.json`** — `claude.credentials`, step 3.
 * - **`projects/`, `todos/`, `shell-snapshots/`, `statsig/`, `sessions/`** — never
 *   bridged in either mode. Per-instance runtime state, which is exactly what
 *   should be per-instance.
 */

/**
 * Whose user-level instructions this instance uses — the `claude.instructions`
 * key.
 *
 * `own` (default) = only what is inside paddock's own Claude home, plus whatever
 * each project's own directory provides. `host` = the user's `~/.claude`
 * CLAUDE.md, agents, commands and plugins as well, symlinked in.
 */
export type InstructionsMode = "own" | "host";

/** Isolation is the default. See the module doc for the case against it. */
export const DEFAULT_INSTRUCTIONS_MODE: InstructionsMode = "own";

/** Type guard, so an unknown config value falls back instead of failing a boot. */
export function isKnownInstructionsMode(value: string): value is InstructionsMode {
  return value === "own" || value === "host";
}

/**
 * The entries of the user's Claude home this lever governs.
 *
 * `plugins` is here on the strength of the files rather than their effect: the
 * Agent SDK takes plugins per-session through its own `plugins?:
 * SdkPluginConfig[]` option and does not auto-discover installed ones the way the
 * interactive CLI does, and paddock passes none — so bridging the directory is
 * very probably INERT today (#691, reproduced on a real machine: an installed
 * plugin's MCP server did not appear). It is governed anyway, because "inert
 * today" is a property of a caller that step 5 is about to change, and a lever
 * that silently omitted plugins would then start leaking them.
 */
export const INSTRUCTION_ENTRIES = ["CLAUDE.md", "agents", "commands", "plugins"] as const;
