---
"@paddock/server": patch
---

A still-running sub-agent keeps its place in the running-sub-agents bar, and a
sub-agent's nested steps no longer reappear as top-level transcript rows after a
reload. Two `/messages` payload bugs where the live path and the history path
disagreed and the history path was wrong.

**A live sub-agent was being handed a final duration (#725, cause A).**
`subagentDurationMs` is not decoration — it is the client's *finished* signal, and
it is computed from the first→last timestamp of a transcript that may still be
growing. `attachSubagentFields`' `pending` branch already knew that and withheld
the field (#622). The `paired` branch below it stamped one unconditionally, and
because the SDK **backgrounds** sub-agents, the launching `Task` tool_result pairs
within milliseconds while the sub-agent keeps working — so a live sub-agent
reached the paired branch as a matter of course, was declared finished, and was
dropped from the bar for the rest of the run. A reload did not recover it: it
re-derives from the same code. The tell was a "final" duration that kept climbing:
9211 → 11296 → 13368.

The gate now lives at the source, so both branches are covered by construction: a
duration is published only for a sub-agent whose own transcript has actually
settled — its last line is a terminal assistant `end_turn`, or it has been quiet
for ten minutes (the fallback that keeps an *interrupted* sub-agent, which never
writes an `end_turn`, from claiming "running" forever).

Worth recording, because the issue proposed it and it does not work: a sub-agent
transcript has **no** `type: "result"` line to look for. Zero of the 483 real ones
this was measured against carried one, so "has a terminal result line" would have
withheld every duration, always. `end_turn` is the marker that actually appears
(392 of 483, and mid-file exactly once).

**Sub-agent sidechain steps leaked into history (#727).** A sub-agent's steps
belong inside its `Task` card, served by the subagents endpoint. The live path
enforces that in five places via `isSidechainMessage`; the history path had no
equivalent, because `@herdctl/core` treats `isSidechain` as a whole-*session*
property and drops the per-line marker from the messages it returns. Any sidechain
line written into a main transcript therefore came back out of `/messages` as a
first-class top-level row, rendered as a sibling of the card rather than inside it.
The markers are now recovered from the raw transcript — on `isSidechain` *or*
`parent_tool_use_id`, since the writers disagree about which they stamp — and the
rows dropped before any of the file-order joins count positions.
