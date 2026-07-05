---
"@paddock/server": minor
"@paddock/web": minor
---

Support running slash commands (e.g. `/compact`) in chat.

Typing a leading-slash message in the composer now routes to a new `chat:command`
WebSocket path instead of being sent as a plain prompt. The server drives
herdctl's streaming chat session (`openChatSession`) so the Claude Code CLI
dispatches the command against the current session — `/compact` compacts the
real chat history. A compaction is surfaced as a visible assistant note
("🗜️ Context compacted (was N tokens)."), and the session list refreshes
afterwards. Output otherwise streams over the same response/tool/complete events
as a normal turn.

Requires `@herdctl/core` with `FleetManager.openChatSession` (the streaming
session API). The session runs on the SDK runtime even though Paddock's keeper /
scratch agents use the `cli` runtime for batch turns — same subscription auth,
shared on-disk session store, so a CLI-created chat resumes cleanly.
