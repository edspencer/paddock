---
"@paddock/server": patch
---

Chats and triggers on the default `driveMode: session` now load Claude Code's `user` setting source, as `claude -p` does. Skills, CLAUDE.md, agents and commands in Paddock's Claude home now apply on every turn. Before, herdctl's SDK default loaded only the project source. What reaches the Claude home is still decided by the `claude.*` keys.

The Claude home's `settings.json` now applies to every chat and session-mode trigger, where before only the sweeper and `driveMode: batch` turns read it. That includes the keys `claude.hooks: own` keeps: `permissions`, `env`, `enabledPlugins` and script-naming keys such as `apiKeyHelper`.

With `claude.instructions: host` and `claude.mcpServers: own`, a bridged plugin's MCP servers are no longer withheld, because `enabledPlugins` now lets Claude Code discover them.
