/**
 * Covers app.ts's static-SPA serving branch (buildApp with serveStatic:true):
 *   - a real web dist → GET / serves index.html, and the SPA fallback
 *     (non-/api, non-/ws GET) serves index.html too
 *   - a non-/api 404 that IS an api path falls through to the JSON 404
 *   - serveStatic:true but a MISSING dist → API-only mode (no crash, /api works)
 *
 * Boots buildApp directly (not via startTestApp's serveStatic:false), wiring a
 * temp HOME + data dir + a fake web dist, then tears the fleet/server down.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp, type BuiltApp } from "../../src/app.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const FAKE_BIN = fileURLToPath(new URL("../../../../test/bin", import.meta.url));

interface Harness {
  built: BuiltApp;
  tmp: string;
  restore: () => void;
}

// The marker lives in the <body> (not the <title>) because branding injection
// rewrites <title> to the configured name (issue #34).
const FIXTURE_INDEX =
  "<!doctype html><html><head><title>Paddock</title></head><body><div id=root>paddock SPA</div></body></html>";

async function boot(opts: {
  withDist: boolean;
  brand?: { name?: string; logo?: string; accent?: string };
}): Promise<Harness> {
  const tmp = await makeTmpDir("paddock-static-");
  const home = path.join(tmp, "home");
  const dataDir = path.join(tmp, "data");
  const projectsRoot = path.join(dataDir, "projects");
  const webDist = path.join(tmp, "web-dist");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
  if (opts.withDist) {
    await fs.mkdir(webDist, { recursive: true });
    await fs.writeFile(path.join(webDist, "index.html"), FIXTURE_INDEX, "utf8");
  }

  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PADDOCK_DATA_DIR: process.env.PADDOCK_DATA_DIR,
    PADDOCK_PROJECTS_DIR: process.env.PADDOCK_PROJECTS_DIR,
    PADDOCK_WEB_DIST: process.env.PADDOCK_WEB_DIST,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    LOG_LEVEL: process.env.LOG_LEVEL,
    PADDOCK_FAKE_SCRIPT: process.env.PADDOCK_FAKE_SCRIPT,
    PADDOCK_BRAND_NAME: process.env.PADDOCK_BRAND_NAME,
    PADDOCK_BRAND_LOGO: process.env.PADDOCK_BRAND_LOGO,
    PADDOCK_BRAND_ACCENT: process.env.PADDOCK_BRAND_ACCENT,
  };
  process.env.HOME = home;
  delete process.env.CLAUDE_HOME;
  delete process.env.PADDOCK_FAKE_SCRIPT;
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.PADDOCK_DATA_DIR = dataDir;
  process.env.PADDOCK_PROJECTS_DIR = projectsRoot;
  process.env.PADDOCK_WEB_DIST = opts.withDist ? webDist : path.join(tmp, "no-such-dist");
  process.env.LOG_LEVEL = "silent";
  // Branding env (issue #34) — set or clear per test.
  for (const k of ["PADDOCK_BRAND_NAME", "PADDOCK_BRAND_LOGO", "PADDOCK_BRAND_ACCENT"]) {
    delete process.env[k];
  }
  if (opts.brand?.name) process.env.PADDOCK_BRAND_NAME = opts.brand.name;
  if (opts.brand?.logo) process.env.PADDOCK_BRAND_LOGO = opts.brand.logo;
  if (opts.brand?.accent) process.env.PADDOCK_BRAND_ACCENT = opts.brand.accent;

  const built = await buildApp({ serveStatic: true });
  await built.app.ready();

  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { built, tmp, restore };
}

describe("integration: app.ts static-SPA serving", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await h.built.close().catch(() => undefined);
      h.restore();
      await rmTmpDir(h.tmp);
      h = null;
    }
  });

  it("serves index.html at / and via the SPA fallback when a dist exists", async () => {
    h = await boot({ withDist: true });
    const root = await h.built.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("paddock SPA");
    // Default branding: the config global is injected but no accent override.
    expect(root.body).toContain("window.__PADDOCK_CONFIG__=");
    expect(root.body).not.toContain("<style>");

    // A client-side route (non-/api, non-/ws GET) falls back to index.html.
    const spaRoute = await h.built.app.inject({ method: "GET", url: "/projects/anything" });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toContain("paddock SPA");
    expect(spaRoute.body).toContain("window.__PADDOCK_CONFIG__=");

    // The API still works (and an unknown /api path is a JSON 404, not the SPA).
    const api = await h.built.app.inject({ method: "GET", url: "/api/health" });
    expect(api.json().ok).toBe(true);
    const apiMiss = await h.built.app.inject({ method: "GET", url: "/api/nope" });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json().error).toBe("not found");
  });

  it("404s a missing static asset instead of serving index.html (issue #220)", async () => {
    h = await boot({ withDist: true });
    const app = h.built.app;

    // A stale/missing hashed asset (has a file extension) must be a real 404 — NOT
    // index.html — so the browser fails loudly on "module script" load instead of
    // parsing HTML as JS, and the service worker can't cache HTML under the URL.
    for (const url of [
      "/assets/index-DEADBEEF.js",
      "/assets/ChatPane-OLDHASH.css",
      "/favicon-nope.png",
      "/sw-missing.js",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { accept: "*/*", "sec-fetch-mode": "cors" },
      });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"] ?? "").not.toContain("text/html");
      expect(res.body).not.toContain("paddock SPA");
    }

    // But a real navigation to a *dotted* client route (e.g. a file deep-link
    // carrying Accept: text/html) still resolves to the SPA shell.
    const dotted = await app.inject({
      method: "GET",
      url: "/projects/x/files/README.md",
      headers: { accept: "text/html" },
    });
    expect(dotted.statusCode).toBe(200);
    expect(dotted.body).toContain("paddock SPA");

    // A navigation Sec-Fetch-Mode also wins even for a dotted path.
    const navMode = await app.inject({
      method: "GET",
      url: "/projects/x/files/notes.txt",
      headers: { accept: "*/*", "sec-fetch-mode": "navigate" },
    });
    expect(navMode.statusCode).toBe(200);
    expect(navMode.body).toContain("paddock SPA");

    // An extension-less client route still resolves even without any Accept hint
    // (e.g. programmatic clients / the existing inject-based tests).
    const bare = await app.inject({ method: "GET", url: "/projects/anything/home" });
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toContain("paddock SPA");
  });

  it("injects per-instance branding into the served index.html (issue #34)", async () => {
    h = await boot({
      withDist: true,
      brand: { name: "Homelab", logo: "🏠", accent: "#3366cc" },
    });
    for (const url of ["/", "/index.html", "/projects/x/chat"]) {
      const res = await h.built.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<title>Homelab</title>");
      expect(res.body).toContain('"name":"Homelab"');
      expect(res.body).toContain('"logo":"🏠"');
      // A custom accent emits the :root channel override.
      expect(res.body).toContain("<style>:root{--accent:51 102 204;");
      // The original body content is preserved.
      expect(res.body).toContain("paddock SPA");
    }
  });

  it("runs API-only (no crash) when serveStatic is on but the dist is missing", async () => {
    h = await boot({ withDist: false });
    const api = await h.built.app.inject({ method: "GET", url: "/api/health" });
    expect(api.json().ok).toBe(true);
  });
});
