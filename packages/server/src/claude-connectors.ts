/**
 * The `claude.connectors` key: which claude.ai connectors (Gmail, Google Drive,
 * ...) a keeper chat may use.
 *
 * Claude Code fetches a claude.ai login's connectors by itself; paddock attaches
 * nothing. Two things stood between those connectors and a keeper chat:
 *
 * 1. **Timing.** A headless Claude Code connects MCP servers in the background
 *    (`MCP_CONNECTION_NONBLOCKING` defaults on outside the TUI), and fixes the
 *    model's tool list before the connectors finish connecting. So the model saw
 *    none of them, not even ones that were allowed. Setting the variable to
 *    `false` makes the CLI wait for every MCP server before the first turn,
 *    which costs time on every turn's startup — hence only when this key is set.
 * 2. **The allowlist.** Both runtimes auto-deny any tool missing from an
 *    explicit `allowed_tools`, with no prompt, so each named connector gets its
 *    `mcp__<server>__*` pattern added, under the name the CLI gives it.
 *
 * There is no allow-all value. A connector's write tools (sending mail, sharing
 * a file) move data off the box, so each one is opted into by name.
 *
 * Once the variable is set the CLI connects EVERY connector the login has, not
 * only the named ones; the list governs what is allowed, not what loads. An
 * unnamed connector's tools are not in `allowed_tools`, so every call to one is
 * auto-denied with no prompt, on any turn.
 */

/** Claude Code's own prefix for a claude.ai connector's server name. */
const CONNECTOR_PREFIX = "claude.ai ";

/**
 * The tool-name segment Claude Code gives a claude.ai connector, from its display
 * name: `Google Drive` → `claude_ai_Google_Drive`. Mirrors the CLI's normaliser:
 * every character outside `[A-Za-z0-9_-]` becomes `_`, then (for `claude.ai `
 * names only) runs of `_` collapse and leading/trailing `_` are trimmed.
 */
export function connectorServerName(displayName: string): string {
  return `${CONNECTOR_PREFIX}${displayName}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** The `allowed_tools` pattern for one named connector. */
export function connectorToolPattern(displayName: string): string {
  return `mcp__${connectorServerName(displayName)}__*`;
}

/**
 * The flag-tier settings that make a headless Claude Code wait for MCP servers
 * before the first turn. Settings-tier `env` is applied before the CLI reads the
 * variable; checked against the bundled CLI, where the model saw the connectors
 * with it and none without.
 */
export const BLOCKING_MCP_SETTINGS_ENV = { MCP_CONNECTION_NONBLOCKING: "false" };
