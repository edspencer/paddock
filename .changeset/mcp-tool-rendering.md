---
"@paddock/web": minor
---

Render Paddock's own MCP tools as first-class UI (#253). Every `mcp__…` tool now
shows a humanized name (e.g. `mcp__paddock_manage__create_chat` → "Create chat")
plus a brand badge/icon instead of the raw name. The seven `paddock_manage`
tools additionally get dedicated bodies parsed from their JSON output: project
chips, a chat list with live running dots, a transcript preview, and — for
`fork_chat_batch` — a fan-out list of child prompts. Results link straight into
the chats they touched (`/projects/:slug/chat/:sessionId`). Web-only; parsed
client-side like `send_file`, no server or protocol change.
