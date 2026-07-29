/**
 * workspace-mount — the seam that makes the root workspace and a project
 * workspace run literally the same route handlers.
 *
 * A workspace is identified by its path relative to `projectsRoot`, and the root
 * workspace's key is the empty string (see `project-paths.ts`). An empty string
 * cannot ride in a URL path segment — `/api/projects//chats` does not match — so
 * rather than smuggle a sentinel like `__root` into the wire, the
 * workspace-scoped routes are a Fastify plugin **registered twice**:
 *
 * | mount                   | workspace key    |
 * |-------------------------|------------------|
 * | `/api/root`             | `""`             |
 * | `/api/projects/:slug`   | `params.slug`    |
 *
 * **This is the architectural guarantee, not a convenience.** "The root behaves
 * exactly like a project" is true by construction — same handlers, same schemas,
 * same error paths — instead of being a property someone has to remember to
 * preserve. The previous design made the root a project with a reserved slug and
 * then had to keep two resolution branches in step; one of them was missed and
 * every root file route 404'd.
 *
 * Handlers are untouched by the split: they still read `req.params.slug`. On the
 * root mount there is no `:slug` segment to match, so {@link rootParamsHook}
 * injects `slug: ""` in `onRequest` — which runs BEFORE schema validation, so
 * the existing `required: ["slug"]` params schemas keep validating unchanged.
 * (Verified against Fastify directly rather than assumed.)
 */
import type { FastifyInstance } from "fastify";

/** URL prefix for the root workspace's scoped routes. */
export const ROOT_MOUNT_PREFIX = "/api/root";

/** URL prefix (parametric) for a project workspace's scoped routes. */
export const PROJECT_MOUNT_PREFIX = "/api/projects/:slug";

/**
 * Give the root mount the `slug` param its handlers and schemas expect.
 *
 * `onRequest` is deliberate: it is the earliest lifecycle hook, and in
 * particular it runs before params validation, so a schema declaring
 * `required: ["slug"]` still passes on a path that has no `:slug` segment.
 */
export function rootParamsHook(app: FastifyInstance): void {
  app.addHook("onRequest", (req, _reply, done) => {
    req.params = { ...((req.params as Record<string, unknown>) ?? {}), slug: "" };
    done();
  });
}

/**
 * Register one workspace-scoped route group at both mounts.
 *
 * `group` is a plain Fastify plugin that declares its paths RELATIVE to the
 * workspace (e.g. `/chats/:sessionId`, not `/api/projects/:slug/chats/:sessionId`).
 */
export async function mountWorkspaceRoutes(
  app: FastifyInstance,
  group: (app: FastifyInstance) => void,
): Promise<void> {
  await app.register(
    async (scoped) => {
      rootParamsHook(scoped);
      group(scoped);
    },
    { prefix: ROOT_MOUNT_PREFIX },
  );
  await app.register(
    async (scoped) => {
      group(scoped);
    },
    { prefix: PROJECT_MOUNT_PREFIX },
  );
}
