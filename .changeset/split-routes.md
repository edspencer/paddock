---
"@paddock/server": patch
---

Refactor: split the oversized `routes.ts` (~1940 lines) Fastify REST surface into focused per-group modules, leaving `routes.ts` a ~40-line composition root. Behavior is identical — same routes, same responses, same direct `app.<verb>()` wiring (no Fastify plugins). Extracts the pure helpers into `http-bytes.ts` (`parseRangeHeader`/`cspFor`), `route-errors.ts` (`sendProjectError`), and `chat-dto.ts` (`ChatUsage`/`toChatUsage`/`toChatDto`/`buildProjectChats`/`makeTriggerResolver` + runs-limit consts); lifts the shared `RouteDeps` bag + helper closures into a `RouteCtx` built once by `buildRouteContext(deps)` in `route-context.ts`; and delegates the ~50 handlers to per-group `registerXRoutes(app, ctx)` functions in `routes/{meta,git,projects,triggers,chats}.ts`. `registerRoutes`/`RouteDeps`/`parseRangeHeader` remain exported from `./routes.js`. Part of #403.
