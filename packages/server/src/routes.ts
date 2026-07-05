/**
 * REST routes.
 *
 * REAL (wired to ProjectStore / HerdctlService):
 *   GET  /api/projects                 list projects
 *   POST /api/projects                 create project (+ keeper agent + reload)
 *   GET  /api/projects/:slug           get one project
 *   PATCH /api/projects/:slug          update project metadata
 *   GET  /api/projects/:slug/files     list freeform files
 *   GET  /api/projects/:slug/files/:name  one file + render-kind hint (#3)
 *   GET  /api/projects/:slug/changelog raw CHANGELOG.md
 *   GET  /api/projects/:slug/overview  raw OVERVIEW.md (sweep-curated) (#2)
 *   PUT  /api/projects/:slug/pins      pin a file {file} (#4)
 *   DELETE /api/projects/:slug/pins/:file  unpin a file (#4)
 *   GET  /api/projects/:slug/chats     list a project's sessions (chats)
 *   GET  /api/chats                    list one-off (scratch) sessions
 *   GET  /api/fleet                    fleet status
 *   GET  /api/models                   selectable models + keeper/sweeper defaults
 *
 * THIN (chat sending happens over WS; these are convenience reads/echoes):
 *   POST /api/projects/:slug/chats     start-a-chat metadata (see TODO)
 */
import type { FastifyInstance } from "fastify";
import { ProjectError, type ProjectStore, type CreateProjectInput, type UpdateProjectInput } from "./projects.js";
import type { HerdctlService } from "./herdctl.js";
import { SCRATCH_SLUG, SCRATCH_AGENT, keeperAgentName } from "./herdctl.js";
import type { GitService } from "./git.js";
import type { GithubAuth } from "./github-auth.js";
import { readFirstUserText } from "./transcripts.js";
import { PRELOAD_CONTEXT_OPEN, stripPreloadWrapper } from "./preload.js";
import {
  MODELS,
  KEEPER_DEFAULT_MODEL,
  SWEEPER_DEFAULT_MODEL,
  isKnownModel,
  getContextLimit,
} from "./models.js";

export interface RouteDeps {
  projects: ProjectStore;
  herdctl: HerdctlService;
  git: GitService;
  githubAuth: GithubAuth;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { projects, herdctl, git, githubAuth } = deps;

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

  app.get("/api/health", async () => ({ ok: true }));

  // Selectable models + the keeper/sweeper defaults (CONTRACT-v3 §3). Static —
  // sourced from the models module so the picker and context meter agree.
  app.get("/api/models", async () => {
    return {
      models: MODELS,
      keeperDefault: KEEPER_DEFAULT_MODEL,
      sweeperDefault: SWEEPER_DEFAULT_MODEL,
    };
  });

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
      // Register the keeper + sweeper agents at runtime (fleet.addAgent).
      try {
        await herdctl.ensureProjectAgent(project);
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
      return { project, changelog, chats: await buildProjectChats(project.dir, sessions) };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.patch<{ Params: { slug: string }; Body: UpdateProjectInput }>(
    "/api/projects/:slug",
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        // Validate an explicit model override before touching disk (400 if bad).
        if (body.model !== undefined && !isKnownModel(body.model)) {
          return reply.code(400).send({ error: `Unknown model: ${body.model}`, code: "invalid" });
        }
        const project = await projects.update(req.params.slug, body);
        // Re-register the keeper so the new model takes effect (the keeper is a
        // long-lived in-memory agent; addAgent replace:true updates its config).
        try {
          await herdctl.ensureProjectAgent(project);
        } catch (err) {
          req.log.warn({ err }, "keeper-agent re-registration failed after update");
        }
        return { project };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Delete a project: remove its directory and unregister its keeper + sweeper
  // agents at runtime (fleet.removeAgent) — the inverse of the create flow.
  app.delete<{ Params: { slug: string } }>("/api/projects/:slug", async (req, reply) => {
    try {
      const project = await projects.remove(req.params.slug); // throws not_found
      try {
        await herdctl.removeProjectAgent(project.slug);
      } catch (err) {
        req.log.warn({ err }, "keeper-agent unregister failed (project dir already removed)");
      }
      return reply.code(200).send({ ok: true, slug: project.slug });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/files", async (req, reply) => {
    try {
      await projects.get(req.params.slug);
      return { files: await projects.listFiles(req.params.slug) };
    } catch (err) {
      return sendProjectError(reply, err);
    }
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
  app.post<{ Params: { slug: string }; Body: { message?: string } }>(
    "/api/projects/:slug/git/commit",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const message = req.body?.message?.trim() || `Update ${project.name}`;
        return await git.commitProject(project.dir, message);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

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

  // Raw OVERVIEW.md (the sweep-curated current-state context). Returns "" if
  // the project has no overview yet (issue #2).
  app.get<{ Params: { slug: string } }>("/api/projects/:slug/overview", async (req, reply) => {
    try {
      await projects.get(req.params.slug); // 404s for unknown slug
      const content = await projects.readOverview(req.params.slug);
      reply.header("content-type", "text/markdown; charset=utf-8");
      return content;
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Single file content + a render-kind hint (markdown | html | text | image),
  // derived from the extension. Path-traversal guarded by ProjectStore. Feeds the
  // UI's markdown/Mermaid + sandboxed-iframe renderers (issue #3).
  //
  // With `?raw=1` it instead streams the file's RAW BYTES with the correct
  // Content-Type (issue #61) — how the image viewer loads an <img>, so binary
  // bytes are no longer mangled by UTF-8 decoding. Byte responses are locked
  // down (CSP sandbox + nosniff + inline disposition) so a directly-opened SVG
  // or HTML file can't execute script in the app's origin.
  app.get<{ Params: { slug: string; name: string }; Querystring: { raw?: string } }>(
    "/api/projects/:slug/files/:name",
    async (req, reply) => {
      try {
        await projects.get(req.params.slug); // 404s for unknown slug
        const name = decodeURIComponent(req.params.name);
        if (req.query.raw !== undefined && req.query.raw !== "0" && req.query.raw !== "false") {
          const { bytes, mime } = await projects.readFileBytes(req.params.slug, name);
          return reply
            .header("content-type", mime)
            .header("content-disposition", "inline")
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", "sandbox; default-src 'none'")
            .header("cache-control", "private, max-age=60")
            .send(bytes);
        }
        return await projects.readFileWithKind(req.params.slug, name);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Pin a file as a sibling tab (issue #4). Validates the file exists + dedupes.
  app.put<{ Params: { slug: string }; Body: { file?: string } }>(
    "/api/projects/:slug/pins",
    async (req, reply) => {
      try {
        const project = await projects.pinFile(req.params.slug, req.body?.file ?? "");
        return { project };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Unpin a file (URL-encoded name) (issue #4).
  app.delete<{ Params: { slug: string; file: string } }>(
    "/api/projects/:slug/pins/:file",
    async (req, reply) => {
      try {
        const project = await projects.unpinFile(
          req.params.slug,
          decodeURIComponent(req.params.file),
        );
        return { project };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // --- chats (sessions) --------------------------------------------------

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/chats", async (req, reply) => {
    try {
      const project = await projects.get(req.params.slug);
      const sessions = await herdctl.listSessions(project).catch(() => []);
      return { chats: await buildProjectChats(project.dir, sessions) };
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
        const agent = await agentForSlug(req.params.slug);
        const messages = await herdctl
          .sessionMessages(agent, req.params.sessionId)
          .catch(() => []);
        return { messages };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Context-window usage for a project chat, read from the transcript's most
  // recent turn. Lets the UI show "context used" for a chat opened from history,
  // before any new turn streams a fresh usage value. `usage` is null when the
  // transcript has no usage data.
  app.get<{ Params: { slug: string; sessionId: string } }>(
    "/api/projects/:slug/chats/:sessionId/context",
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        let model = KEEPER_DEFAULT_MODEL;
        if (req.params.slug !== SCRATCH_SLUG) {
          const p = await projects.get(req.params.slug).catch(() => null);
          if (p?.model) model = p.model;
        }
        const u = await herdctl.sessionUsage(agent, req.params.sessionId).catch(() => null);
        return {
          usage:
            u && u.hasData
              ? { contextTokens: u.inputTokens, contextLimit: getContextLimit(model) }
              : null,
        };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Delete a chat (session) within a project: removes its transcript JSONL.
  app.delete<{ Params: { slug: string; sessionId: string } }>(
    "/api/projects/:slug/chats/:sessionId",
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const removed = await herdctl.deleteSession(agent, req.params.sessionId);
        return reply.code(200).send({ ok: true, removed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Rename a chat (session): set or clear its custom display name. Now unblocked
  // by @herdctl/core's fleet.setSessionName (issue #10). A null/empty name
  // clears any custom name.
  app.patch<{ Params: { slug: string; sessionId: string }; Body: { name?: string | null } }>(
    "/api/projects/:slug/chats/:sessionId",
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const name = req.body?.name ?? null;
        await herdctl.renameSession(agent, req.params.sessionId, name);
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // One-off chats (scratch dir). Scratch chats never get context preload, so
  // their previews are never polluted — no wrapper stripping needed.
  app.get("/api/chats", async () => {
    const sessions = await herdctl.listScratchSessions().catch(() => []);
    return { chats: sessions.map((s) => toChatDto(s)) };
  });

  // Messages of a one-off (scratch) chat.
  app.get<{ Params: { sessionId: string } }>(
    "/api/chats/:sessionId/messages",
    async (req) => {
      const messages = await herdctl
        .sessionMessages(SCRATCH_AGENT, req.params.sessionId)
        .catch(() => []);
      return { messages };
    },
  );

  // Context-window usage for a one-off (scratch) chat (see the project variant).
  app.get<{ Params: { sessionId: string } }>("/api/chats/:sessionId/context", async (req) => {
    const u = await herdctl.sessionUsage(SCRATCH_AGENT, req.params.sessionId).catch(() => null);
    return {
      usage:
        u && u.hasData
          ? { contextTokens: u.inputTokens, contextLimit: getContextLimit(KEEPER_DEFAULT_MODEL) }
          : null,
    };
  });

  // Delete a one-off (scratch) chat.
  app.delete<{ Params: { sessionId: string } }>(
    "/api/chats/:sessionId",
    async (req, reply) => {
      try {
        const removed = await herdctl.deleteSession(SCRATCH_AGENT, req.params.sessionId);
        return reply.code(200).send({ ok: true, removed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Rename a one-off (scratch) chat (issue #10).
  app.patch<{ Params: { sessionId: string }; Body: { name?: string | null } }>(
    "/api/chats/:sessionId",
    async (req, reply) => {
      try {
        await herdctl.renameSession(SCRATCH_AGENT, req.params.sessionId, req.body?.name ?? null);
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Promote a one-off (scratch) chat into a new project (issue #20): create the
  // project + keeper, then re-home the chat's transcript into it so it lists +
  // resumes under the project. Returns { project, promoted } — `promoted:false`
  // means the project was created but the transcript couldn't be moved (e.g. an
  // unknown session id); the project is still usable.
  app.post<{
    Params: { sessionId: string };
    Body: { name?: string; slug?: string; group?: string; summary?: string; domain?: string[] };
  }>("/api/chats/:sessionId/promote", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.name || !body.name.trim()) {
      return reply.code(400).send({ error: "Project name is required", code: "invalid" });
    }
    try {
      const project = await projects.create({
        name: body.name,
        slug: body.slug,
        group: body.group,
        summary: body.summary,
        domain: Array.isArray(body.domain) ? body.domain : undefined,
      });
      // Register the keeper + sweeper (creates the project's .chats symlink)
      // BEFORE moving the transcript into it.
      try {
        await herdctl.ensureProjectAgent(project);
      } catch (err) {
        req.log.warn({ err }, "promote: keeper registration failed (project still created)");
      }
      let promoted = false;
      try {
        await herdctl.promoteScratchSession(req.params.sessionId, project);
        promoted = true;
      } catch (err) {
        req.log.warn({ err }, "promote: could not re-home scratch transcript");
      }
      return reply.code(201).send({ project, promoted, sessionId: req.params.sessionId });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  /** Resolve a slug to the agent name whose sessions back it. */
  async function agentForSlug(slug: string): Promise<string> {
    if (slug === SCRATCH_SLUG) return SCRATCH_AGENT;
    await projects.get(slug); // throws not_found for unknown slug
    return keeperAgentName(slug);
  }
}

function toChatDto(
  s: import("@herdctl/core").DiscoveredSession,
  previewOverride?: string,
) {
  const preview = previewOverride ?? s.preview;
  return {
    sessionId: s.sessionId,
    workingDirectory: s.workingDirectory,
    name: s.customName ?? s.autoName ?? preview ?? s.sessionId.slice(0, 8),
    updatedAt: s.mtime,
    resumable: s.resumable,
    preview,
  };
}

/** Claude Code's own preview cap (mirrors extractFirstMessagePreview). */
const PREVIEW_MAX = 100;

/**
 * Build the chat DTOs for a PROJECT's sessions, cleaning names polluted by the
 * preload wrapper (issue #62). When a chat has no better name (no user rename,
 * no Claude-generated summary) AND its preview is the injected `<project-context>`
 * block, we read the untruncated first user message and strip the wrapper so the
 * name reflects the user's actual request. Only preload chats trigger the extra
 * (head-of-file) read; everything else maps straight through.
 */
async function buildProjectChats(
  projectDir: string,
  sessions: import("@herdctl/core").DiscoveredSession[],
) {
  return Promise.all(
    sessions.map(async (s) => {
      const pollutedPreview =
        !s.customName && !s.autoName && s.preview?.startsWith(PRELOAD_CONTEXT_OPEN);
      if (!pollutedPreview) return toChatDto(s);

      const full = await readFirstUserText(projectDir, s.sessionId).catch(() => undefined);
      const cleaned = stripPreloadWrapper(full ?? s.preview ?? "").trim();
      if (!cleaned) return toChatDto(s); // couldn't recover — leave as-is
      const preview =
        cleaned.length > PREVIEW_MAX ? `${cleaned.slice(0, PREVIEW_MAX)}...` : cleaned;
      return toChatDto(s, preview);
    }),
  );
}

function sendProjectError(reply: import("fastify").FastifyReply, err: unknown) {
  if (err instanceof ProjectError) {
    const code = err.code === "not_found" ? 404 : err.code === "exists" ? 409 : 400;
    return reply.code(code).send({ error: err.message, code: err.code });
  }
  reply.log.error({ err }, "route error");
  return reply.code(500).send({ error: (err as Error).message ?? "internal error" });
}
