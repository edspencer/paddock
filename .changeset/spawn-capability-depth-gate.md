---
"@paddock/server": minor
"@paddock/web": minor
---

Depth-gated self-MCP injection for spawned chats — a spawned child can now report back to its parent (#262).

Ticket B1 of the Events / Schedules / Config initiative, building on the origin+depth
provenance marker from #261. Previously a spawned chat was injected with `send_file`
ONLY, so it had no `send_message` tool and could never report back to the chat that
spawned it (recursion was prevented by omission, not by a real bound). Now the
self-management MCP — **including its write tools** — is injected into a spawned turn
based on the chat's stamped spawn `depth`:

- A spawned/scheduled turn running in a chat at depth `d` receives the self-MCP iff
  `d <= maxSpawnDepth`. When a tool-equipped child itself spawns, its children are
  stamped one hop deeper, so the bound descends and the tree can't run away.
- New config `maxSpawnDepth` — an instance default (`PADDOCK_MAX_SPAWN_DEPTH`) with a
  per-project override in Settings (the `driveMode` inherit/override pattern). **Default
  `1`**: a manager's direct children get the write tools (report-back + spawn), but
  depth-2 grandchildren do not. `maxSpawnDepth = 0` restores exactly today's behaviour
  (no spawned child gets the self-MCP — `send_file` only).

The human/scheduled root (depth 0) is unchanged — it keeps today's instance-flag gating
(`selfMcpEnabled` / `selfMcpWriteEnabled`). Internally the inline self-MCP builder is
extracted into one helper shared by the human and spawned paths, and the exact gate is a
small pure module (`spawn-capability.ts`) with full unit coverage.
