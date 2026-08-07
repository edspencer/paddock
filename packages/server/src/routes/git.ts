/**
 * Git routes: the fleet-level remote + GitHub device-flow auth, plus the
 * per-project working-tree status / diff / commit surface (#258). Push is a
 * separate explicit action from a project commit.
 */
import type { FastifyInstance } from "fastify";
import { sendProjectError } from "../route-errors.js";
import type { RouteCtx } from "../route-context.js";

export function registerGitRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { git, githubAuth } = ctx;

  // --- git (backing store): fleet-level remote + connection state --------
  app.get(
    "/api/git",
    {
      schema: {
        tags: ["Git"],
        summary: "Get fleet-level git remote and GitHub connection state",
        description:
          "Returns the configured backing-store remote details merged with a `github` object describing the current GitHub device-flow connection status.",
        response: {
          200: {
            description:
              "Object containing the remote configuration fields plus a nested `github` object with connection state.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async () => {
      const [remote, github] = await Promise.all([git.remote(), githubAuth.status()]);
      return { ...remote, github };
    },
  );

  // Push the working tree to origin (the NAS bare repo / configured remote).
  app.post(
    "/api/git/push",
    {
      schema: {
        tags: ["Git"],
        summary: "Push the working tree to origin",
        description:
          "Pushes the projects working tree to the configured remote (the NAS bare repo / origin). Returns an object describing the push result.",
        response: {
          200: {
            description: "Object describing the outcome of the push operation.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async () => {
      return git.push();
    },
  );

  // GitHub device-flow auth: begin → poll → disconnect.
  app.post(
    "/api/git/github/connect",
    {
      schema: {
        tags: ["Git"],
        summary: "Begin GitHub device-flow authentication",
        description:
          "Starts the GitHub device-flow authorization and returns the device/user codes and verification URL. Responds with 400 (`{ error }`) if the flow cannot be started.",
        response: {
          200: {
            description:
              "Object with the GitHub device-flow details (e.g. device code, user code, verification URI).",
            type: "object",
            additionalProperties: true,
          },
          400: {
            description: "Error object `{ error }` when the device flow cannot be started.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (_req, reply) => {
      try {
        return await githubAuth.startDeviceFlow();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
  app.post<{ Body: { deviceCode?: string } }>(
    "/api/git/github/poll",
    {
      schema: {
        tags: ["Git"],
        summary: "Poll GitHub device-flow authentication",
        description:
          "Polls GitHub for completion of a previously-started device flow using the supplied `deviceCode`. Returns the current auth status; responds with 400 (`{ error }`) if `deviceCode` is missing.",
        body: {
          // Documentation-only (no validation/coercion): accept any/empty body.
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            deviceCode: { description: "The device code returned by the connect step." },
          },
        },
        response: {
          200: {
            description: "Object describing the current device-flow poll result / auth status.",
            type: "object",
            additionalProperties: true,
          },
          400: {
            description: "Error object `{ error }` when `deviceCode` is missing.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      const code = req.body?.deviceCode;
      if (!code) return reply.code(400).send({ error: "deviceCode required" });
      return githubAuth.pollDeviceFlow(code);
    },
  );
  app.post(
    "/api/git/github/disconnect",
    {
      schema: {
        tags: ["Git"],
        summary: "Disconnect the GitHub connection",
        description:
          "Clears the stored GitHub credentials / connection. Returns `{ ok: true }` on success.",
        response: {
          200: {
            description: "Object `{ ok: true }` confirming the disconnect.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async () => {
      await githubAuth.disconnect();
      return { ok: true };
    },
  );
}

/**
 * The workspace-scoped git surface: registered once per workspace mount (root
 * and per project) — see `workspace-mount.ts`. Paths are relative to the mount.
 */
export function registerGitWorkspaceRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { git, projects } = ctx;

  // --- git (backing-store capability, phase 1: read surface) -------------
  // Uncommitted changes confined to this project's subtree. Returns
  // `{ repo: false }` when the projects dir isn't a git working tree, so the
  // UI hides the git affordance entirely. Never throws on git errors.
  app.get<{ Params: { slug: string } }>(
    "/git/status",
    {
      schema: {
        tags: ["Git"],
        summary: "Get a project's git working-tree status",
        description:
          "Returns the uncommitted changes confined to this project's subtree. Returns `{ repo: false }` when the projects dir isn't a git working tree. Never throws on git errors.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "The project slug." },
          },
          required: ["slug"],
        },
        response: {
          200: {
            description:
              "Object describing the project's working-tree status, or `{ repo: false }` when not a git working tree.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        // The project's WORKING directory, not its metadata dir (#597): for a
        // repo-backed or linked project those differ, and `dir` showed the notes
        // folder rather than the code the project is about.
        return await git.projectStatus(project.workingDir);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Unified diff for the project's tracked changes (working tree vs HEAD), or a
  // single file via ?file=. Untracked files are reported by /git/status instead.
  app.get<{ Params: { slug: string }; Querystring: { file?: string } }>(
    "/git/diff",
    {
      schema: {
        tags: ["Git"],
        summary: "Get a project's unified diff",
        description:
          "Returns the raw unified diff (text/plain) for the project's tracked changes (working tree vs HEAD), or for a single file via `?file=`. Untracked files are reported by /git/status instead.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "The project slug." },
          },
          required: ["slug"],
        },
        querystring: {
          type: "object",
          additionalProperties: true,
          properties: {
            file: {
              type: "string",
              description: "Optional project-relative path to diff a single file.",
            },
          },
        },
        produces: ["text/plain"],
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const diff = await git.projectDiff(project.workingDir, req.query.file);
        reply.header("content-type", "text/plain; charset=utf-8");
        return diff;
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Commit this project's pending changes (phase 2). `committed: false` when
  // there was nothing to commit. Push is a separate explicit action (/api/git/push).
  app.post<{ Params: { slug: string }; Body: { message?: string; files?: string[] } }>(
    "/git/commit",
    {
      schema: {
        tags: ["Git"],
        summary: "Commit a project's pending changes",
        description:
          "Commits the project's pending changes. Optional `files` (project-relative) commits only those changes; omitted commits the whole subtree. Returns an object where `committed: false` indicates there was nothing to commit. Push is a separate explicit action (/api/git/push).",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "The project slug." },
          },
          required: ["slug"],
        },
        body: {
          // Documentation-only (no validation/coercion): accept any/empty body.
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            message: { description: "Optional commit message; defaults to `Update <project name>`." },
            files: { description: "Optional project-relative paths (array) to commit only those changes." },
          },
        },
        response: {
          200: {
            description:
              "Object describing the commit result; `committed: false` when there was nothing to commit.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const message = req.body?.message?.trim() || `Update ${project.name}`;
        // Optional `files` (project-relative) commits only those changes (#258);
        // omitted ⇒ commit the whole subtree (legacy behavior).
        const files = Array.isArray(req.body?.files) ? req.body?.files : undefined;
        return await git.commitProject(project.workingDir, message, files);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );
}
