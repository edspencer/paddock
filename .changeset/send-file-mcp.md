---
"@paddock/server": minor
"@paddock/web": minor
---

Add a Paddock-native `send_file` MCP tool (`mcp__paddock__send_file`) so keeper
and scratch agents can render a file inline in the chat. It accepts either a
real `file_path` or inline `content` + `filename` for a virtual/illustrative
file, plus an optional `kind`/`language` hint. The web chat renders it with the
same Markdown (live Mermaid) / code / image componentry as the Files tab.

Wired via herdctl's `injectedMcpServers` (in-process handler fronted by the CLI
runtime's HTTP MCP bridge), so no static allow-list change is needed. The tool
returns a JSON envelope as its result `output`, which is preserved verbatim both
live and by herdctl's history parser — so a `send_file` call renders through the
ordinary tool-call path and looks identical after a page reload.

Real files are copied into a per-instance attachment store at send time and
addressed by an opaque id, so a shared file is an immutable snapshot (renders
forever, even if the original is later edited, moved, or deleted), the agent can
send from anywhere (no working-directory restriction), and the byte-serving
endpoint only ever exposes files that were explicitly sent. Attachments are
cleaned up when their chat is deleted. Inline/virtual content stays in the
transcript envelope so it remains in the agent's context.
