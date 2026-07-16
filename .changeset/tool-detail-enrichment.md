---
"@paddock/server": minor
"@paddock/web": minor
---

feat(#237): generalize tool-call enrichment + richer per-tool rendering from the discarded `toolUseResult` sidecar

herdctl's parsed `ChatToolCall` drops two rich sources present on ~100% of tool
calls: the tool's full `input` and a structured `toolUseResult` sidecar. We'd
recovered raw transcript data three times in one-off modules (`subagents.ts` #37,
`background.ts` #230, `editdiff.ts` #232). This generalizes that into one shared
server-side pass — `enrichWithToolDetails` — that recovers `{input, toolUseResult}`
for every paired tool_use (mtime-cached raw-JSONL stream, paired-only + file-ordered,
positional-join with the defensive `toolName` check) and derives per-tool structured
fields. `editdiff.ts`'s hand-rolled LCS diff is retired: the diff now comes from
`toolUseResult.structuredPatch` (real file line numbers). The two history routes call
the one orchestrator.

Richer `ToolBlock` treatments, gated on the new fields (degrading to the generic
block otherwise):

- **Edit/Write** — real `@@ -old +new @@` hunk headers + an old/new line-number gutter.
- **Read** — `basename · lines 33–40 of 210` header (full path on hover), fixing the
  long-path cutoff.
- **Bash** — split stderr (red), `interrupted` badge, exit-code interpretation, and a
  git affordance from `gitOperation`.
- **Grep/Glob** — match/file count chips.
- **TaskUpdate** — `pending → in_progress` status pills; **TaskCreate** — the task
  subject + description.

History-hydrated only (the live WS frame carries none of this); no herdctl change.
