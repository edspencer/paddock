---
"@paddock/web": patch
---

Show the "conversation compacted" chip below the `/compact` that produced it

Claude Code appends a compaction's records to the session JSONL at positions
*preceding* the command line that triggered it, while stamping them with the time
compaction *finished*. Paddock renders in file order, so a compacted chat read
backwards: the 🗜️ boundary sat above the `/compact` chip, as though the
conversation had been compacted before anyone asked for it, with the two records
up to three minutes apart in wall-clock terms (#630).

The transcript's grouping step now moves a compaction boundary one slot past the
`/compact` echo that produced it. It is a targeted swap, not a re-sort: a boundary
with no echo to pair with (an auto-compaction) and a `/compact` whose compaction
never completed are both left in file order, and no turn is added or dropped.
Purely cosmetic — the summary body stays tucked behind its disclosure exactly as
before.
