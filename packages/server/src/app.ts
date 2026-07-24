/**
 * App factory — builds a fully-wired Fastify instance (REST + WS + optional
 * static SPA) around a ProjectStore + HerdctlService + GitService + GithubAuth.
 *
 * Extracted from index.ts so tests can boot the REAL app in-process against a
 * temp data dir (with a fake `claude` on PATH) without binding a port or
 * registering signal handlers. `index.ts` calls `buildApp()` then `app.listen`.
 *
 * This is a testability seam only — the wiring is identical to the prior inline
 * bootstrap; no behavior changed.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadPaddockConfig, type PaddockConfig } from "./config.js";
import { ProjectStore } from "./projects.js";
import { AttachmentStore } from "./attachments.js";
import { HerdctlService } from "./herdctl.js";
import { GitService } from "./git.js";
import { GithubAuth } from "./github-auth.js";
import { makeTranscriber, type Transcriber } from "./transcribe.js";
import { registerRoutes } from "./routes.js";
import { registerAuth } from "./auth.js";
import { evaluateBindSafety } from "./bind-safety.js";
import { renderIndexHtml } from "./brand.js";
import { makeChatHandler } from "./ws.js";
import { SweepService } from "./sweep.js";
import { ArchiveStore } from "./archive.js";
import { StarStore } from "./star.js";
import { ReadStateStore } from "./read-state.js";
import { QueuedMessageStore } from "./queued-message.js";
import { RunProvenanceStore } from "./run-provenance.js";
import { MessageProvenanceStore } from "./message-provenance.js";
import { ScheduleSessionStore } from "./schedule-session.js";
import { TriggerSessionStore } from "./trigger-session.js";
import { PaddockEventBus } from "./event-bus.js";
import { TriggerService } from "./triggers.js";

export interface BuiltApp {
  app: FastifyInstance;
  cfg: PaddockConfig;
  projects: ProjectStore;
  herdctl: HerdctlService;
  git: GitService;
  githubAuth: GithubAuth;
  sweep: SweepService;
  archive: ArchiveStore;
  star: StarStore;
  readState: ReadStateStore;
  queuedMessage: QueuedMessageStore;
  transcriber: Transcriber;
  /** In-process lifecycle event bus (Epic T) — commit sites emit lifecycle events. */
  events: PaddockEventBus;
  /** Unified trigger registry (Epic T / T1) — the sole trigger CRUD surface. */
  triggers: TriggerService;
  /** Tear down the fleet + close the server (no process.exit, for tests). */
  close: () => Promise<void>;
}

export interface BuildAppOptions {
  /** Override the resolved config (tests pass a temp-dir config). */
  config?: PaddockConfig;
  /** Skip serving the built web SPA even if a dist exists (API-only). */
  serveStatic?: boolean;
}

/**
 * True when the (query-stripped) path's last segment carries a file extension —
 * e.g. `/assets/index-ABC.js`, `/favicon.ico`, `/sw.js`. Used by the SPA
 * not-found handler (issue #220) to distinguish a missing static asset (→ 404)
 * from a client-side route (→ index.html shell).
 */
function hasFileExtension(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[^./]+$/.test(last);
}

/**
 * Construct and fully register the paddock app. Does NOT listen on a port and
 * installs NO signal handlers — the caller (index.ts in prod, tests in CI)
 * owns the lifecycle. The herdctl fleet is initialized + started; a failure
 * there is logged and swallowed (project CRUD still works), matching prod.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const cfg = opts.config ?? loadPaddockConfig();

  const app = Fastify({
    logger: { level: cfg.logLevel },
  });

  // --- safe-by-default bind guard (#435) --------------------------------
  // Fail closed if the resolved bind host is non-loopback AND auth is `none`:
  // that would expose an unauthenticated Paddock (which runs code + spends
  // tokens) on a routable interface. Mirrors the jwt-without-JWKS fail-closed
  // check below. A dangerously-worded env opt-in downgrades the refusal to a
  // loud one-line boot warning.
  {
    const decision = evaluateBindSafety({
      host: cfg.host,
      authMode: cfg.auth.mode,
      dangerouslyAllowOpen: cfg.dangerouslyAllowOpen,
    });
    if (decision.action === "refuse") throw new Error(decision.message);
    if (decision.action === "warn") app.log.warn(decision.message);
  }

  // --- auth (provider-agnostic) -----------------------------------------
  // Registered first so its onRequest hook guards every REST + WS request
  // (health probes are exempted inside). Default mode `none` is a no-op. Throws
  // on a fatal misconfig (e.g. jwt mode without a JWKS URL) — fail closed.
  registerAuth(app, cfg.auth);

  // --- project layer + herdctl ------------------------------------------
  const projects = new ProjectStore(cfg.projectsRoot);
  await projects.init();

  const herdctl = new HerdctlService(cfg);
  const git = new GitService(cfg.projectsRoot, cfg.gitAuthor);
  const githubAuth = new GithubAuth(path.join(cfg.dataDir, "github-auth.json"), cfg.githubClientId);
  const archive = new ArchiveStore(cfg.dataDir);
  // Per-chat starred/pinned-flag sidecar (#373). Orthogonal to `archive`; the
  // client floats starred chats to the top of both the active and Archived lists.
  const star = new StarStore(cfg.dataDir);
  // Per-user (or shared, in `none` mode) chat read-state sidecar (#189).
  const readState = new ReadStateStore(cfg.dataDir);
  // Per-chat queued message sidecar (#197) for server-side auto-send.
  const queuedMessage = new QueuedMessageStore(cfg.dataDir);
  // Per-chat provenance sidecar (issue #261): records how each chat was created
  // (origin human/scheduled/spawned + spawn depth) so #262 can depth-gate
  // spawning and #267 can badge provenance. A1 only carries/persists the marker.
  const runProvenance = new RunProvenanceStore(cfg.dataDir);
  // Per-MESSAGE provenance sidecar (issue #290): records WHO injected each
  // machine-added turn (send_message / schedule / spawn kickoff) so the chat
  // history can attribute it. The per-message analog of runProvenance.
  const messageProvenance = new MessageProvenanceStore(cfg.dataDir);
  // Owned-session sidecar for accreting schedules (issue #265 / DD-2): maps a
  // `resume_session: true` schedule to the one chat it accretes into across fires.
  const scheduleSessions = new ScheduleSessionStore(cfg.dataDir);
  // In-process lifecycle event bus (Epic T). The archive commit sites (REST route +
  // self-MCP archive tool) `emit` onto the bus; the chat handler subscribes and fires
  // the project's enabled event triggers via startAgentTurn.
  const events = new PaddockEventBus();
  // Unified trigger registry + owned-session sidecar (Epic T / T1). TriggerService is
  // the single CRUD surface over both fire paths (event bus + schedule handler); the
  // sidecar rebinds a `run.session: "resume"` trigger's owned chat after a restart.
  const triggers = new TriggerService(projects, herdctl);
  const triggerSessions = new TriggerSessionStore(cfg.dataDir);
  // Store for files shared via mcp__paddock__send_file (issue #112). Copies live
  // outside any project working dir so they never show up as untracked repo files.
  const attachments = new AttachmentStore(path.join(cfg.dataDir, "attachments"));
  await attachments.init();
  const transcriber = makeTranscriber(cfg.transcription);
  app.log.info(
    { mode: cfg.transcription.mode, available: transcriber.available },
    "voice dictation capability",
  );
  const initialProjects = await projects.list();
  try {
    await herdctl.init(initialProjects);
    await herdctl.start();
    app.log.info("herdctl FleetManager initialized");
  } catch (err) {
    app.log.error({ err }, "FleetManager init/start failed — chat will be unavailable");
  }

  // --- post-turn curation sweep (overview + changelog) -------------------
  const sweep = new SweepService({
    herdctl,
    projects,
    dataDir: cfg.dataDir,
    minIntervalMs: cfg.sweepMinIntervalMs,
    budget: cfg.curation,
    logger: app.log,
  });

  // --- transport ---------------------------------------------------------
  await app.register(websocket);
  // Multipart parses the mic-recording upload on POST /api/transcribe. The size
  // cap mirrors the transcription config so an oversized blob is rejected before
  // it's buffered in full.
  await app.register(fastifyMultipart, {
    limits: { fileSize: cfg.transcription.maxUploadBytes, files: 1 },
  });
  const chatHandler = makeChatHandler({ herdctl, projects, sweep, attachments, queuedMessage, runProvenance, messageProvenance, archive, scheduleSessions, events, triggers, triggerSessions, cfg });

  await registerRoutes(app, { projects, herdctl, git, githubAuth, transcriber, archive, star, readState, runProvenance, messageProvenance, attachments, fireTrigger: chatHandler.fireTrigger, events, triggers, cfg });

  await app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket) => {
      void chatHandler.handle(socket);
    });
  });

  // --- static SPA (production) ------------------------------------------
  const serveStatic = opts.serveStatic ?? true;
  if (serveStatic) {
    const hasWebDist = await fs
      .stat(cfg.webDist)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (hasWebDist) {
      // Inject per-instance branding (issue #34) into index.html ONCE at
      // startup, then serve that string for the app root + every client-side
      // route.
      const rawIndex = await fs.readFile(path.join(cfg.webDist, "index.html"), "utf8");
      const indexHtml = renderIndexHtml(rawIndex, cfg.brand);
      const sendIndex = (reply: FastifyReply) =>
        reply.type("text/html; charset=utf-8").send(indexHtml);

      // Short-circuit the app root before fastifyStatic can serve the RAW
      // index.html (a per-file route with `wildcard: false`). An onRequest hook
      // that replies stops routing, so we own the branded document without
      // registering a route that would collide with the static plugin.
      app.addHook("onRequest", async (req, reply) => {
        if (req.method !== "GET") return;
        const p = req.url.split("?")[0];
        if (p === "/" || p === "/index.html") return sendIndex(reply);
      });
      await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
          // Serve the SPA shell for client-side routes — but NEVER for a request
          // that is clearly a missing *static asset* (a stale hashed chunk after a
          // deploy, or any missing file). Those must 404 (issue #220): otherwise the
          // browser receives index.html (text/html) for a JS/CSS module and throws
          // "Failed to load module script…" ("Unexpected application error: a module
          // script failed"), and the service worker would cache that HTML under the
          // asset URL and serve it indefinitely.
          //
          // A request is treated as a client-side route (→ shell) when it is a real
          // browser navigation (Accept: text/html, or Sec-Fetch-Mode: navigate) OR
          // its path has no file extension. Everything else with a file extension
          // (e.g. /assets/index-DEADBEEF.js, /favicon.ico) 404s. Dotted client routes
          // such as /projects/x/files/README.md still resolve to the shell because a
          // reload/deep-link of them is a navigation carrying Accept: text/html.
          const p = req.url.split("?")[0];
          const accept = String(req.headers["accept"] ?? "");
          const isNavigation =
            req.headers["sec-fetch-mode"] === "navigate" || accept.includes("text/html");
          if (isNavigation || !hasFileExtension(p)) return sendIndex(reply);
        }
        return reply.code(404).send({ error: "not found" });
      });
      app.log.info({ webDist: cfg.webDist, brand: cfg.brand.name }, "serving built web SPA");
    } else {
      app.log.warn({ webDist: cfg.webDist }, "web dist not found — API-only mode");
    }
  }

  const close = async () => {
    sweep.stop();
    await herdctl.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
  };

  return { app, cfg, projects, herdctl, git, githubAuth, sweep, archive, star, readState, queuedMessage, transcriber, events, triggers, close };
}
