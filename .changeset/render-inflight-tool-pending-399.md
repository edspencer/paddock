---
"@paddock/server": patch
"@paddock/web": patch
---

Render an in-flight tool block on history rehydration (herdctl#399)

`@herdctl/core@5.24.0` now emits a still-running foreground `tool_use` as a
`ChatToolCall.pending: true` message when a transcript is rehydrated (empty
output, no duration), upgraded in place when its `tool_result` arrives. This
wires that flag through the web so a page refresh mid-turn shows the same live
"RUNNING" affordance (#175) — a spinner + "Running…" body — instead of the tool
block vanishing or looking completed. A pending `Agent`/Task shows the running
SUB-AGENT box and is not treated as expandable.

- **web** — type `ChatToolCall.pending` end-to-end; the shared `ToolBlock`
  already rendered the pending state from the live path, so the reload path now
  reuses it unchanged.
- **server** — the two paired-only positional enrichment joins
  (`attachSubagentFields`, `attachToolDetails`) now skip the injected unpaired
  pending message so it can't consume a completed sibling's recovered
  fields/detail and misalign it (e.g. a still-running parallel sub-agent wrongly
  inheriting a finished sibling's `hasSubagent` and rendering as expandable).
