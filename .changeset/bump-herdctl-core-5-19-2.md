---
"@paddock/server": patch
---

Bump `@herdctl/core` to `^5.19.2`. This picks up the CLI session-path fix for herdctl#357: new CLI sessions are now identified by set-difference against a pre-spawn snapshot of `.jsonl` files rather than the old newest-by-mtime heuristic, which is the root cause of keeper chats intermittently getting mis-attributed to the post-turn sweep and vanishing from the sidebar (paddock#154).
