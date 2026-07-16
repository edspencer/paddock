---
"@paddock/web": patch
---

fix(web/PWA): version the service-worker cache per build and stop it masking auth / poisoning asset URLs (#221)

The hand-rolled service worker never invalidated across deploys (`CACHE_VERSION`
was a hardcoded constant) and served its cached app shell on *any* non-OK
navigation — masking SSO login redirects and wedging the app on a stale shell
after an auth lapse. It could also cache an HTML document (a mis-served
`index.html`) under an asset URL. Now: `CACHE_VERSION` is stamped at build time
(pkg version + bundle hash) so every deploy activates a fresh cache and purges the
old one; navigations pass 401s/redirects through (cached shell only when truly
offline); HTML is never cached under, nor served for, an asset URL; and a newly
activated build reloads the tab once (`controllerchange`, guarded against loops).
