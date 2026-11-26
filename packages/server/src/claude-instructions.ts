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
 * User memory, `agents/`, `commands/` and `skills/` all move as one unit with
 * Claude Code's `user` setting source. Verified by capturing the outbound
 * request body: under the default sources the prompt carries a `# claudeMd`
 * block naming `<claudeHome>/CLAUDE.md`; under `["project"]` that block is
 * absent entirely, while the PROJECT's own `CLAUDE.md` still loads. `system/init`
 * likewise drops the home's subagents and slash commands from `agents` /
 * `slash_commands`. (The one thing in the home that is NOT gated is
 * `projects/<enc>/memory/` — auto-memory reaches the agent either way.)
 *
 * For a while that premise was false on the main path. herdctl's SDK adapter
 * defaults any agent with a working directory to `["project"]`, so SDK turns
 * ignored these entries, bridged or not, while CLI turns read them. The keeper
 * and trigger agents now declare `CLAUDE_DEFAULT_SETTING_SOURCES`
 * (`herdctl-agent-names.ts`), so every turn path reads the user source and this
 * lever decides what is in it.
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
 *   it names. Under `own` that is harmless: the directory is withdrawn, so the
 *   flag has nothing to switch on. Under `instructions: host` it is a known gap,
 *   not yet closed. Every turn now loads the user source, so Claude Code
 *   discovers the bridged plugins through this flag. Discovery loads their MCP
 *   servers even under `claude.mcpServers: own`, which `claude-plugins.ts` means
 *   to prevent with `skipMcpDiscovery`. Closing it means moving this key under
 *   this lever with the directory it names.
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
 * Discovery is driven by `enabledPlugins`, which lives in the HOME's
 * `settings.json`, and every turn path now reads that file (see
 * `claude-settings.ts`). So a bridged directory is live, which is why this lever
 * governs it. See the module doc for the `enabledPlugins` gap that follows.
 */
export const INSTRUCTION_ENTRIES = ["CLAUDE.md", "agents", "commands", "plugins"] as const;
