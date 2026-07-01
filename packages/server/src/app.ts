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
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadPaddockConfig, type PaddockConfig } from "./config.js";
import { ProjectStore } from "./projects.js";
import { HerdctlService } from "./herdctl.js";
import { GitService } from "./git.js";
import { GithubAuth } from "./github-auth.js";
import { registerRoutes } from "./routes.js";
import { registerAuth } from "./auth.js";
import { makeChatHandler } from "./ws.js";
import { SweepService } from "./sweep.js";

export interface BuiltApp {
  app: FastifyInstance;
  cfg: PaddockConfig;
  projects: ProjectStore;
  herdctl: HerdctlService;
  git: GitService;
  githubAuth: GithubAuth;
  sweep: SweepService;
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
 * Construct and fully register the paddock app. Does NOT listen on a port and
 * installs NO signal handlers — the caller (index.ts in prod, tests in CI)
 * owns the lifecycle. The herdctl fleet is initialized + started; a failure
 * there is logged and swallowed (project CRUD still works), matching prod.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const cfg = opts.config ?? loadPaddockConfig();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  // --- auth (provider-agnostic) -----------------------------------------
  // Registered first so its onRequest hook guards every REST + WS request
  // (health probes are exempted inside). Default mode `none` is a no-op. Throws
  // on a fatal misconfig (e.g. jwt mode without a JWKS URL) — fail closed.
  registerAuth(app, cfg.auth);

  // --- project layer + herdctl ------------------------------------------
  const projects = new ProjectStore(cfg.projectsRoot);
  await projects.init();

  const herdctl = new HerdctlService(cfg);
  const git = new GitService(cfg.projectsRoot);
  const githubAuth = new GithubAuth(path.join(cfg.dataDir, "github-auth.json"));
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
    logger: app.log,
  });

  // --- transport ---------------------------------------------------------
  await app.register(websocket);
  await registerRoutes(app, { projects, herdctl, git, githubAuth });

  const chatHandler = makeChatHandler({ herdctl, projects, sweep });
  await app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket) => {
      void chatHandler(socket);
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
      await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
          return reply.sendFile("index.html");
        }
        return reply.code(404).send({ error: "not found" });
      });
      app.log.info({ webDist: cfg.webDist }, "serving built web SPA");
    } else {
      app.log.warn({ webDist: cfg.webDist }, "web dist not found — API-only mode");
    }
  }

  const close = async () => {
    sweep.stop();
    await herdctl.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
  };

  return { app, cfg, projects, herdctl, git, githubAuth, sweep, close };
}
