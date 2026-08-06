---
"@paddock/server": patch
---

`paddock --help` now documents the fifth sharing lever.

The "Sharing your Claude Code state" section listed four keys —
`transcripts`, `credentials`, `instructions`, `hooks` — and omitted
`claude.mcpServers`, which shipped alongside them in #691 step 5. Someone
reading `--help` to find out what an instance shares would have concluded that
MCP servers were not part of the block at all.

It now lists all five, and adds a line for the sibling top-level `mcpServers:`
block (#691 step 6) — the way to give an instance a server the host machine does
not have, which is the case `host` cannot serve. Help text only; no behaviour
change.
