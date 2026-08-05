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
 * The reasoning is sound and the premise is **false for the runtime paddock
 * actually uses**, which is worth knowing before weighing the default.
 *
 * `~/.claude/CLAUDE.md` is NOT "auto-loaded into every session". User memory,
 * `agents/` and `commands/` all move as one unit with Claude Code's `user`
 * setting source, and herdctl invokes the Agent SDK with
 * `--setting-sources=project` for every agent that has a working directory —
 * which is every paddock keeper. Verified by capturing the outbound request
 * body: under the default sources the prompt carries a `# claudeMd` block naming
 * `<claudeHome>/CLAUDE.md`; under `["project"]` that block is absent entirely,
 * while the PROJECT's own `CLAUDE.md` still loads. `system/init` likewise drops
 * the home's subagents and slash commands from `agents` / `slash_commands`.
 * (The one thing in the home that is NOT gated is `projects/<enc>/memory/` —
 * auto-memory reaches the agent either way.)
 *
 * So on a default chat turn these four entries have been inert since chats moved
 * to the SDK runtime, bridged or not. Where they DO bite is the CLI paths — the
 * post-turn sweeper, triggers, and `driveMode: batch` chats — which pass no
 * `--setting-sources` and therefore run on the default `user,project,local`.
 *
 * That shrinks the case against `own` rather than answering it: the behaviour
 * regression the docstring warned about has, for the main path, already
 * happened, silently, and nobody filed it. What is left is a real change to the
 * CLI paths, and a lever that is correct before herdctl's default changes rather
 * than after.
 *
 * `own` is the default (#691) because the remaining argument is about what a
 * user can *state*. "`own` everywhere means nothing outside the data dir is read
 * or written" is a guarantee an operator can read off a config file; "…except
 * your CLAUDE.md, agents, commands and plugins, always, with no key to turn them
 * off" is not a guarantee, it is a footnote. A regression one documented key away
 * from being undone is recoverable; an inherited capability with no lever at all
 * is the thing #691 exists to end.
 *
 * The residual cost lands on exactly the users who invested most in their own
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
 * `plugins` is here on the strength of the files rather than their effect —
 * though NOT for the reason #691 gives. The design says the SDK "does not
 * auto-discover installed plugins" and that bridging the directory is therefore
 * inert. That is wrong on the mechanism: the runtime's plugin root IS the Claude
 * home (`join(CLAUDE_CONFIG_DIR, "plugins")`), the `plugins?: SdkPluginConfig[]`
 * option is a sideload channel that gets MERGED with what is discovered there,
 * and a live probe loaded a plugin from a planted home with no `plugins` option
 * passed at all.
 *
 * What makes it inert for paddock is one step further along: discovery is driven
 * by `enabledPlugins`, which lives in `settings.json`, and herdctl runs the SDK
 * with `--setting-sources=project` so the HOME's `settings.json` is never read
 * (see `claude-settings.ts`). Bridge the directory and the flag that turns its
 * contents on is still not loaded. That is a property of two callers rather than
 * of the files, which is exactly why this lever governs them anyway: step 5 is
 * about to change one of those callers, and a lever that silently omitted
 * plugins would then start leaking them.
 */
export const INSTRUCTION_ENTRIES = ["CLAUDE.md", "agents", "commands", "plugins"] as const;
