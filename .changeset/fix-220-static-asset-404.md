---
"@paddock/server": patch
---

fix(server): return 404 for missing static assets instead of the SPA shell (#220)

The SPA not-found handler served `index.html` (HTTP 200, `text/html`) for *any*
non-`/api`/`/ws` GET, including missing hashed assets. After a deploy, a client or
service worker still referencing an old chunk hash received HTML for a JS/CSS
module → "Failed to load module script" ("Unexpected application error: a module
script failed"), which the service worker then cached under the asset URL. Missing
static assets (paths with a file extension that aren't real navigations) now 404;
client-side routes — including dotted file deep-links carrying `Accept: text/html`
or `Sec-Fetch-Mode: navigate` — still resolve to the shell.
