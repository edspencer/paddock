---
"@paddock/server": patch
"@paddock/web": patch
---

Bump `@herdctl/core` to `^5.23.0` and `@herdctl/chat` to `^0.8.0`. This herdctl
release carries inline-image support (herdctl #385/#386 — image content blocks are
preserved through extraction and translation) and token-accounting fixes
(herdctl #378). `@herdctl/core` is deduped to a single installed version (5.23.0),
which is also what `@herdctl/chat@0.8.0` resolves — no split/duplicated core.
