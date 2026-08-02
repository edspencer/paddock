---
"@paddock/server": patch
---

Decode the web-dist module path with `fileURLToPath` (groundwork for `npx`)

`config.ts` derived the default location of the built SPA from
`new URL(import.meta.url).pathname`. That pathname is percent-**encoded**, so
any install path containing a space or a non-ASCII character — `/opt/my
paddock/`, `~/Développement/paddock/` — resolved `packages/web/dist` to a
directory with a literal `%20` in it, which does not exist.

The failure was **silent**. `app.ts` treats a missing dist as "API-only mode"
and logs a warning, so the symptom was a blank page at `/` with nothing in the
UI explaining why, while `/api/health` kept returning `{"ok":true}`.

This never bit the Docker image, whose path is a fixed `/app`, and it does not
affect any instance that sets `PADDOCK_WEB_DIST` explicitly. It becomes
load-bearing the moment Paddock is installed under an arbitrary user directory,
which is exactly what `npx` / `npm i -g` will do. `fileURLToPath` also decodes
the `/C:/…` drive-letter form on Windows.

The resolution now lives in an exported `resolveDefaultWebDist(moduleUrl)` so it
can be tested against install paths this repo's own checkout does not have.
