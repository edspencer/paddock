---
"@paddock/server": minor
"@paddock/web": minor
---

Add a Paddock-native `send_file` MCP tool (`mcp__paddock__send_file`) so keeper
and scratch agents can render a file inline in the chat. It accepts either a
real `file_path` (read from the working directory, symlink-sandboxed) or inline
`content` + `filename` for a virtual/illustrative file, plus an optional
`kind`/`language` hint. The web chat renders the emitted `chat:file` frame with
the same Markdown (live Mermaid) / code / image componentry as the Files tab.

Wired via herdctl's `injectedMcpServers` (in-process handler fronted by the CLI
runtime's HTTP MCP bridge), so no static allow-list change is needed. Live-only
for now — sent files are not yet persisted across reload (follow-up).
