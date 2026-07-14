---
"@paddock/web": minor
"@paddock/server": minor
---

Ship the web UI as an installable PWA (#199): add a web app manifest, brand
icons (192/512 + maskable + apple-touch-icon), browser-tab favicons (16/32 PNG +
`favicon.ico`; the app previously had none), iOS standalone `<head>` tags, and
a dependency-free service worker (registered in production only) that caches the
app shell for offline launch. Navigations are network-first with a cached-shell
fallback (covering both true-offline and app-server-down cases); `/api` and `/ws`
are never cached. This enables Add-to-Home-Screen + full-screen standalone launch
and is the prerequisite for Web Push notifications (#200).
