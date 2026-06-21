/**
 * REST routes.
 *
 * REAL (wired to ProjectStore / HerdctlService):
 *   GET  /api/projects                 list projects
 *   POST /api/projects                 create project (+ keeper agent + reload)
 *   GET  /api/projects/:slug           get one project
 *   PATCH /api/projects/:slug          update project metadata
 *   GET  /api/projects/:slug/files     list freeform files
 *   GET  /api/projects/:slug/changelog raw CHANGELOG.md
 *   GET  /api/projects/:slug/chats     list a project's sessions (chats)
 *   GET  /api/chats                    list one-off (scratch) sessions
 *   GET  /api/fleet                    fleet status
 *
 * THIN (chat sending happens over WS; these are convenience reads/echoes):
 *   POST /api/projects/:slug/chats     start-a-chat metadata (see TODO)
 */
import type { FastifyInstance } from "fastify";
import { ProjectError, type ProjectStore, type CreateProjectInput, type UpdateProjectInput } from "./projects.js";
import type { HerdctlService } from "./herdctl.js";
import { SCRATCH_SLUG } from "./herdctl.js";

export interface RouteDeps {
  projects: ProjectStore;
  herdctl: HerdctlService;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { projects, herdctl } = deps;

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/fleet", async () => {
    try {
      return { status: await herdctl.fleetStatus(), agents: await herdctl.agents() };
    } catch (err) {
      return { status: null, agents: [], error: (err as Error).message };
    }
  });

  // --- projects ----------------------------------------------------------

  app.get("/api/projects", async () => {
    return { projects: await projects.list() };
  });

  app.post<{ Body: CreateProjectInput }>("/api/projects", async (req, reply) => {
    try {
      const project = await projects.create(req.body ?? ({} as CreateProjectInput));
      // Register the keeper agent and hot-reload the fleet.
      try {
        await herdctl.ensureProjectAgent(project, await projects.list());
      } catch (err) {
        req.log.warn({ err }, "keeper-agent registration failed (project still created)");
      }
      return reply.code(201).send({ project });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.get<{ Params: { slug: string } }>("/api/projects/:slug", async (req, reply) => {
    try {
      const project = await projects.get(req.params.slug);
      // Enrich with changelog text + the project's chats (sessions).
      const [changelog, sessions] = await Promise.all([
        projects.readFile(project.slug, "CHANGELOG.md").catch(() => ""),
        herdctl.listSessions(project).catch(() => []),
      ]);
      return { project, changelog, chats: sessions.map(toChatDto) };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.patch<{ Params: { slug: string }; Body: UpdateProjectInput }>(
    "/api/projects/:slug",
    async (req, reply) => {
      try {
        const project = await projects.update(req.params.slug, req.body ?? {});
        return { project };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/files", async (req, reply) => {
    try {
      await projects.get(req.params.slug);
      return { files: await projects.listFiles(req.params.slug) };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/changelog", async (req, reply) => {
    try {
      await projects.get(req.params.slug);
      const content = await projects.readFile(req.params.slug, "CHANGELOG.md").catch(() => "");
      reply.header("content-type", "text/markdown; charset=utf-8");
      return content;
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // --- chats (sessions) --------------------------------------------------

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/chats", async (req, reply) => {
    try {
      const project = await projects.get(req.params.slug);
      const sessions = await herdctl.listSessions(project).catch(() => []);
      return { chats: sessions.map(toChatDto) };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/chats", async (req, reply) => {
    // A "new chat" is created lazily by the first WS chat:send with no
    // sessionId (the SDK mints the session id, returned in chat:complete).
    // This endpoint just validates the project and returns the WS target so
    // the client can open a socket. TODO: persist a custom chat name up-front
    // via @herdctl/core SessionMetadataStore once we have a session id.
    try {
      const project = await projects.get(req.params.slug);
      return reply.code(201).send({
        projectSlug: project.slug,
        sessionId: null,
        ws: "/ws",
        note: "Open /ws and send chat:send with this projectSlug; session id arrives in chat:complete.",
      });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Messages of a specific chat (session) within a project.
  app.get<{ Params: { slug: string; sessionId: string } }>(
    "/api/projects/:slug/chats/:sessionId/messages",
    async (req, reply) => {
      try {
        const dir = await workingDirForSlug(req.params.slug);
        const messages = await herdctl.sessionMessages(dir, req.params.sessionId).catch(() => []);
        return { messages };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // One-off chats (scratch dir).
  app.get("/api/chats", async () => {
    const sessions = await herdctl.listScratchSessions().catch(() => []);
    return { chats: sessions.map(toChatDto) };
  });

  // Messages of a one-off (scratch) chat.
  app.get<{ Params: { sessionId: string } }>(
    "/api/chats/:sessionId/messages",
    async (req) => {
      const messages = await herdctl
        .sessionMessages(herdctl.scratchDir, req.params.sessionId)
        .catch(() => []);
      return { messages };
    },
  );

  /** Resolve a slug to the working directory whose sessions back it. */
  async function workingDirForSlug(slug: string): Promise<string> {
    if (slug === SCRATCH_SLUG) return herdctl.scratchDir;
    const project = await projects.get(slug); // throws not_found
    return project.dir;
  }
}

function toChatDto(s: import("@herdctl/core").DiscoveredSession) {
  return {
    sessionId: s.sessionId,
    workingDirectory: s.workingDirectory,
    name: s.customName ?? s.autoName ?? s.preview ?? s.sessionId.slice(0, 8),
    updatedAt: s.mtime,
    resumable: s.resumable,
    preview: s.preview,
  };
}

function sendProjectError(reply: import("fastify").FastifyReply, err: unknown) {
  if (err instanceof ProjectError) {
    const code = err.code === "not_found" ? 404 : err.code === "exists" ? 409 : 400;
    return reply.code(code).send({ error: err.message, code: err.code });
  }
  reply.log.error({ err }, "route error");
  return reply.code(500).send({ error: (err as Error).message ?? "internal error" });
}
