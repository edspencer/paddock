import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Paddock version, injected as a compile-time constant so the SPA can display it
// (workspace is fixed-versioned, so web's version is the release version).
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// Stamp the service worker's CACHE_VERSION with a per-build id (issue #221) so
// EVERY deploy activates a fresh cache and the SW purges the previous one on
// activate — otherwise the hardcoded constant never changes and a browser keeps
// serving a stale app shell + stale chunks across releases. The id is the package
// version + a short hash of the emitted, content-hashed bundle filenames, so it
// is deterministic (same build input → same id) but changes whenever any bundle
// does. Runs after the public dir (which holds sw.js) is copied to dist.
function swCacheVersion(): Plugin {
  return {
    name: "paddock-sw-cache-version",
    apply: "build",
    closeBundle() {
      const swPath = fileURLToPath(new URL("./dist/sw.js", import.meta.url));
      let sw: string;
      try {
        sw = readFileSync(swPath, "utf-8");
      } catch {
        return; // no sw.js in dist (e.g. copyPublicDir disabled) — nothing to stamp
      }
      let fingerprint = pkgVersion;
      try {
        const assets = readdirSync(fileURLToPath(new URL("./dist/assets", import.meta.url)))
          .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
          .sort()
          .join("\n");
        fingerprint = createHash("sha256").update(assets).digest("hex").slice(0, 12);
      } catch {
        // fall back to the package version alone
      }
      const version = `paddock-${pkgVersion}-${fingerprint}`;
      writeFileSync(swPath, sw.replaceAll("__CACHE_VERSION__", version), "utf-8");
      this.info?.(`sw.js CACHE_VERSION = ${version}`);
    },
  };
}

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
  plugins: [react(), swCacheVersion()],
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
