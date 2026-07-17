---
"@paddock/web": minor
"@paddock/server": minor
---

Render Paddock's own MCP tools as first-class UI (#253). Every `mcp__…` tool now
shows a humanized name (e.g. `mcp__paddock_manage__create_chat` → "Create chat")
plus a brand badge/icon instead of the raw name. The seven `paddock_manage`
tools additionally get dedicated bodies parsed from their JSON output: project
chips, a chat list with live running dots, a transcript preview, a fan-out list
of child prompts for `fork_chat_batch`, and — for `create_chat` / `fork_chat` /
`send_message` — the chat's real name/title and the kickoff prompt or sent
message (the write tools now echo `name`/`prompt` into their result payload so
this renders both live and on reload). Results link straight into the chats they
touched (`/projects/:slug/chat/:sessionId`). Parsed client-side like `send_file`.
