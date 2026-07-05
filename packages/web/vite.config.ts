import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Paddock version, injected as a compile-time constant so the SPA can display it
// (workspace is fixed-versioned, so web's version is the release version).
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// Dev server config. The Vite dev server proxies /api + /ws to the
// paddock-server. Both the dev-server port and the backend it proxies to are
// configurable via env so you can run the frontend on a non-default port or
// point it at a backend that isn't on :4000 (e.g. a second instance).
//
//   PADDOCK_DEV_PORT     Vite dev-server port                (default 5173)
//   PADDOCK_PROXY_TARGET http(s) origin of the paddock-server (default http://localhost:4000)
//
// The WebSocket proxy target is derived from PADDOCK_PROXY_TARGET (http -> ws).
const devPort = Number(process.env.PADDOCK_DEV_PORT) || 5173;
const proxyTarget = process.env.PADDOCK_PROXY_TARGET || "http://localhost:4000";
const wsTarget = proxyTarget.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  server: {
    port: devPort,
    proxy: {
      "/api": proxyTarget,
      "/ws": { target: wsTarget, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
