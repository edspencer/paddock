---
"@paddock/server": patch
"@paddock/web": patch
---

chore: vendor scripts/pm preview-server wrapper

Vendor the `pm` CLI (a PM2 + shared-ports-registry wrapper for stable-port
preview servers) into the repo at `scripts/pm`, so it's MIT-licensed here and
the devbox image can bundle one canonical copy. Documented in `scripts/README.md`.
