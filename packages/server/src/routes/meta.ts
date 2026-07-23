/**
 * Instance/identity/metadata routes + the attachment byte surface: voice
 * transcription, `/api/me`, health, `/api/models`, `/api/fleet`, scratch-chat
 * slash commands, instance-wide settings (issue #385), the inbound composer
 * upload (#328), and the range-serving `/api/chat-files/:id` endpoint (#112/#126).
 */
import type { FastifyInstance } from "fastify";
import { SCRATCH_AGENT } from "../herdctl.js";
import {
  resolveAttachmentsConfig,
  maxFileBytes,
  isTypeAllowed,
} from "../attachments-config.js";
import { inferAttachmentKind } from "../attachments-hint.js";
import {
  buildInstanceConfig,
  writeInstanceConfig,
  validatePatch,
  instanceConfigPath,
  InstanceConfigError,
} from "../instance-config.js";
import { TranscriptionError } from "../transcribe.js";
import {
  MODELS,
  KEEPER_DEFAULT_MODEL,
  SWEEPER_DEFAULT_MODEL,
} from "../models.js";
import { sendProjectError } from "../route-errors.js";
import { cspFor, parseRangeHeader } from "../http-bytes.js";
import { type RouteCtx, type MultipartRequest, type UploadedFile } from "../route-context.js";

export function registerMetaRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { herdctl, transcriber, attachments, projects, cfg } = ctx;

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

  app.get("/api/health", async () => ({ ok: true }));

  // --- instance-wide settings (issue #385) --------------------------------
  // A top-level admin screen over the frozen instance config. GET reports every
  // surfaced field (value / default / editable / sensitive / env-shadow); PUT
  // writes the editable subset to paddock.config.yaml (comment-preserving,
  // atomic). Writes DO NOT hot-apply — the config is read once at boot and
  // frozen — so a PUT returns `restartRequired: true` and the process keeps its
  // current config until it restarts. This route mutates instance-wide config;
  // it inherits whatever request-boundary auth the deployment configures (open
  // in `none` mode, gated behind the proxy/IdP otherwise) — a role model is a
  // follow-up per the ticket.
  app.get("/api/instance-config", async () => buildInstanceConfig(cfg));

  app.put<{ Body: { patch?: Record<string, unknown> } }>(
    "/api/instance-config",
    async (req, reply) => {
      const patch = req.body?.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return reply.code(400).send({ error: "body must be { patch: { <field>: <value> } }" });
      }
      let pairs: { key: string; value: unknown }[];
      try {
        pairs = validatePatch(patch);
      } catch (err) {
        if (err instanceof InstanceConfigError) {
          return reply.code(400).send({ error: err.message, field: err.field });
        }
        throw err;
      }
      try {
        writeInstanceConfig(instanceConfigPath(cfg), pairs);
      } catch (err) {
        return reply.code(500).send({ error: `failed to write config file: ${(err as Error).message}` });
      }
      // The write lands in the file but NOT in the running (frozen) config.
      return { restartRequired: true, configPath: instanceConfigPath(cfg) };
    },
  );

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
      // Box-wide keeper-chat recovery defaults (PADDOCK_RECOVERY_*) a project
      // inherits when its own `recovery` override fields are unset (issue #301).
      // The web resolves the effective value (project.recovery[field] ?? this) to
      // gate the killed-task Continue affordance.
      recoveryDefault: cfg.recovery,
      // Box-wide inbound-attachment defaults (PADDOCK_ATTACHMENTS_*) a project
      // inherits when its own `attachments` override fields are unset (issue #328).
      // The composer resolves the effective value (project.attachments[field] ??
      // this) to gate the picker + build the client-side accept/size guards.
      attachmentsDefault: cfg.attachments,
      // Box-wide sweeper-curation budgets (PADDOCK_CURATION_*) a project inherits
      // when its own `curation` override fields are unset (issue #384). Settings
      // shows these as the "Instance default" for each per-file token budget.
      curationDefault: cfg.curation,
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

  // Inbound composer upload (issue #328 Phase 1). Copies each posted file's bytes
  // into the attachment store (reusing the send_file store) and returns opaque
  // ids the composer holds until send. The stored file DOUBLES as the on-disk copy
  // the keeper's `Read` tool opens (via the absolute path threaded into the send
  // prompt) AND the durable copy the transcript re-renders from (`/api/chat-files/:id`).
  //
  // Validation is SERVER-AUTHORITATIVE (the client mirrors it only for UX): the
  // effective per-project config gates enabled/size/count/type. `:sessionId` is
  // accepted for a not-yet-created chat too (a new chat has no id until its first
  // frame) — storage is flat and doesn't need it; it only scopes the request.
  app.post<{ Params: { slug: string; sessionId: string } }>(
    "/api/projects/:slug/chats/:sessionId/upload",
    async (req, reply) => {
      let project;
      try {
        project = await projects.get(req.params.slug);
      } catch (err) {
        return sendProjectError(reply, err);
      }
      const acfg = resolveAttachmentsConfig(project.attachments, cfg.attachments);
      if (!acfg.enabled) {
        return reply.code(403).send({ error: "attachments are disabled for this project" });
      }
      const maxBytes = maxFileBytes(acfg);
      // Buffer + validate every part first; persist NOTHING until all pass, so a
      // rejected file leaves the store untouched (atomic — the client's tray and
      // the store never disagree). Memory is bounded by the size × count caps.
      const collected: { filename: string; mimetype?: string; bytes: Buffer }[] = [];
      try {
        const parts = (req as MultipartRequest).parts({
          limits: { fileSize: maxBytes, files: acfg.maxFilesPerMessage },
        });
        for await (const part of parts) {
          if (part.type !== "file") continue;
          const filename = part.filename || "upload";
          if (!isTypeAllowed(acfg.allowedTypes, part.mimetype, filename)) {
            // Drain the current part so the stream unwinds cleanly, then reject.
            await part.toBuffer().catch(() => undefined);
            return reply.code(415).send({
              error: `file type not allowed: ${filename}${part.mimetype ? ` (${part.mimetype})` : ""}`,
            });
          }
          let bytes: Buffer;
          try {
            bytes = await part.toBuffer();
          } catch {
            // @fastify/multipart truncates + throws when a part exceeds fileSize.
            return reply
              .code(413)
              .send({ error: `file too large (max ${acfg.maxFileSizeMb} MB): ${filename}` });
          }
          if (bytes.length > maxBytes) {
            return reply
              .code(413)
              .send({ error: `file too large (max ${acfg.maxFileSizeMb} MB): ${filename}` });
          }
          collected.push({ filename, mimetype: part.mimetype, bytes });
        }
      } catch (err) {
        // Count-limit (too many parts) and other multipart failures land here.
        const code = (err as { code?: string }).code;
        if (code === "FST_FILES_LIMIT") {
          return reply
            .code(413)
            .send({ error: `too many files (max ${acfg.maxFilesPerMessage} per message)` });
        }
        return reply.code(400).send({ error: (err as Error).message });
      }
      if (collected.length === 0) {
        return reply.code(400).send({ error: "no files in request" });
      }
      const files = [];
      for (const c of collected) {
        const id = await attachments.save(c.bytes, c.filename);
        files.push({
          id,
          filename: c.filename,
          size: c.bytes.length,
          kind: inferAttachmentKind(c.filename, c.mimetype),
        });
      }
      return { files };
    },
  );
}
