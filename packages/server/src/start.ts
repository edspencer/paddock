/**
 * Process lifecycle for a Paddock server: bind the port and wire signal-driven
 * shutdown. Split out of `index.ts` so the `paddock` CLI (src/cli/paddock.ts)
 * and the plain `node dist/index.js` entrypoint share one implementation.
 *
 * Config is resolved INSIDE `buildApp()`, not at module load, so a caller may
 * still mutate `process.env` right up until this function is invoked. The CLI
 * depends on that to apply its own defaults (e.g. a data dir under $HOME).
 */
import { buildApp } from "./app.js";

export async function start(): Promise<void> {
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
