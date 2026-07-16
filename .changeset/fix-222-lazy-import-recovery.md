---
"@paddock/web": patch
---

fix(web): recover from a failed lazy-route import instead of dead-ending (#222)

The code-split routes are loaded via `React.lazy(() => import(...))`, but the
router had no `errorElement`, so a rejected chunk import (a stale hash after a
deploy, or a transient auth/network blip) dead-ended at React Router's default
"Unexpected application error" screen. A root `errorElement` now detects
chunk-load / module-script failures and reloads once onto the current build
(guarded via sessionStorage against reload loops); genuine errors — or a chunk
error that already survived a reload — get a friendly error card with a manual
reload.
