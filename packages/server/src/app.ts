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
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadPaddockConfig, type PaddockConfig } from "./config.js";
import {
  ensureClaudeHome,
  countLegacyTranscriptLinks,
  findPlantedChatsLinks,
} from "./claude-home.js";
import { loadHostMcpSource } from "./claude-mcp.js";
import { installHerdctlLogBridge } from "./agent-errors.js";
import { ProjectStore, ROOT_KEY } from "./projects.js";
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
import { UnreadStore } from "./unread.js";
import { ParentDetachStore } from "./parent-detach.js";
import { QueuedMessageStore } from "./queued-message.js";
import { RunProvenanceStore } from "./run-provenance.js";
import { MessageProvenanceStore } from "./message-provenance.js";
import { ScheduleSessionStore } from "./schedule-session.js";
import { TriggerSessionStore } from "./trigger-session.js";
import { PaddockEventBus } from "./event-bus.js";
import { TriggerService } from "./triggers.js";
import { buildSwaggerOptions, buildSwaggerUiOptions, type SwaggerImage } from "./openapi.js";

// Resolve the package version at runtime (dist/app.js → ../package.json) so the
// generated OpenAPI document's info.version tracks the release without a build step.
const pkgVersion: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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
  /** Per-user manual "unread" override sidecar (#458). */
  unread: UnreadStore;
  /** Explicit "detached from its parent" sidecar (#508) — beats both parent tiers. */
  parentDetach: ParentDetachStore;
  /** Per-chat creation provenance (#261), incl. the recorded parent edge (#485). */
  runProvenance: RunProvenanceStore;
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

  // Shape the engine's own logging before anything can start a job (#684). Two
  // of the three sources of the credential-failure stack-trace wall are inside
  // `@herdctl/core`, and `setLogHandler` is the supported way to reach them from
  // out here. `PADDOCK_QUIET` is set by `cli/paddock.ts` unless `--verbose`.
  installHerdctlLogBridge({ quiet: (process.env.PADDOCK_QUIET ?? "") !== "" });

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

  // The user's own MCP servers, under `claude.mcpServers: host` (#691 step 5).
  // Read BEFORE the service is constructed because every keeper's agent config
  // carries them, and read exactly once — a `.claude.json` that grows a server
  // mid-run is picked up at the next restart, which is what the notice says.
  // Under `own` (the default) the file is not opened at all.
  const hostMcp = await loadHostMcpSource(cfg);
  for (const notice of hostMcp.notices) app.log[notice.level](notice.message);
  const herdctl = new HerdctlService(cfg, hostMcp.source);
  const git = new GitService(cfg.projectsRoot, cfg.gitAuthor);
  const githubAuth = new GithubAuth(path.join(cfg.dataDir, "github-auth.json"), cfg.githubClientId);
  const archive = new ArchiveStore(cfg.dataDir);
  // Per-chat starred/pinned-flag sidecar (#373). Orthogonal to `archive`; the
  // client floats starred chats to the top of both the active and Archived lists.
  const star = new StarStore(cfg.dataDir);
  // Per-user (or shared, in `none` mode) chat read-state sidecar (#189).
  const readState = new ReadStateStore(cfg.dataDir);
  // Per-user manual "unread" override sidecar (#458) — layered on read-state so a
  // chat can be re-flagged unread after its last turn was seen ("look at it again
  // in the morning"). Cleared whenever the chat is marked seen.
  const unread = new UnreadStore(cfg.dataDir);
  // Explicit "this chat was detached from its parent" sidecar (#508). Checked
  // ahead of both parent-resolution tiers, so a detach survives the inference
  // that would otherwise re-derive the old parent on the next list load.
  const parentDetach = new ParentDetachStore(cfg.dataDir);
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
  // `list()` enumerates the root's CHILDREN (it walks subdirectories), so the
  // root workspace itself is never in it. It always exists — the instance's own
  // directory — so resolve it explicitly and register its keeper alongside every
  // child's. The root keeper is an ordinary keeper in every respect.
  // Paddock's own Claude home (#620) — created and bridged BEFORE the fleet
  // starts, because `herdctl.init` immediately plants every project's transcript
  // symlink inside it and hands the same path to the FleetManager.
  for (const notice of (await ensureClaudeHome(cfg)).notices) {
    app.log[notice.level](notice.message);
  }
  // Unconditional since #691 — paddock always owns its home, so there is no
  // longer a layout in which these links are the live ones.
  const stale = await countLegacyTranscriptLinks(cfg.legacyClaudeHome, cfg.dataDir);
  if (stale > 0) {
    app.log.info(
      `${stale} transcript symlink(s) from a previous layout still point into ${cfg.dataDir} ` +
        `from ${path.join(cfg.legacyClaudeHome, "projects")}. Nothing reads them any more; ` +
        `paddock leaves them alone because it does not write to ~/.claude. Safe to delete.`,
    );
  }
  // #682: links an affected build planted at a path the user had not used yet.
  // Unlike the residue above these are still LIVE — they redirect the user's own
  // future `claude` sessions — so they warn, and name every path. Paddock does
  // not remove them; it does not write to `~/.claude`.
  const poisoned = await findPlantedChatsLinks(cfg.legacyClaudeHome, cfg.dataDir);
  if (poisoned.length > 0) {
    app.log.warn(
      `${poisoned.length} symlink(s) in ${path.join(cfg.legacyClaudeHome, "projects")} redirect ` +
        `Claude Code's transcripts into a paddock .chats/ store (#682). While they exist, ` +
        `\`claude\` sessions you start in those directories are written to paddock's store, and ` +
        `deleting that store destroys them. Paddock does not remove anything under ~/.claude — ` +
        `delete them yourself if you did not intend this:\n` +
        poisoned
          .map((p) => `  ${p.link} -> ${p.target}${p.dangling ? "  (target is missing)" : ""}`)
          .join("\n"),
    );
  }

  const rootWorkspace = await projects.get(ROOT_KEY);
  const initialProjects = [...(await projects.list()), rootWorkspace];
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
  // --- OpenAPI (derived from route schemas) -----------------------------
  // @fastify/swagger MUST register before the routes: it hooks `onRoute` to
  // collect each route's schema into a live OpenAPI document. Swagger UI mounts
  // at /docs and reads that document (raw spec at /docs/json). Both sit behind
  // whatever auth mode is configured (no special exemption) — the docs are
  // gated exactly like the API they describe. The security schemes advertised in
  // the spec reflect this instance's auth mode (see openapi.ts / authDoc).
  //
  // The topbar logo + favicon are the shipped Paddock icons from the built web
  // bundle (icons/*.png), so the docs are branded like the app; missing assets
  // (API-only mode with no web dist) just fall back to the stock look.
  if (cfg.openapi.enabled) {
    const readImage = async (rel: string, type: string): Promise<SwaggerImage | undefined> => {
      try {
        return { type, content: await fs.readFile(path.join(cfg.webDist, rel)) };
      } catch {
        return undefined;
      }
    };
    const [swaggerLogo, swaggerFavicon] = await Promise.all([
      readImage(path.join("icons", "icon-192.png"), "image/png"),
      readImage(path.join("icons", "favicon-32.png"), "image/png"),
    ]);
    await app.register(fastifySwagger, buildSwaggerOptions(pkgVersion, cfg.auth));
    await app.register(
      fastifySwaggerUi,
      buildSwaggerUiOptions({
        routePrefix: cfg.openapi.path,
        logo: swaggerLogo,
        favicon: swaggerFavicon,
        accent: cfg.brand.accent,
      }),
    );
    // Stable, tool-friendly alias for the raw spec (e.g. `/open-api.json`), next
    // to the UI's own `<path>/json`. Hidden from the spec itself.
    app.get(`${cfg.openapi.path}.json`, { schema: { hide: true } }, () => app.swagger());
    app.log.info({ path: cfg.openapi.path }, "OpenAPI reference mounted");
  } else {
    app.log.info("OpenAPI reference off (set PADDOCK_OPENAPI_ENABLED=1 to mount /open-api)");
  }

  const chatHandler = makeChatHandler({ herdctl, projects, sweep, attachments, queuedMessage, runProvenance, messageProvenance, archive, scheduleSessions, events, triggers, triggerSessions, cfg });

  // --- external Management API (#312 M1) ---------------------------------
  // Surface how the `managementApi` block resolved. A malformed client is an
  // ERROR (the operator wrote something meaningless); a dropped one is a WARNING
  // (its credential wouldn't resolve, so it failed closed). Logged here because
  // config loading has no logger of its own.
  for (const message of cfg.managementApiDiagnostics.errors) app.log.error(message);
  for (const message of cfg.managementApiDiagnostics.warnings) app.log.warn(message);
  if (cfg.managementApi.clients.length > 0) {
    app.log.info(
      {
        clients: cfg.managementApi.clients.map((c) => c.clientId),
        instanceId: cfg.managementApi.instanceId,
      },
      "management API: /mcp enabled (self-authenticated — independent of PADDOCK_AUTH_MODE and of any proxy)",
    );
  } else {
    app.log.info(
      "management API: /mcp disabled (no managementApi.clients configured) — the endpoint 404s",
    );
  }

  await registerRoutes(app, { projects, herdctl, git, githubAuth, transcriber, archive, star, readState, unread, parentDetach, runProvenance, messageProvenance, attachments, fireTrigger: chatHandler.fireTrigger, managementOpsContext: chatHandler.managementOpsContext, events, triggers, cfg });

  await app.register(async (scoped) => {
    // `hide: true` keeps the WS upgrade out of the OpenAPI doc — it's not a REST
    // endpoint (a Swagger "Try it out" against it would just fail); the WS frame
    // protocol is documented in the spec description + docs/API.md instead.
    scoped.get("/ws", { websocket: true, schema: { hide: true } }, (socket) => {
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
      const indexHtml = renderIndexHtml(rawIndex, cfg.brand, {
        enabled: cfg.openapi.enabled,
        path: cfg.openapi.path,
      });
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
        if (
          req.method === "GET" &&
          !req.url.startsWith("/api") &&
          !req.url.startsWith("/ws") &&
          // #312: `/.well-known/` and `/mcp` are MACHINE surfaces and must 404
          // honestly when absent. Both are extension-less, so without this they
          // would fall into the client-side-route branch below and be answered
          // with the SPA shell + 200 — which (a) holes the fail-closed guarantee
          // (an unconfigured management API would "exist" at the discovery URL)
          // and (b) breaks MCP OAuth discovery: a client fetching the
          // protected-resource metadata receives HTML, fails to parse it, and
          // silently falls back to treating Paddock as its own authorization
          // server, with no error naming the real cause.
          !req.url.startsWith("/.well-known/") &&
          !req.url.startsWith("/mcp")
        ) {
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

  return { app, cfg, projects, herdctl, git, githubAuth, sweep, archive, star, readState, unread, parentDetach, runProvenance, queuedMessage, transcriber, events, triggers, close };
}
