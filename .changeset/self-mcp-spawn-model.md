---
"@paddock/server": patch
---

Let the self-MCP spawn tools pick the spawned chat's model (#336). `create_chat`, `fork_chat` and `fork_chat_batch` now take an optional `model` argument (validated against the same picker allow-list as the web model-picker: `claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`). An orchestrating chat fanning out worker chats can now put each on a specific, cheaper/faster model (e.g. Sonnet for straightforward docs, Opus for hard implementation) without changing the project's default model for all its chats. The override applies to the spawned chat's kickoff turn only via the existing per-chat keeper re-registration (same last-write-wins caveat as the human picker); omitting `model` is unchanged (inherits the project/box default). An unknown model id is rejected with an actionable error. Composes with the existing spawn gating (`selfMcpWriteEnabled`, `maxSpawnDepth`).
