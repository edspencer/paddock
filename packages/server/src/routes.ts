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
 *   GET  /api/commands                 slash commands for one-off (scratch) chats (#103)
 *   GET  /api/projects/:slug/commands  slash commands for a project's keeper (#103)
 *
 * THIN (chat sending happens over WS; these are convenience reads/echoes):
 *   POST /api/projects/:slug/chats     start-a-chat metadata (see TODO)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ProjectError, type ProjectStore, type CreateProjectInput, type UpdateProjectInput } from "./projects.js";
import {
  sanitizeSchedule,
  isValidScheduleName,
  scheduleToHerdctl,
  type PaddockSchedule,
} from "./schedule-config.js";
import { AttachmentStore, collectAttachmentIds } from "./attachments.js";
import type { HerdctlService } from "./herdctl.js";
import { SCRATCH_SLUG, SCRATCH_AGENT, keeperAgentName } from "./herdctl.js";
import type { GitService } from "./git.js";
import type { GithubAuth } from "./github-auth.js";
import type { ArchiveStore } from "./archive.js";
import type { ReadStateStore } from "./read-state.js";
import type { RunProvenance, RunProvenanceStore } from "./run-provenance.js";
import { applyMessageProvenance, type MessageProvenanceStore } from "./message-provenance.js";
import { buildProjectRuns } from "./runs.js";
import type { PaddockConfig } from "./config.js";
import { type Transcriber, TranscriptionError } from "./transcribe.js";
import { readFirstUserText } from "./transcripts.js";
import { readSubagentMessages, readSessionTokenUsageWithSubagents } from "./subagents.js";
import { enrichWithToolDetails } from "./tooldetails.js";

/**
 * The subset of @fastify/multipart's decorated request we use. The plugin
 * decorates `req.file()` at runtime; we model just what we need here rather than
 * rely on the plugin's global `declare module 'fastify'` augmentation, which is
 * brittle under workspace hoisting (fastify can resolve to a different physical
 * copy than the one the plugin augments).
 */
interface UploadedFile {
  filename?: string;
  mimetype?: string;
  toBuffer(): Promise<Buffer>;
}
type MultipartRequest = FastifyRequest & {
  file(): Promise<UploadedFile | undefined>;
};
import { PRELOAD_CONTEXT_OPEN, stripPreloadWrapper } from "./preload.js";
import {
  MODELS,
  KEEPER_DEFAULT_MODEL,
  SWEEPER_DEFAULT_MODEL,
  isKnownModel,
  getContextLimit,
  estimateCostUsdByModel,
  isKnownPermissionMode,
  isValidMaxTurns,
  isKnownDriveMode,
  MAX_TURNS_LIMIT,
} from "./models.js";
import { type SessionTokenUsage } from "./usage.js";
import { isValidMaxSpawnDepth, MAX_SPAWN_DEPTH_LIMIT } from "./spawn-capability.js";
import type { PaddockEventBus } from "./event-bus.js";

export interface RouteDeps {
  projects: ProjectStore;
  herdctl: HerdctlService;
  git: GitService;
  githubAuth: GithubAuth;
  transcriber: Transcriber;
  archive: ArchiveStore;
  readState: ReadStateStore;
  runProvenance: RunProvenanceStore;
  /**
   * Per-MESSAGE provenance sidecar (issue #290): who injected each machine-added
   * turn. Joined into a chat's message DTO so the history can attribute injected
   * turns ("↩ sent by …" / "⏰ scheduled by …"). Absence ⇒ human (the default).
   */
  messageProvenance: MessageProvenanceStore;
  attachments: AttachmentStore;
  /**
   * Manually fire a project's schedule NOW (issue #266 / D4), backing the
   * `POST …/schedules/:name/trigger` route. Supplied by the chat handler
   * (`makeChatHandler(...).fireSchedule`) so a "trigger now" runs the schedule
   * through the SAME hub path a cron fire uses — a first-class, discoverable chat.
   * Resolves the started chat's session id, or `null` if nothing started.
   */
  fireSchedule: (slug: string, scheduleName: string) => Promise<string | null>;
  /**
   * In-process lifecycle event bus (Epic G / G1). The archive route emits `onArchive`
   * on it AFTER the archive commits, so the hook dispatcher (wired in the chat
   * handler) fires the project's enabled onArchive hooks. Optional so tests that don't
   * exercise hooks can omit it.
   */
  events?: PaddockEventBus;
  cfg: PaddockConfig;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const {
    projects,
    herdctl,
    git,
    githubAuth,
    transcriber,
    archive,
    readState,
    runProvenance,
    messageProvenance,
    attachments,
    fireSchedule,
    events,
    cfg,
  } = deps;

  // Resolve the read-state key's user segment from the authenticated principal:
  // a REAL identity (trusted-header / jwt) keys read-state by username; an
  // anonymous principal (`none` mode) uses the shared bucket (null → no user
  // segment). This is the ONLY place user identity is consumed — read-state is
  // user-keyed-when-present; chat VISIBILITY is deliberately not gated (#189).
  const readStateUser = (req: FastifyRequest): string | null =>
    req.user && !req.user.anonymous ? req.user.username : null;

  // --- voice dictation (#voice): capability probe + transcription -------
  // The composer polls this to decide whether to show a mic button. `available`
  // is false on instances with dictation off (or a misconfigured remote).
  app.get("/api/transcription", async () => ({
    available: transcriber.available,
    mode: transcriber.mode,
    model: transcriber.model,
  }));

  // Transcribe a recorded audio blob (multipart `file`) → `{ text }`. The mic
  // button records WebM/Opus in the browser and POSTs it here; the server runs
  // whisper (remote OpenAI-compatible endpoint or local whisper.cpp).
  app.post("/api/transcribe", async (req, reply) => {
    if (!transcriber.available) {
      return reply.code(503).send({ error: "voice dictation is not enabled on this instance" });
    }
    let part: UploadedFile | undefined;
    try {
      part = await (req as MultipartRequest).file();
    } catch (err) {
      // @fastify/multipart throws on oversize / malformed uploads.
      return reply.code(413).send({ error: (err as Error).message });
    }
    if (!part) {
      return reply.code(400).send({ error: "no audio file in request" });
    }
    let audio: Buffer;
    try {
      audio = await part.toBuffer();
    } catch (err) {
      // Size-limit overruns surface here too (streamed past the cap).
      return reply.code(413).send({ error: (err as Error).message });
    }
    try {
      const result = await transcriber.transcribe({
        audio,
        filename: part.filename || "dictation.webm",
        mimeType: part.mimetype || "audio/webm",
      });
      return {
        text: result.text,
        model: result.model,
        mode: result.mode,
        durationMs: result.durationMs,
      };
    } catch (err) {
      const status = err instanceof TranscriptionError ? err.status : 502;
      req.log.warn({ err }, "transcription failed");
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  // --- identity ----------------------------------------------------------
  // The authenticated principal for this request (#189). In `none` mode this is
  // the frozen anonymous principal (`{ username: "anonymous", anonymous: true }`);
  // in trusted-header / jwt modes it's the real proxy/IdP identity. The web app
  // uses it to surface who it is and to know whether read-state is user-keyed.
  app.get("/api/me", async (req) => req.user);

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
  // `keeperDriveModeDefault` is the box-wide `PADDOCK_KEEPER_DRIVE_MODE` (per
  // instance, not static): the Settings tab shows it as the effective value a
  // project inherits when its own `driveMode` is left on "Global default".
  app.get("/api/models", async () => {
    return {
      models: MODELS,
      keeperDefault: KEEPER_DEFAULT_MODEL,
      sweeperDefault: SWEEPER_DEFAULT_MODEL,
      keeperDriveModeDefault: cfg.keeperDriveMode,
      // Box-wide max spawn depth (PADDOCK_MAX_SPAWN_DEPTH) a project inherits when
      // its own `maxSpawnDepth` is unset; shown as the effective value in Settings
      // and used to label "Instance default" (issue #262).
      maxSpawnDepthDefault: cfg.maxSpawnDepth,
    };
  });

  // Slash commands for one-off (scratch) chats — the scratch agent's equivalent
  // of GET /api/projects/:slug/commands (issue #103). Same cached wrapper.
  app.get("/api/commands", async (_req, reply) => {
    try {
      const commands = await herdctl.listCommands(SCRATCH_AGENT);
      return { commands };
    } catch (err) {
      reply.code(503);
      return { commands: [], error: (err as Error).message };
    }
  });

  app.get("/api/fleet", async () => {
    try {
      return { status: await herdctl.fleetStatus(), agents: await herdctl.agents() };
    } catch (err) {
      return { status: null, agents: [], error: (err as Error).message };
    }
  });

  // --- projects ----------------------------------------------------------

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
      const user = readStateUser(req);
      const lastSeenOf = (s: import("@herdctl/core").DiscoveredSession) =>
        readState.getLastSeen(user, keeper, s.sessionId);
      // Provenance badge (#267): how each chat was created — human / scheduled /
      // spawned (A1's #261 marker). A cheap in-memory map read, so unlike the
      // usage ring (#116) it's fine to resolve inline for the initial payload.
      const provenanceOf = (s: import("@herdctl/core").DiscoveredSession) =>
        runProvenance.get(s.sessionId);
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
        await herdctl.removeProjectAgent(project.slug, Object.keys(project.hooks ?? {}));
      } catch (err) {
        req.log.warn({ err }, "keeper-agent unregister failed (project dir already removed)");
      }
      return reply.code(200).send({ ok: true, slug: project.slug });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // --- schedules (issue #266 / D4) ---------------------------------------
  // The per-project scheduled-chat management surface the Settings pane drives.
  // The schedule DEFINITION is declared in project.yaml (herdctl's `ScheduleSchema`
  // shape, D3) — its persistence half is `ProjectStore.set/removeSchedule`; the
  // RUNTIME arming half is `HerdctlService.set/removeAgentSchedule` (herdctl#376),
  // behind the per-deployment `scheduleMutationEnabled` gate. Each mutating route
  // persists to project.yaml FIRST (the source of truth — it re-arms on restart),
  // then arms herdctl, warning-but-not-failing if the runtime arm hiccups.

  /**
   * Merge a project.yaml schedule declaration with herdctl's live runtime state
   * (status / last / next run) into the DTO the Settings pane renders. `info` is
   * absent for a just-declared schedule herdctl hasn't armed yet (or when the
   * keeper isn't running) — then status falls back to the declared `enabled`.
   */
  const toScheduleDto = (
    name: string,
    rec: PaddockSchedule,
    info?: ScheduleRuntimeInfo,
  ) => ({
    name,
    type: rec.type,
    cron: rec.cron ?? null,
    interval: rec.interval ?? null,
    prompt: rec.prompt ?? null,
    promptFile: rec.promptFile ?? null,
    resumeSession: rec.resume_session === true,
    enabled: rec.enabled !== false,
    status: info?.status ?? (rec.enabled === false ? "disabled" : "idle"),
    lastRunAt: info?.lastRunAt ?? null,
    nextRunAt: info?.nextRunAt ?? null,
    lastError: info?.lastError ?? null,
  });

  // List a project's schedules (declaration + live runtime state), plus the
  // per-deployment mutation gate so the pane can render read-only with a hint.
  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/schedules",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug); // throws not_found
        const declared = project.schedules ?? {};
        const runtime = await herdctl.listAgentSchedules(project).catch(() => []);
        const byName = new Map(runtime.map((s) => [s.name, s]));
        const schedules = Object.entries(declared).map(([name, rec]) =>
          toScheduleDto(name, rec, byName.get(name)),
        );
        return { schedules, mutationEnabled: cfg.scheduleMutationEnabled };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Create or replace one schedule (keyed by name). Persists to project.yaml, then
  // arms herdctl at runtime via the granular setAgentSchedule (no stale-leaving
  // whole-agent replace). 403 when the deployment hasn't opted into mutation.
  app.put<{ Params: { slug: string; name: string }; Body: unknown }>(
    "/api/projects/:slug/schedules/:name",
    async (req, reply) => {
      if (!cfg.scheduleMutationEnabled) return sendMutationDisabled(reply);
      const { slug, name } = req.params;
      if (!isValidScheduleName(name)) {
        return reply.code(400).send({ error: `Invalid schedule name: ${name}`, code: "invalid" });
      }
      const clean = sanitizeSchedule(req.body);
      if (!clean) {
        return reply.code(400).send({ error: "Invalid schedule definition", code: "invalid" });
      }
      try {
        const project = await projects.setSchedule(slug, name, clean); // throws not_found/invalid
        try {
          await herdctl.setAgentSchedule(project, name, scheduleToHerdctl(clean));
        } catch (err) {
          req.log.warn({ err }, "runtime setAgentSchedule failed — armed on next restart");
        }
        return { schedule: toScheduleDto(name, clean), mutationEnabled: true };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Delete one schedule. Removes it from project.yaml AND prunes herdctl's armed
  // copy + persisted state (so a re-added name doesn't inherit stale last-run).
  app.delete<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/schedules/:name",
    async (req, reply) => {
      if (!cfg.scheduleMutationEnabled) return sendMutationDisabled(reply);
      const { slug, name } = req.params;
      try {
        const project = await projects.removeSchedule(slug, name); // throws not_found
        try {
          await herdctl.removeAgentSchedule(project, name);
        } catch (err) {
          req.log.warn({ err }, "runtime removeAgentSchedule failed");
        }
        return reply.code(200).send({ ok: true, name });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Enable/disable one schedule. Flips herdctl's persisted enable-state (which is
  // read, not config, so it wins over the armed copy) AND persists `enabled` back
  // to project.yaml for restart parity. `:action` is `enable` | `disable`.
  app.post<{ Params: { slug: string; name: string; action: string } }>(
    "/api/projects/:slug/schedules/:name/:action(enable|disable)",
    async (req, reply) => {
      if (!cfg.scheduleMutationEnabled) return sendMutationDisabled(reply);
      const { slug, name, action } = req.params;
      const enable = action === "enable";
      try {
        const project = await projects.get(slug); // throws not_found
        const rec = project.schedules?.[name];
        if (!rec) {
          return reply.code(404).send({ error: `No such schedule: ${name}`, code: "not_found" });
        }
        // Persist the flag to project.yaml (round-trips on restart) …
        const updated = await projects.setSchedule(slug, name, { ...rec, enabled: enable });
        // … and flip herdctl's persisted runtime state so it takes effect now.
        let info: ScheduleRuntimeInfo | undefined;
        try {
          info = enable
            ? await herdctl.enableSchedule(project, name)
            : await herdctl.disableSchedule(project, name);
        } catch (err) {
          req.log.warn({ err }, `runtime ${action}Schedule failed — applied on next restart`);
        }
        const nextRec = updated.schedules?.[name] ?? { ...rec, enabled: enable };
        return { schedule: toScheduleDto(name, nextRec, info), mutationEnabled: true };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Trigger a schedule NOW — runs it through the same hub path a cron fire uses,
  // so the resulting chat is a first-class, discoverable, `scheduled`-badged run
  // (E1/#267). Allowed regardless of the mutation gate: it runs an already-declared
  // schedule, it doesn't change the schedule set. `enabled: false` still fires (a
  // manual trigger is deliberate — DD-1). Responds 202 with the started session id.
  app.post<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/schedules/:name/trigger",
    async (req, reply) => {
      const { slug, name } = req.params;
      try {
        const project = await projects.get(slug); // throws not_found
        if (!project.schedules?.[name]) {
          return reply.code(404).send({ error: `No such schedule: ${name}`, code: "not_found" });
        }
        const sessionId = await fireSchedule(slug, name);
        if (!sessionId) {
          return reply
            .code(502)
            .send({ error: "Schedule fire did not start a chat", code: "trigger_failed" });
        }
        return reply.code(202).send({ ok: true, name, sessionId });
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

  // Serve the RAW BYTES of a file the agent shared via `mcp__paddock__send_file`
  // (issue #112). The bytes were copied into the attachment store AT SEND TIME
  // and are addressed by an opaque id recorded in the chat transcript, so this
  // endpoint only ever serves files that were explicitly sent — never an
  // arbitrary path on the box. Used by the chat's image <img> and by the text
  // fetch for file-kind sends, live and after reload. Locked down with the same
  // nosniff + sandbox CSP as the project file raw endpoint.
  //
  // HTTP byte-range support (issue #126) is what makes an inline <video> play,
  // especially on iOS Safari: it sends a `Range:` request and REFUSES to play if
  // the server answers `200` with the whole body instead of `206 Partial Content`.
  // So we always advertise `Accept-Ranges: bytes` and honor a `Range` header.
  //
  // CSP: the `sandbox` token is right for a directly-opened image/HTML/SVG (it
  // stops a hostile file executing script in our origin), but it is meaningless
  // for a media subresource and we keep it OFF for video/PDF so nothing can
  // interfere with playback — those get a plain `default-src 'none'`. Everything
  // else keeps the byte-for-byte `sandbox; default-src 'none'` as before.
  app.get<{ Params: { id: string } }>("/api/chat-files/:id", async (req, reply) => {
    const found = await attachments.read(req.params.id);
    if (!found) return reply.code(404).send({ error: "not_found" });
    const { bytes, mime } = found;
    const total = bytes.length;
    const csp = cspFor(mime);

    reply
      .header("content-type", mime)
      .header("content-disposition", "inline")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", csp)
      .header("cache-control", "private, max-age=300")
      .header("accept-ranges", "bytes");

    const range = parseRangeHeader(req.headers.range, total);
    if (range === "unsatisfiable") {
      // Malformed / out-of-bounds range → 416 with the resource's full size.
      return reply.code(416).header("content-range", `bytes */${total}`).send();
    }
    if (range) {
      const { start, end } = range;
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${total}`)
        .header("content-length", String(end - start + 1))
        .send(bytes.subarray(start, end + 1));
    }
    // No (or unhandled) Range header → full body, 200.
    return reply.send(bytes);
  });

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
      const [sessions, lastTurnAt] = await Promise.all([
        herdctl.listSessions(project).catch(() => []),
        herdctl.lastTurnCompletedAt().catch(() => new Map<string, string>()),
      ]);
      const keeper = keeperAgentName(project.slug);
      const archivedOf = (s: import("@herdctl/core").DiscoveredSession) =>
        archive.isArchived(keeper, s.sessionId);
      const user = readStateUser(req);
      const lastSeenOf = (s: import("@herdctl/core").DiscoveredSession) =>
        readState.getLastSeen(user, keeper, s.sessionId);
      const provenanceOf = (s: import("@herdctl/core").DiscoveredSession) =>
        runProvenance.get(s.sessionId);
      // No usage resolver — see the GET /api/projects/:slug route (issue #116).
      // Usage rings are fetched separately so a list refresh stays cheap.
      return {
        chats: await buildProjectChats(
          project.dir,
          sessions,
          undefined,
          archivedOf,
          lastTurnAt,
          lastSeenOf,
          provenanceOf,
        ),
      };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // --- run history: "while you were away" (E3 / #268 / DD-6) ------------------
  // A project-level view of what ran unattended (scheduled + spawned) plus human
  // runs, sourced from herdctl job records (listProjectRuns) joined with the A1
  // provenance marker (#261) for true origin/depth. Cost is a P3 seam (null).
  //
  // The since-last-visit digest reuses the read-state watermark (#189): a per-
  // user "runs last seen" epoch keyed under the keeper agent with the reserved
  // sentinel session id below (a plain UUID can't contain "__", so it can never
  // alias a real chat's read-state).
  app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    "/api/projects/:slug/runs",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const keeper = keeperAgentName(project.slug);
        const limit = clampRunsLimit(req.query.limit);
        const [jobs, lastSeen] = await Promise.all([
          herdctl.listProjectRuns(project, limit).catch(() => []),
          readState
            .getLastSeen(readStateUser(req), keeper, RUNS_SEEN_SESSION)
            .catch(() => 0),
        ]);
        // Resolve provenance for each DISTINCT session referenced by a run — a
        // cheap in-memory map read per id (RunProvenanceStore is lazy-loaded once).
        const sessionIds = [
          ...new Set(jobs.map((j) => j.session_id).filter((s): s is string => !!s)),
        ];
        const provBySession = new Map<string, RunProvenance>();
        await Promise.all(
          sessionIds.map(async (sid) => {
            const p = await runProvenance.get(sid).catch(() => undefined);
            if (p) provBySession.set(sid, p);
          }),
        );
        return buildProjectRuns(jobs, provBySession, lastSeen);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Advance the per-user "runs last seen" watermark (clears the since-last-visit
  // digest). Mirrors the chat-seen endpoint: optional `{ when }`, defaults to now,
  // monotonic in the store (an older `when` is a no-op).
  app.post<{ Params: { slug: string }; Body: { when?: number } }>(
    "/api/projects/:slug/runs/seen",
    async (req, reply) => {
      try {
        const keeper = await agentForSlug(req.params.slug);
        const when =
          typeof req.body?.when === "number" && Number.isFinite(req.body.when)
            ? req.body.when
            : Date.now();
        await readState.setLastSeen(readStateUser(req), keeper, RUNS_SEEN_SESSION, when);
        return reply.code(200).send({ ok: true, lastSeen: when });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Bulk context-window usage for ALL of a project's chats, keyed by session id
  // (issue #116). This is the expensive part the chat list needs for its per-chat
  // usage rings (issue #77) — each session's fill is read by streaming its
  // transcript (memoized on transcript mtime). Split out of the project-detail
  // and chat-list payloads so the ProjectView renders immediately and the client
  // fills rings in progressively. Sessions with no usage data are omitted.
  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/chats/usage",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const sessions = await herdctl.listSessions(project).catch(() => []);
        const usageOf = chatUsageResolver(project.dir, project.model ?? KEEPER_DEFAULT_MODEL);
        const entries = await Promise.all(
          sessions.map(async (s) => {
            const u = await usageOf(s).catch(() => null);
            return u ? ([s.sessionId, u] as const) : null;
          }),
        );
        const usage: Record<string, ChatUsage> = {};
        for (const e of entries) if (e) usage[e[0]] = e[1];
        return { usage };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

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
        const projectDir = await projectDirForSlug(req.params.slug);
        const messages = await herdctl
          .sessionMessages(agent, req.params.sessionId)
          .catch(() => []);
        const enriched = await enrichWithToolDetails(projectDir, req.params.sessionId, messages);
        // Per-message provenance (issue #290): attribute machine-injected turns to
        // their sender (chat / schedule) by joining the ordered injection markers.
        // Human-typed turns match no marker and stay unlabelled (the default).
        const markers = await messageProvenance.list(req.params.sessionId).catch(() => []);
        return { messages: applyMessageProvenance(enriched, markers) };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Step-by-step transcript of a sub-agent launched from a Task/Agent tool block
  // within a project chat (issue #37). `toolUseId` is the parent tool_use id
  // carried on the enriched tool call; it resolves to the sub-agent's own
  // transcript under `.chats/<sessionId>/subagents/`.
  app.get<{ Params: { slug: string; sessionId: string; toolUseId: string } }>(
    "/api/projects/:slug/chats/:sessionId/subagents/:toolUseId/messages",
    async (req, reply) => {
      try {
        const projectDir = await projectDirForSlug(req.params.slug);
        const messages = await readSubagentMessages(
          projectDir,
          req.params.sessionId,
          req.params.toolUseId,
        );
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
        const projectDir = await projectDirForSlug(req.params.slug);
        let model = KEEPER_DEFAULT_MODEL;
        if (req.params.slug !== SCRATCH_SLUG) {
          const p = await projects.get(req.params.slug).catch(() => null);
          if (p?.model) model = p.model;
        }
        const u = await readSessionTokenUsageWithSubagents(projectDir, req.params.sessionId).catch(
          () => null,
        );
        return { usage: u ? toChatUsage(u, model) : null };
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
        await cleanupAttachments(agent, req.params.sessionId);
        const removed = await herdctl.deleteSession(agent, req.params.sessionId);
        // Drop any archived flag so a future session id can't inherit it.
        await archive.setArchived(agent, req.params.sessionId, false).catch(() => undefined);
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

  // Fork a project chat: eagerly duplicate its transcript into a NEW session in
  // the same project (leaving the source untouched) so the fork exists right
  // away — a real, resumable chat with the parent's full history — rather than
  // being created lazily on a first message. Optional `name` sets its title
  // (e.g. "Fork of <parent>"). Returns the new session id.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { name?: string } }>(
    "/api/projects/:slug/chats/:sessionId/fork",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const newId = await herdctl.forkSession(project, req.params.sessionId, req.body?.name);
        return reply.code(201).send({ sessionId: newId });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Archive (or unarchive) a project chat (#95). A non-destructive toggle on a
  // persisted per-chat flag — the transcript is untouched and the chat stays
  // openable/resumable/forkable; it just moves into the Archived section.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { archived?: boolean } }>(
    "/api/projects/:slug/chats/:sessionId/archive",
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const archived = req.body?.archived !== false; // default true
        const changed = await archive.setArchived(agent, req.params.sessionId, archived);
        // Epic G / G1: after the archive COMMITS, emit `onArchive` (only on a real
        // transition into archived) so the hook dispatcher fires the project's enabled
        // onArchive hooks. Fire-and-forget — never blocks/fails the archive response.
        if (changed && archived) {
          events?.emit("onArchive", { slug: req.params.slug, sessionId: req.params.sessionId });
        }
        return reply.code(200).send({ ok: true, archived });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Mark a project chat SEEN (#189): persist the user's last-viewed moment for
  // this chat server-side (keyed by user when present, else a shared bucket), so
  // the unread affordance (#160/#161) follows the user across devices. Body's
  // optional `when` (epoch-ms) lets the client pass its own timestamp; defaults
  // to now. Mirrors the archive toggle's shape/validation. Monotonic in the
  // store (an older `when` is a no-op), so it never resurrects a stale unread.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { when?: number } }>(
    "/api/projects/:slug/chats/:sessionId/seen",
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const when =
          typeof req.body?.when === "number" && Number.isFinite(req.body.when)
            ? req.body.when
            : Date.now();
        await readState.setLastSeen(readStateUser(req), agent, req.params.sessionId, when);
        return reply.code(200).send({ ok: true, lastSeen: when });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // One-off chats (scratch dir). Scratch chats never get context preload, so
  // their previews are never polluted — no wrapper stripping needed.
  app.get("/api/chats", async (req) => {
    const sessions = await herdctl.listScratchSessions().catch(() => []);
    const usageOf = chatUsageResolver(herdctl.scratchDir, KEEPER_DEFAULT_MODEL);
    const user = readStateUser(req);
    return {
      chats: await Promise.all(
        sessions.map(async (s) =>
          toChatDto(
            s,
            undefined,
            await usageOf(s),
            await archive.isArchived(SCRATCH_AGENT, s.sessionId).catch(() => false),
            undefined,
            await readState.getLastSeen(user, SCRATCH_AGENT, s.sessionId).catch(() => 0),
            await runProvenance.get(s.sessionId).catch(() => null),
          ),
        ),
      ),
    };
  });

  // Messages of a one-off (scratch) chat.
  app.get<{ Params: { sessionId: string } }>(
    "/api/chats/:sessionId/messages",
    async (req) => {
      const messages = await herdctl
        .sessionMessages(SCRATCH_AGENT, req.params.sessionId)
        .catch(() => []);
      return {
        messages: await enrichWithToolDetails(
          herdctl.scratchDir,
          req.params.sessionId,
          messages,
        ),
      };
    },
  );

  // Sub-agent transcript within a one-off (scratch) chat (issue #37).
  app.get<{ Params: { sessionId: string; toolUseId: string } }>(
    "/api/chats/:sessionId/subagents/:toolUseId/messages",
    async (req) => {
      const messages = await readSubagentMessages(
        herdctl.scratchDir,
        req.params.sessionId,
        req.params.toolUseId,
      );
      return { messages };
    },
  );

  // Context-window usage for a one-off (scratch) chat (see the project variant).
  app.get<{ Params: { sessionId: string } }>("/api/chats/:sessionId/context", async (req) => {
    const u = await readSessionTokenUsageWithSubagents(
      herdctl.scratchDir,
      req.params.sessionId,
    ).catch(() => null);
    return { usage: u ? toChatUsage(u, KEEPER_DEFAULT_MODEL) : null };
  });

  // Delete a one-off (scratch) chat.
  app.delete<{ Params: { sessionId: string } }>(
    "/api/chats/:sessionId",
    async (req, reply) => {
      try {
        await cleanupAttachments(SCRATCH_AGENT, req.params.sessionId);
        const removed = await herdctl.deleteSession(SCRATCH_AGENT, req.params.sessionId);
        await archive.setArchived(SCRATCH_AGENT, req.params.sessionId, false).catch(() => undefined);
        return reply.code(200).send({ ok: true, removed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Archive (or unarchive) a one-off (scratch) chat (#95). Same non-destructive
  // toggle as the project variant.
  app.post<{ Params: { sessionId: string }; Body: { archived?: boolean } }>(
    "/api/chats/:sessionId/archive",
    async (req, reply) => {
      try {
        const archived = req.body?.archived !== false; // default true
        await archive.setArchived(SCRATCH_AGENT, req.params.sessionId, archived);
        return reply.code(200).send({ ok: true, archived });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Mark a one-off (scratch) chat SEEN (#189). Same as the project variant.
  app.post<{ Params: { sessionId: string }; Body: { when?: number } }>(
    "/api/chats/:sessionId/seen",
    async (req, reply) => {
      try {
        const when =
          typeof req.body?.when === "number" && Number.isFinite(req.body.when)
            ? req.body.when
            : Date.now();
        await readState.setLastSeen(readStateUser(req), SCRATCH_AGENT, req.params.sessionId, when);
        return reply.code(200).send({ ok: true, lastSeen: when });
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

  /**
   * A per-session usage lookup for building a chat list's usage rings (issue
   * #77) + cumulative token/cost figures (issue #152, incl. sub-agents #242):
   * reads each session's transcript plus its sub-agent transcripts (both memoized
   * on mtime) and pairs the parsed totals with the model. Returns null for a
   * session with no usage data yet — the ring simply hides. Keyed on `projectDir`
   * (not the agent name) because paddock resolves transcripts directly under
   * `<projectDir>/.chats/`.
   */
  function chatUsageResolver(projectDir: string, model: string) {
    return async (
      s: import("@herdctl/core").DiscoveredSession,
    ): Promise<ChatUsage | null> => {
      const u = await readSessionTokenUsageWithSubagents(projectDir, s.sessionId).catch(
        () => null,
      );
      return u ? toChatUsage(u, model) : null;
    };
  }

  /**
   * Remove the attachments a chat referenced, before its transcript is deleted
   * (we read the transcript to find the ids). Best-effort — a failure here must
   * never block the chat delete.
   */
  async function cleanupAttachments(agent: string, sessionId: string): Promise<void> {
    try {
      const messages = await herdctl.sessionMessages(agent, sessionId);
      await attachments.remove(collectAttachmentIds(messages));
    } catch {
      /* best-effort: orphaned attachment files are harmless */
    }
  }

  /** Resolve a slug to the agent name whose sessions back it. */
  async function agentForSlug(slug: string): Promise<string> {
    if (slug === SCRATCH_SLUG) return SCRATCH_AGENT;
    await projects.get(slug); // throws not_found for unknown slug
    return keeperAgentName(slug);
  }

  /** Resolve a slug to the on-disk project directory holding its `.chats/`. */
  async function projectDirForSlug(slug: string): Promise<string> {
    if (slug === SCRATCH_SLUG) return herdctl.scratchDir;
    return (await projects.get(slug)).dir;
  }
}

/**
 * A chat's usage for the UI: the last-turn context fill (issue #77) plus the
 * chat's cumulative lifetime token totals and a ballpark dollar estimate at API
 * rates (issue #152). The cumulative totals and `costUsd` include every sub-agent
 * the chat spawned (issue #242); `contextTokens` stays main-only (last-turn
 * window fill). `costUsd` is null for a model with no known pricing.
 */
type ChatUsage = {
  contextTokens: number;
  contextLimit: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

/**
 * Build the wire `ChatUsage` from a parsed {@link SessionTokenUsage} and the
 * chat's model. Returns null when the transcript has no usage yet, so the ring
 * simply hides. `totalTokens` is a headline "tokens this chat consumed" figure —
 * output plus the (context-growing) input/cache reads — while `costUsd` prices
 * each class separately (see {@link estimateCostUsd}).
 */
function toChatUsage(u: SessionTokenUsage, model: string): ChatUsage | null {
  if (!u.hasData) return null;
  const totals = {
    inputTokens: u.inputTotal,
    outputTokens: u.outputTotal,
    cacheReadTokens: u.cacheReadTotal,
    cacheCreationTokens: u.cacheCreationTotal,
  };
  return {
    contextTokens: u.contextTokens,
    contextLimit: getContextLimit(model),
    ...totals,
    totalTokens:
      u.inputTotal + u.outputTotal + u.cacheReadTotal + u.cacheCreationTotal,
    // Price per the model each turn actually ran on (u.byModel), not the passed
    // project/chat default — a chat's turns can span models, so a single blended
    // rate misprices (a Haiku chat billed at the Opus default would be 5× high).
    costUsd: estimateCostUsdByModel(u.byModel),
  };
}

function toChatDto(
  s: import("@herdctl/core").DiscoveredSession,
  previewOverride?: string,
  usage?: ChatUsage | null,
  archived = false,
  lastTurnCompletedAt?: string,
  lastSeen?: number,
  provenance?: RunProvenance | null,
) {
  const preview = previewOverride ?? s.preview;
  return {
    sessionId: s.sessionId,
    workingDirectory: s.workingDirectory,
    name: s.customName ?? s.autoName ?? preview ?? s.sessionId.slice(0, 8),
    updatedAt: s.mtime,
    resumable: s.resumable,
    preview,
    // Whether this chat is filed away in the Archived section (#95). Always
    // present so the client can partition the list without a fallback.
    archived,
    // ISO timestamp of the last turn the agent FINISHED (from job records, not
    // mtime) — the unread signal (#160). Absent when no completed job record
    // exists yet (session-mode chats, or a brand-new chat still on turn 1).
    ...(lastTurnCompletedAt ? { lastTurnCompletedAt } : {}),
    // Epoch-ms the user last viewed this chat (server-side read-state, #189) —
    // the source of truth for the unread affordance, so it follows the user
    // across devices. 0/absent means never seen on this instance.
    ...(lastSeen ? { lastSeen } : {}),
    // The context-window fill as of the session's last completed turn (for the
    // per-chat usage ring) plus the chat's cumulative token totals and cost
    // estimate (issue #152), so the list can render both without opening the
    // chat. Only present when the transcript has usage data.
    ...(usage ?? {}),
    // How this chat was created (#267): A1's provenance marker (#261) — origin
    // (human / scheduled / spawned) + spawn depth — so the list can badge the
    // "ran without me" cases. Absent when no marker was recorded (older chats,
    // or ones created before A1). Human origin renders no badge (the default).
    ...(provenance ? { provenance } : {}),
  };
}

/** Claude Code's own preview cap (mirrors extractFirstMessagePreview). */
const PREVIEW_MAX = 100;

/**
 * Reserved read-state session id for the per-project, per-user "runs last seen"
 * watermark (the since-last-visit digest, #268). A real Claude Code session id is
 * a UUID (`/^[0-9a-f-]+$/`), so the double-underscore sentinel can never collide
 * with one — the watermark keys cleanly alongside per-chat read-state.
 */
const RUNS_SEEN_SESSION = "__runs__";

/** Default + cap for the run-history page size. */
const RUNS_LIMIT_DEFAULT = 100;
const RUNS_LIMIT_MAX = 500;

/** Parse + clamp the `?limit=` query for the run-history endpoint. */
function clampRunsLimit(raw: string | undefined): number {
  const n = raw === undefined ? RUNS_LIMIT_DEFAULT : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return RUNS_LIMIT_DEFAULT;
  return Math.min(n, RUNS_LIMIT_MAX);
}

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
  usageOf?: (
    s: import("@herdctl/core").DiscoveredSession,
  ) => Promise<ChatUsage | null>,
  archivedOf?: (
    s: import("@herdctl/core").DiscoveredSession,
  ) => Promise<boolean>,
  lastTurnAt?: ReadonlyMap<string, string>,
  lastSeenOf?: (
    s: import("@herdctl/core").DiscoveredSession,
  ) => Promise<number>,
  provenanceOf?: (
    s: import("@herdctl/core").DiscoveredSession,
  ) => Promise<RunProvenance | undefined>,
) {
  return Promise.all(
    sessions.map(async (s) => {
      // Resolve the usage ring, archived flag, read-state, provenance, and name.
      const usage = usageOf ? await usageOf(s).catch(() => null) : null;
      const archived = archivedOf ? await archivedOf(s).catch(() => false) : false;
      const turnAt = lastTurnAt?.get(s.sessionId);
      const lastSeen = lastSeenOf ? await lastSeenOf(s).catch(() => 0) : 0;
      const provenance = provenanceOf ? await provenanceOf(s).catch(() => null) : null;
      const pollutedPreview =
        !s.customName && !s.autoName && s.preview?.startsWith(PRELOAD_CONTEXT_OPEN);
      if (!pollutedPreview)
        return toChatDto(s, undefined, usage, archived, turnAt, lastSeen, provenance);

      const full = await readFirstUserText(projectDir, s.sessionId).catch(() => undefined);
      const cleaned = stripPreloadWrapper(full ?? s.preview ?? "").trim();
      // couldn't recover
      if (!cleaned) return toChatDto(s, undefined, usage, archived, turnAt, lastSeen, provenance);
      const preview =
        cleaned.length > PREVIEW_MAX ? `${cleaned.slice(0, PREVIEW_MAX)}...` : cleaned;
      return toChatDto(s, preview, usage, archived, turnAt, lastSeen, provenance);
    }),
  );
}

/**
 * The Content-Security-Policy to serve a chat attachment with, chosen from its
 * MIME type (issue #126). A media/PDF subresource gets a bare `default-src
 * 'none'` (the `sandbox` token does nothing useful for it and we don't want it
 * anywhere near `<video>` playback); everything else keeps the locked-down
 * `sandbox; default-src 'none'` that guards a directly-opened image/HTML/SVG.
 */
function cspFor(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base.startsWith("video/") || base === "application/pdf") return "default-src 'none'";
  return "sandbox; default-src 'none'";
}

/**
 * Parse an HTTP `Range` header against a known total size (issue #126). Supports
 * the single-range forms `bytes=start-`, `bytes=start-end`, and the suffix
 * `bytes=-N` (last N bytes). Returns the resolved `{ start, end }` (inclusive),
 * `"unsatisfiable"` for a malformed/out-of-bounds range (→ 416), or `null` when
 * there is no range to honor (→ serve the full body, 200).
 */
export function parseRangeHeader(
  header: string | undefined,
  total: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or a form we don't handle → fall back to 200
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix form `bytes=-N`: the last N bytes.
    const n = Number(endStr);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? total - 1 : Math.min(Number(endStr), total - 1);
  }
  if (start > end || start >= total) return "unsatisfiable";
  return { start, end };
}

/**
 * The slice of herdctl's `ScheduleInfo` the schedules DTO surfaces (issue #266 /
 * D4): live runtime state herdctl tracks for an armed schedule. Kept as a local
 * structural type so routes don't depend on `@herdctl/core`'s import surface.
 */
interface ScheduleRuntimeInfo {
  status: "idle" | "running" | "disabled";
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
}

/**
 * 403 for a schedule-mutation route when the deployment hasn't opted into
 * programmatic schedule mutation (`PADDOCK_SCHEDULE_MUTATION` off, DD-7). The pane
 * renders read-only in this case; this guards the API directly too.
 */
function sendMutationDisabled(reply: import("fastify").FastifyReply) {
  return reply.code(403).send({
    error: "Schedule mutation is disabled on this deployment",
    code: "schedule_mutation_disabled",
  });
}

function sendProjectError(reply: import("fastify").FastifyReply, err: unknown) {
  if (err instanceof ProjectError) {
    const code =
      err.code === "not_found"
        ? 404
        : err.code === "exists" || err.code === "not_directory"
          ? 409
          : 400;
    return reply.code(code).send({ error: err.message, code: err.code });
  }
  reply.log.error({ err }, "route error");
  return reply.code(500).send({ error: (err as Error).message ?? "internal error" });
}
