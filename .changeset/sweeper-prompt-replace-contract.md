---
"@paddock/server": patch
---

Sweeper: bring the registered `system_prompt` in line with the whole-file
replace contract the curator has actually implemented since #379. It still told
the model to emit "exactly ONE changelog bullet line … just the bare sentence"
and described `CLAUDE.md` as "amend-only … never rewrite existing content",
while `sweep.ts` and the per-sweep user prompt both ask for the full file and
`writeChangelog`/`writeClaudeMd` replace wholesale. A model that weighted the
system prompt over the user prompt replaced the entire `CHANGELOG.md` with one
sentence — observed in the wild on this repo's own changelog. The prompt now
asks for the full `CHANGELOG.md` with existing dated entries preserved,
describes the `CLAUDE.md` curated-notes body as a section replace with dedup,
and says "three sections" instead of "two". Adds a unit test pinning the
contract so it cannot silently drift back.
