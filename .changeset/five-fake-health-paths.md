---
"@paddock/server": patch
---

Auth no longer exempts five unregistered health paths (`/healthz`, `/-/health`, `/health`, `/readyz`, `/livez`)

Only `/api/health` was ever a registered route. The other five were exempt from
authentication but served by nothing, so with the SPA mounted they fell through to
the front-end catch-all and answered `200 text/html` — the app shell — to an
unauthenticated probe. A monitoring check pointed at `/healthz` therefore reported
healthy regardless of the instance's actual state, and in `trusted-header`/`jwt`
mode the exemption inverted the truthful answer (an unknown path 401s; these did
not).

**Operator action:** point every liveness/readiness probe at **`/api/health`**,
which returns `200 {"ok":true}` as `application/json`. The shipped `Dockerfile`
HEALTHCHECK and the Kubernetes manifests already use it, so no in-tree deployment
changes. The five retired paths are now gated like any other unknown path. `AUTH.md`
and the website's authentication page previously documented all six as exempt and
have been corrected.
