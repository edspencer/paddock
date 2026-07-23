/**
 * REST routes — composition root.
 *
 * The Fastify REST surface is one `registerRoutes(app, deps)` that builds the
 * shared route context once (see {@link buildRouteContext}) and then hangs each
 * per-group cluster off the app via a `registerXRoutes(app, ctx)` call. The
 * handlers themselves live in the sibling group modules; the pure DTO/HTTP
 * helpers live in `chat-dto.ts` / `http-bytes.ts` / `route-errors.ts` (issue
 * #403 — break up oversized files). Each group registers directly off `app`
 * (no Fastify plugins), preserving the original wiring shape.
 *
 * The route map, by group:
 *   meta     — /api/transcription, /api/transcribe, /api/me, /api/health,
 *              /api/instance-config, /api/models, /api/commands, /api/fleet,
 *              /api/chat-files/:id, project chat upload
 *   git      — /api/git[/push|/github/*], project git status/diff/commit
 *   projects — projects CRUD + promote, pins, files/changelog/overview/commands
 *   triggers — project triggers CRUD + runtime + run-now
 *   chats    — project + scratch chat lifecycle (list/runs/usage/create/messages/
 *              subagents/context/delete/rename/fork/archive/star/seen/promote)
 */
import type { FastifyInstance } from "fastify";
import { buildRouteContext, type RouteDeps } from "./route-context.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerTriggerRoutes } from "./routes/triggers.js";
import { registerChatRoutes } from "./routes/chats.js";

// Re-exported for callers/tests that reference the dep bag or the byte helper by
// name; the definitions now live in the extracted modules (issue #403).
export type { RouteDeps } from "./route-context.js";
export { parseRangeHeader } from "./http-bytes.js";

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const ctx = buildRouteContext(deps);

  registerMetaRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerTriggerRoutes(app, ctx);
  registerChatRoutes(app, ctx);
}
