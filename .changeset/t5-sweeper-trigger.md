---
"@paddock/server": minor
---

Fold the sweeper in as the default `afterTurn` trigger (Epic T / T5, #310). The
post-turn overview/changelog curator (the tool-less sweeper) is now the default
`curate-overview` `event`/`afterTurn` trigger. Every post-turn commit site (a human
chat turn, a session-mode wake, and each server-initiated agent turn) emits ONE
`afterTurn` lifecycle event, and its sole consumer enqueues the curation sweep — so the
sweeper dispatches exactly once per turn (no double-curation). The default is
**implicit**: a project that declares no `curate-overview` trigger sweeps exactly as
before. Declaring one only customizes the default — extend the curation prompt via
`run.prompt` / `run.promptFile` (folded under the same `=== EXTRA PROJECT-SPECIFIC
CURATOR INSTRUCTIONS ===` heading as the existing `.paddock/hooks/sweep.md`), override
the sweeper model via `run.model`, or switch curation off with `enabled: false`. The
curator is executed by `SweepService` via the `sweeper-<slug>` agent (returns marked
text, Paddock writes OVERVIEW.md/CHANGELOG.md), so — unlike every other event trigger —
it registers no scoped `trigger-<slug>-<name>` agent and is not fanned out to the
generic event dispatcher.
