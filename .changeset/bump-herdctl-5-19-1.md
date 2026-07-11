---
"@paddock/server": patch
---

chore(deps): bump @herdctl/core to ^5.19.1

Picks up the 5.19.1 session-discovery perf work: negative-caching of
resolveAutoName/resolvePreview (warm project-switch enrichment ~580ms → tens of
ms), an mtime-keyed cache for parseSessionMessages (repeat chat opens skip the
full re-parse), and dropping the duplicated tool output from the message payload.
Pairs with the Paddock-side subagent read cache (#147) and transcript
virtualization (#148).
