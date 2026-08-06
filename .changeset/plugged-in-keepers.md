---
"@paddock/server": minor
"@paddock/web": minor
---

Inherit the host's Claude Code **plugins**, and stop degrading `sse` /
header-authenticated MCP servers (#700).

Requires `@herdctl/core` 5.32.0, which adds the two things Paddock had no channel
for.

**Plugins.** A plugin that provides an MCP server — a Slack plugin installed on
your laptop, say — was invisible in Paddock on every setting, because the SDK
enables a discovered plugin from `enabledPlugins` in the **user** settings source
and Paddock's agents are invoked with `setting_sources: ["project"]`. Paddock now
enumerates the host's installed plugin directories from the CLI's own
`installed_plugins.json` registry and passes them explicitly, which needs no
settings-source grant. Two levers gate it, because a plugin is mostly
instructions and only sometimes MCP servers:

| `claude.instructions` | `claude.mcpServers` | what a keeper gets |
|---|---|---|
| `host` | `host` | the plugin, including its MCP servers |
| `host` | `own`  | the plugin's commands/agents/skills/hooks only |
| `own`  | *any*  | no plugins (`instructions` is what bridges `plugins/`) |

Each plugin server's `mcp__plugin_<plugin>_<server>__*` pattern is added to the
keeper's allowed tools automatically — without it the server connects and then has
every call auto-denied with no prompt. A plugin whose manifest points `mcpServers`
at a bundle rather than declaring them inline cannot be enumerated that way; it is
still attached, and a boot warning names it and the pattern to add by hand.

**MCP server fields.** `headers` and an explicit `type` (`sse`) are now carried
through verbatim instead of being stripped. So a bearer-authenticated or `sse`
server inherited under `claude.mcpServers: host` arrives intact and finds its
stored OAuth token (which is keyed on a hash of `{type, url, headers}`), and the
boot warnings v0.62.0 shipped for both are gone. The instance's own `mcpServers:`
block accepts both keys too — `headers` values take `env:VAR_NAME` references like
everything else there, and are never printed.
