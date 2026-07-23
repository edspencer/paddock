/**
 * Project routes: the projects CRUD surface (list/create/get/update/delete +
 * notebook→repo promote), the pin/unpin sibling-tab endpoints (#4), and the
 * read-only file/changelog/overview/commands surface (#2/#3/#103/#259). The
 * chat/trigger/git clusters live in their own sibling modules.
 */
import type { FastifyInstance } from "fastify";
import {
  ProjectError,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "../projects.js";
import { keeperAgentName } from "../herdctl.js";
import {
  isKnownModel,
  isKnownPermissionMode,
  isValidMaxTurns,
  isKnownDriveMode,
  MAX_TURNS_LIMIT,
} from "../models.js";
import { isValidMaxSpawnDepth, MAX_SPAWN_DEPTH_LIMIT } from "../spawn-capability.js";
import { sendProjectError } from "../route-errors.js";
import { buildProjectChats, makeTriggerResolver } from "../chat-dto.js";
import type { RouteCtx } from "../route-context.js";

export function registerProjectRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { projects, herdctl, git, archive, star, readState, runProvenance, readStateUser } = ctx;

  app.get("/api/projects", async (req) => {
    // Fold a compact per-project list of `{ sessionId, lastTurnCompletedAt,
    // lastSeen }` into the payload so the sidebar can compute each project's
    // UNREAD count (#161) server-backed (#189) — the completed-turn side comes
    // from the SAME cheap job-record scan as the per-chat unread signal, grouped
    // by keeper agent; `lastSeen` is the server-side read-state (in-memory after
    // first load). No `listSessions` fan-out, no transcript parse.
    const [list, turnsByProject, dirty] = await Promise.all([
      projects.list(),
      herdctl.lastTurnCompletedAtByProject().catch(() => new Map<string, Map<string, string>>()),
      // Uncommitted-file count per project subtree — one cheap `git status` over
      // the whole store, drives the projects-grid "N uncommitted" chip (#258).
      git.dirtyCounts().catch(() => ({}) as Record<string, number>),
    ]);
    const user = readStateUser(req);
    const projectsOut = await Promise.all(
      list.map(async (p) => {
        const bySession = turnsByProject.get(p.slug);
        const keeper = keeperAgentName(p.slug);
        const chatTurns = bySession
          ? await Promise.all(
              [...bySession].map(async ([sessionId, lastTurnCompletedAt]) => {
                const lastSeen = await readState
                  .getLastSeen(user, keeper, sessionId)
                  .catch(() => 0);
                return { sessionId, lastTurnCompletedAt, ...(lastSeen ? { lastSeen } : {}) };
              }),
            )
          : [];
        return { ...p, chatTurns, dirty: dirty[p.slug] ?? 0 };
      }),
    );
    return { projects: projectsOut };
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
      const [changelog, sessions, lastTurnAt] = await Promise.all([
        projects.readFile(project.slug, "CHANGELOG.md").catch(() => ""),
        herdctl.listSessions(project).catch(() => []),
        herdctl.lastTurnCompletedAt().catch(() => new Map<string, string>()),
      ]);
      const keeper = keeperAgentName(project.slug);
      const archivedOf = (s: import("@herdctl/core").DiscoveredSession) =>
        archive.isArchived(keeper, s.sessionId);
      const starredOf = (s: import("@herdctl/core").DiscoveredSession) =>
        star.isStarred(keeper, s.sessionId);
      const user = readStateUser(req);
      const lastSeenOf = (s: import("@herdctl/core").DiscoveredSession) =>
        readState.getLastSeen(user, keeper, s.sessionId);
      // Provenance badge (#267): how each chat was created — human / scheduled /
      // spawned (A1's #261 marker). A cheap in-memory map read, so unlike the
      // usage ring (#116) it's fine to resolve inline for the initial payload.
      const provenanceOf = (s: import("@herdctl/core").DiscoveredSession) =>
        runProvenance.get(s.sessionId);
      // Trigger capability descriptor for trigger chats (Epic T / T4) — truthful from
      // the registered trigger agent config. A no-op for the keeper chats that dominate.
      const triggerOf = makeTriggerResolver(project);
      // Deliberately NO usage resolver here (issue #116): the per-chat context
      // ring requires streaming+parsing each session's full transcript, which is
      // O(chats × transcript size) and blocked the whole ProjectView from
      // rendering (2–3s on chat-heavy projects). Chats come back immediately from
      // cached name/preview/mtime; the client fills rings in afterwards via the
      // separate GET .../chats/usage endpoint below.
      return {
        project,
        changelog,
        chats: await buildProjectChats(
          project.dir,
          sessions,
          undefined,
          archivedOf,
          lastTurnAt,
          lastSeenOf,
          provenanceOf,
          triggerOf,
          starredOf,
        ),
      };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.patch<{ Params: { slug: string }; Body: UpdateProjectInput }>(
    "/api/projects/:slug",
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        // Validate explicit keeper-agent overrides before touching disk (400 if
        // bad) — these re-register the keeper, so a bad value must not persist.
        if (body.model !== undefined && !isKnownModel(body.model)) {
          return reply.code(400).send({ error: `Unknown model: ${body.model}`, code: "invalid" });
        }
        if (body.permissionMode !== undefined && !isKnownPermissionMode(body.permissionMode)) {
          return reply
            .code(400)
            .send({ error: `Unknown permission mode: ${body.permissionMode}`, code: "invalid" });
        }
        if (body.maxTurns !== undefined && !isValidMaxTurns(body.maxTurns)) {
          return reply
            .code(400)
            .send({ error: `max_turns must be an integer 1–${MAX_TURNS_LIMIT}`, code: "invalid" });
        }
        if (body.docker !== undefined && typeof body.docker !== "boolean") {
          return reply.code(400).send({ error: "docker must be a boolean", code: "invalid" });
        }
        // `null` is valid — it clears the per-project override (inherit the
        // global default, issue #122). Only a non-null, unknown string is a 400.
        if (
          body.driveMode !== undefined &&
          body.driveMode !== null &&
          !isKnownDriveMode(body.driveMode)
        ) {
          return reply
            .code(400)
            .send({ error: `Unknown drive mode: ${body.driveMode}`, code: "invalid" });
        }
        // `null` is valid — it clears the per-project override (inherit the
        // instance default, #262). Only a non-null, out-of-range value is a 400.
        if (
          body.maxSpawnDepth !== undefined &&
          body.maxSpawnDepth !== null &&
          !isValidMaxSpawnDepth(body.maxSpawnDepth)
        ) {
          return reply.code(400).send({
            error: `max_spawn_depth must be an integer 0–${MAX_SPAWN_DEPTH_LIMIT}`,
            code: "invalid",
          });
        }
        // `null` clears the per-project hook-MCP override (inherit the instance
        // default, G5). Only a non-null, non-boolean value is a 400.
        if (
          body.hooksMcpEnabled !== undefined &&
          body.hooksMcpEnabled !== null &&
          typeof body.hooksMcpEnabled !== "boolean"
        ) {
          return reply
            .code(400)
            .send({ error: "hooks_mcp_enabled must be a boolean", code: "invalid" });
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
        await herdctl.removeProjectAgent(
          project.slug,
          Object.keys(project.hooks ?? {}),
          Object.keys(project.triggers ?? {}),
        );
      } catch (err) {
        req.log.warn({ err }, "keeper-agent unregister failed (project dir already removed)");
      }
      return reply.code(200).send({ ok: true, slug: project.slug });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Promote a NOTEBOOK project into a REPO-BACKED one in place (issue #213):
  // clone the given repo into the nested checkout, flip the keeper's cwd to it,
  // and re-register the keeper (which re-symlinks the new cwd's transcript path at
  // the project's existing `.chats/` store, so every chat stays listed + resumable).
  // The project's chats + sidecar metadata (OVERVIEW/CHANGELOG/settings) are kept.
  // On clone failure the notebook is left wholly intact (rollback in `promote()`).
  app.post<{ Params: { slug: string }; Body: { repo?: string } }>(
    "/api/projects/:slug/promote",
    async (req, reply) => {
      try {
        const repo = req.body?.repo;
        if (typeof repo !== "string" || !repo.trim()) {
          return reply.code(400).send({ error: "A repo URL is required", code: "invalid" });
        }
        const project = await projects.promote(req.params.slug, repo);
        // Re-register the keeper at the NEW working dir (the checkout) and re-symlink
        // its transcript path at the project's `.chats/` — this is what keeps the
        // existing chats listed + resumable under the new cwd (issue #213 #1).
        try {
          await herdctl.ensureProjectAgent(project);
        } catch (err) {
          req.log.warn({ err }, "promote: keeper re-registration failed (project still promoted)");
        }
        return reply.code(200).send({ project });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // One level of a project's file tree (issue #259). `?path=<subpath>` descends
  // into a subdirectory ("" / omitted = the project root). The response is a
  // discriminated union on `kind`: a directory returns its `entries` (each with
  // its own file|dir kind, dirs sorted first) so the Files tab can navigate into
  // folders; a path that names a FILE returns `{ kind: "file", entries: [] }`
  // (200, not an error — so the client can drop straight into the viewer without
  // a noisy 409). Path-traversal guarded by ProjectStore.resolveInProject.
  app.get<{ Params: { slug: string }; Querystring: { path?: string } }>(
    "/api/projects/:slug/files",
    async (req, reply) => {
      try {
        await projects.get(req.params.slug);
        const subpath = req.query.path ?? "";
        try {
          const entries = await projects.listFiles(req.params.slug, subpath);
          return { path: subpath, kind: "dir", entries };
        } catch (err) {
          // `subpath` is a file, not a directory — a valid target, just rendered
          // by the single-file viewer rather than listed.
          if (err instanceof ProjectError && err.code === "not_directory") {
            return { path: subpath, kind: "file", entries: [] };
          }
          throw err;
        }
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

  // Slash commands available to a project's keeper agent, for the composer's
  // autocomplete menu (issue #103). Built-ins (`/compact`, `/clear`, …) plus the
  // project's `.claude/commands` and any MCP-provided commands. NOT per-session —
  // a dedicated endpoint mirroring GET /api/models, not part of toChatDto. The
  // underlying listAgentCommands spawns a short-lived `claude` subprocess, so the
  // service memoizes the result per agent (see HerdctlService.listCommands).
  app.get<{ Params: { slug: string } }>("/api/projects/:slug/commands", async (req, reply) => {
    try {
      await projects.get(req.params.slug); // 404s for unknown slug
      const commands = await herdctl.listCommands(keeperAgentName(req.params.slug));
      return { commands };
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
}
