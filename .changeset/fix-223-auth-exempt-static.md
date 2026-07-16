---
"@paddock/server": patch
---

fix(server/auth): exempt immutable static assets from the JWT gate (#223)

In `jwt`/`trusted-header` mode the auth `onRequest` hook required a valid token for
*every* request, including the content-hashed front-end bundle (`/assets/**`,
`/icons/**`, `/fonts/**`, `/sw.js`, `/manifest.webmanifest`, `/favicon.ico`). During
an identity-proxy session-refresh window those asset/module fetches would 401 →
"Load failed" / "module script failed". Those immutable, non-sensitive static
assets are now served without the token; the app shell (index.html / client routes)
and every data route (`/api`, `/ws`) stay authenticated.
