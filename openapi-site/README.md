# Paddock HTTP API — static reference site

A self-contained, **read-only** API reference for the latest Paddock release:
Swagger UI (`index.html`) rendering `open-api.json`. It is **not connected to a
live server** — "Try it out" is disabled.

**This directory is the single source of truth for the published reference.** The
docs site copies it verbatim into `website/public/api/` via `website`'s
`prebuild` script (`website/scripts/copy-openapi-site.mjs`), so it ships at
**`/api/`** on the docs site with no extra deploy config. `website/public/api/` is
a gitignored build artifact — edit files *here*, never there.

Because the published mount is `/api/`, `index.html` loads the spec from the
absolute path **`/api/open-api.json`** (a relative URL breaks if the page URL
loses its trailing slash). Publishing this directory at some *other* root — e.g.
a standalone `paddock-api.<domain>` Pages project, as below — therefore needs
that `url:` adjusted to match.

## Files

- `index.html` — branded Swagger UI (loads swagger-ui-dist from a CDN, reads `./open-api.json`).
- `open-api.json` — the OpenAPI 3.0 spec, **generated from the server's route schemas**.
- `icon-192.png` — the Paddock logo used in the header.

## Regenerate the spec

The spec is derived from the live route schemas, so regenerate it after any route
change (and on each release):

```bash
npm run build:server              # compile the server (dist/)
node scripts/dump-openapi.mjs     # writes openapi-site/open-api.json
```

The dump boots the app in-process against a throwaway temp dir (no port, no real
data) and reads `app.swagger()`. It pins `PADDOCK_AUTH_MODE=jwt` so the published
reference advertises the bearer Authorize flow (the security schemes are
mode-aware; see `packages/server/src/openapi.ts`).

## Deploy to Cloudflare Pages

This directory is the publish root — no build step.

**One-time (needs Cloudflare account access):**
1. Create a Pages project (Direct Upload, or connected to this repo).
2. Point a subdomain (e.g. `paddock-api.<domain>`) at it via a CNAME in Cloudflare DNS.

**Each release (Wrangler):**
```bash
npm run build:server && node scripts/dump-openapi.mjs
npx wrangler pages deploy openapi-site --project-name paddock-api
```

To automate: add a step to the release workflow that runs the two commands above
after the version is cut, using a `CLOUDFLARE_API_TOKEN` repo secret. (Not wired
up yet — needs the Cloudflare token + project to exist first.)
