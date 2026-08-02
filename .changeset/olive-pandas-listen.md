---
"@paddock/server": patch
---

Make the self-MCP read tools honest about what they drop, and point callers at the raw transcript (#615).

`read_chat`'s description now states the thing that surprises every caller:
`role: "tool"` entries come back with **empty** text — no tool name, input or
output — and they still count against `limit`, so on a tool-heavy chat most of
the reply is blank padding. Thinking blocks, attachments and sub-agent
transcripts are dropped outright. It also says what the tool is therefore *not*
for (auditing how a chat went) and where the lossless data lives:
`<data-dir>/projects/<slug>/.chats/<sessionId>.jsonl`, sub-agents under
`<sessionId>/subagents/agent-*.jsonl`.

It also flags a silent footgun: an unknown `session_id` returns `total: 0` with
no error. A nightly reviewer hit exactly this, mistyped one id, and published
"empty chat" about a conversation it had never opened.

`list_chats` now says that `name` falls back to an 8-character `sessionId`
prefix when a chat has no stored title — that it means *untitled*, and is not a
usable id.

Descriptions and docs only; no behaviour change.
