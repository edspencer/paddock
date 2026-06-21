/**
 * Paddock server bootstrap.
 *
 * Serves the REST API + WebSocket chat transport, and (in production) the
 * built web SPA from packages/web/dist. Wraps @herdctl/core's FleetManager
 * via HerdctlService and a filesystem-backed ProjectStore.
 */
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { promises as fs } from "node:fs";
import { loadPaddockConfig } from "./config.js";
import { ProjectStore } from "./projects.js";
import { HerdctlService } from "./herdctl.js";
import { registerRoutes } from "./routes.js";
import { makeChatHandler } from "./ws.js";
import { SweepService } from "./sweep.js";

async function main(): Promise<void> {
  const cfg = loadPaddockConfig();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  // --- project layer + herdctl ------------------------------------------
  const projects = new ProjectStore(cfg.projectsRoot);
  await projects.init();

  const herdctl = new HerdctlService(cfg);
  const initialProjects = await projects.list();
  try {
    await herdctl.init(initialProjects);
    await herdctl.start();
    app.log.info("herdctl FleetManager initialized");
  } catch (err) {
    // The app is still useful for project CRUD even if the fleet can't start
    // (e.g. missing Claude auth in a dev box). Log and continue.
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
  await registerRoutes(app, { projects, herdctl });

  const chatHandler = makeChatHandler({ herdctl, projects, sweep });
  await app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket) => {
      void chatHandler(socket);
    });
  });

  // --- static SPA (production) ------------------------------------------
  const hasWebDist = await fs
    .stat(cfg.webDist)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    // SPA fallback: any non-API/non-WS GET serves index.html.
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

  // --- lifecycle ---------------------------------------------------------
  const close = async () => {
    sweep.stop();
    await herdctl.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`paddock-server listening on http://${cfg.host}:${cfg.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
