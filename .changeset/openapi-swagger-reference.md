---
"@paddock/server": minor
---

Add an opt-in OpenAPI / Swagger reference, generated from the server's route schemas.

- Every REST route now carries a Fastify JSON schema (tags / summary / params / querystring / body / response); `@fastify/swagger` collects them into a live OpenAPI 3 document. Schemas are permissive on input and non-stripping on output, so runtime behaviour is unchanged.
- Swagger UI mounts at `/open-api` (raw spec alias at `/open-api.json`), Paddock-branded, with **mode-aware security schemes** (bearer for `jwt`, apiKey for `trusted-header`) so the Authorize button reflects the instance's auth. Same-origin requests behind a proxy inherit the SSO session automatically.
- New instance config `PADDOCK_OPENAPI_ENABLED` (**default off — opt-in**) and `PADDOCK_OPENAPI_PATH`. When enabled, a **Swagger API** link appears in the sidebar.
- Renamed the sidebar/page label **"Instance settings" → "Settings"**.
- Added `scripts/dump-openapi.mjs` and a self-contained `openapi-site/` (branded Swagger UI + generated spec) for hosting a static API reference (e.g. Cloudflare Pages).
