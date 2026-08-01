---
"@paddock/server": patch
---

Retire "keeper" from the OpenAPI surface (#585) — the last gap left by the
config/env (#592), docs (#593) and UI (#594) passes.

The published spec (`openapi-site/open-api.json`) is **generated** from the
route schemas via `app.swagger()`, so the wording was fixed at source in
`packages/server/src` and the spec regenerated with
`npm run build:server && node scripts/dump-openapi.mjs`:

- The API `info.description` no longer calls Paddock "the keeper-agent
  platform" — it is the Claude Code workspace platform (`openapi.ts`).
- `POST /api/projects`, `PATCH`, `DELETE` and `POST .../promote-to-repo`
  describe registering/re-registering **the project's agent and its sweeper**
  rather than "the keeper"; the `model` / `permissionMode` / `maxTurns` /
  `docker` / `driveMode` / `recovery` body-field descriptions follow.
- `GET .../commands` is now "List a project's slash commands".
- `POST .../chats/:sessionId/promote` creates "the project + its agent".

Also `openapi-site/index.html`'s meta description (hand-maintained, not
generated), and the `/api/models` row in `docs/API.md`, which still named the
pre-#592 `keeperDriveModeDefault` response field.

Descriptions only — no route, parameter, schema or status code changed. The
`keeper-<slug>` agent-name prefix is untouched, as in #592.
