/**
 * Paddock server bootstrap.
 *
 * Serves the REST API + WebSocket chat transport, and (in production) the
 * built web SPA from packages/web/dist. The app itself is assembled by
 * `buildApp()` (src/app.ts); the process lifecycle lives in `start()`
 * (src/start.ts), which the `paddock` CLI shares.
 */
import { start } from "./start.js";

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
