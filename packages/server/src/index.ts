/**
 * Paddock server bootstrap.
 *
 * Serves the REST API + WebSocket chat transport, and (in production) the
 * built web SPA from packages/web/dist. The app itself is assembled by
 * `buildApp()` (src/app.ts) — this file only owns the process lifecycle:
 * bind the port and wire SIGINT/SIGTERM shutdown.
 */
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const { app, cfg, close } = await buildApp();

  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`paddock-server listening on http://${cfg.host}:${cfg.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
