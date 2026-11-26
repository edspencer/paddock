---
"@paddock/server": minor
---

New `claude.connectors` key (env `PADDOCK_CLAUDE_CONNECTORS`) lists the claude.ai connectors keeper chats may use, by display name. Each named connector's `mcp__claude_ai_<name>__*` tools are allowed, and the keeper waits for MCP servers before a turn starts so the connectors reach the model's tool list. The default is none, which changes nothing.
