/**
 * Git routes: the fleet-level remote + GitHub device-flow auth, plus the
 * per-project working-tree status / diff / commit surface (#258). Push is a
 * separate explicit action from a project commit.
 */
import type { FastifyInstance } from "fastify";
import { sendProjectError } from "../route-errors.js";
import type { RouteCtx } from "../route-context.js";

export function registerGitRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { git, githubAuth, projects } = ctx;

  // --- git (backing store): fleet-level remote + connection state --------
  app.get("/api/git", async () => {
    const [remote, github] = await Promise.all([git.remote(), githubAuth.status()]);
    return { ...remote, github };
  });

  // Push the working tree to origin (the NAS bare repo / configured remote).
  app.post("/api/git/push", async () => {
    return git.push();
  });

  // GitHub device-flow auth: begin → poll → disconnect.
  app.post("/api/git/github/connect", async (_req, reply) => {
    try {
      return await githubAuth.startDeviceFlow();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.post<{ Body: { deviceCode?: string } }>("/api/git/github/poll", async (req, reply) => {
    const code = req.body?.deviceCode;
    if (!code) return reply.code(400).send({ error: "deviceCode required" });
    return githubAuth.pollDeviceFlow(code);
  });
  app.post("/api/git/github/disconnect", async () => {
    await githubAuth.disconnect();
    return { ok: true };
  });

  // --- git (backing-store capability, phase 1: read surface) -------------
  // Uncommitted changes confined to this project's subtree. Returns
  // `{ repo: false }` when the projects dir isn't a git working tree, so the
  // UI hides the git affordance entirely. Never throws on git errors.
  app.get<{ Params: { slug: string } }>("/api/projects/:slug/git/status", async (req, reply) => {
    try {
      const project = await projects.get(req.params.slug);
      return await git.projectStatus(project.dir);
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Unified diff for the project's tracked changes (working tree vs HEAD), or a
  // single file via ?file=. Untracked files are reported by /git/status instead.
  app.get<{ Params: { slug: string }; Querystring: { file?: string } }>(
    "/api/projects/:slug/git/diff",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const diff = await git.projectDiff(project.dir, req.query.file);
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
    "/api/projects/:slug/git/commit",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const message = req.body?.message?.trim() || `Update ${project.name}`;
        // Optional `files` (project-relative) commits only those changes (#258);
        // omitted ⇒ commit the whole subtree (legacy behavior).
        const files = Array.isArray(req.body?.files) ? req.body?.files : undefined;
        return await git.commitProject(project.dir, message, files);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );
}
