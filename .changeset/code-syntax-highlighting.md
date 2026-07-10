---
"@paddock/web": patch
---

feat: theme-aware syntax highlighting for agent-sent code (#127)

Code that the agent shares via `mcp__paddock__send_file` with `kind: "code"`
now renders with syntax highlighting instead of plain monospace. A new shared
`CodeBlock` component lazy-loads highlight.js (`highlight.js/lib/core` +
a curated grammar set matching the send-file MCP's inferable languages) so the
highlighter stays out of the entry chunk. Tokens are colored with hand-written
`.hljs-*` CSS keyed to the Paddock palette for a matched light + dark scheme;
the raw code renders immediately (no flash) and upgrades once the chunk
resolves, falling back to plain text for unknown languages or load failures.
