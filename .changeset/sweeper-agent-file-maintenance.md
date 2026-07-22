---
"@paddock/server": minor
---

Retire the sweeper's tool-less structured-text truncation; make it a proper file-maintaining curator (#379). The post-turn sweeper is now shown each curated file (OVERVIEW.md / CHANGELOG.md / CLAUDE.md) IN FULL and returns either the complete new file or NOCHANGE, instead of seeing only the first 2000 chars and blind-appending. This stops CHANGELOG.md and the CLAUDE.md curated notes (and the per-chat context they feed) growing without bound. Adds configurable per-file token budgets (`PADDOCK_CURATION_{OVERVIEW,CHANGELOG,CLAUDEMD}_MAX_TOKENS`, tri-state env < YAML < default) enforced as a backstop, a CHANGELOG change-detection gate (no near-duplicate "one bullet per sweep" entries), and a concurrency fix so activity in a 4th+ chat active within a debounce window is no longer dropped from curation.
