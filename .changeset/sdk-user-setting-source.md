---
"@paddock/server": patch
---

Chats and triggers on the default `driveMode: session` now load Claude Code's `user` setting source, as `claude -p` does. Skills, CLAUDE.md, agents and commands in Paddock's Claude home, and its `settings.json`, now apply on every turn. Before, herdctl's SDK default loaded only the project source. What reaches the Claude home is still decided by the `claude.*` keys. One known gap remains: with `claude.instructions: host` and `claude.mcpServers: own`, a host plugin's MCP servers now load through `enabledPlugins`.
