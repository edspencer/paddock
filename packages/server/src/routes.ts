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
import { registerMetaRoutes, registerMetaWorkspaceRoutes } from "./routes/meta.js";
import { registerGitRoutes, registerGitWorkspaceRoutes } from "./routes/git.js";
import { registerProjectRoutes, registerProjectWorkspaceRoutes } from "./routes/projects.js";
import { registerTriggerWorkspaceRoutes } from "./routes/triggers.js";
import { registerChatWorkspaceRoutes } from "./routes/chats.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { mountWorkspaceRoutes } from "./routes/workspace-mount.js";

// Re-exported for callers/tests that reference the dep bag or the byte helper by
// name; the definitions now live in the extracted modules (issue #403).
export type { RouteDeps } from "./route-context.js";
export { parseRangeHeader } from "./http-bytes.js";

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const ctx = buildRouteContext(deps);

  registerMetaRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerProjectRoutes(app, ctx);

  // The workspace-scoped half of every group, mounted twice: `/api/root` (the
  // root workspace, key `""`) and `/api/projects/:slug` (a project). Same
  // handlers both times — that identity is the point, not an optimisation.
  await mountWorkspaceRoutes(app, (scoped) => {
    registerProjectWorkspaceRoutes(scoped, ctx);
    registerChatWorkspaceRoutes(scoped, ctx);
    registerGitWorkspaceRoutes(scoped, ctx);
    registerTriggerWorkspaceRoutes(scoped, ctx);
    registerMetaWorkspaceRoutes(scoped, ctx);
  });
  // #312 M1: the external Management API gate. Registered unconditionally (it
  // answers 404 when unconfigured) so an unconfigured `/mcp` can never fall
  // through to the SPA not-found handler and be served the app shell.
  registerMcpRoutes(app, ctx);
}
