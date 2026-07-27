---
"@paddock/server": minor
---

`list_chats` (self-management + Management API MCP) now hides archived chats by
default, matching the web UI, and reports each chat's `archived` flag. Pass
`include_archived: true` to get them back; the result's `omittedArchived` count
always says how many were withheld, so an archived chat's `session_id` is never
silently unreachable.
