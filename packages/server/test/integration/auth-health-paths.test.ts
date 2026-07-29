/**
 * Ties `auth.ts`'s HEALTH_PATHS exemption set to the REAL router (issue #569).
 *
 * The bug this locks out: `HEALTH_PATHS` exempted six paths from auth but only
 * `/api/health` was ever registered. An exempted path that no route serves does
 * not 404 — it reaches the SPA not-found handler (`app.ts`) *without* a
 * credential, so a monitoring probe got `200 text/html` (the app shell) and read
 * the instance as healthy. The exemption is what makes that fallback reachable:
 * in the authenticated modes an unregistered path 401s honestly, but an exempted
 * unregistered one answers 200.
 *
 * So the load-bearing assertion is not "health paths return 200" — the old unit
 * test proved that against a synthetic app that hand-registered `/healthz`. It is
 * "every member of HEALTH_PATHS resolves to a registered route returning JSON,
 * with a real web dist mounted and auth ON". A dist is required: without one all
 * five aliases correctly 404 and the bug is invisible.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp, type BuiltApp } from "../../src/app.js";
import { HEALTH_PATHS } from "../../src/auth.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const FAKE_BIN = fileURLToPath(new URL("../../../../test/bin", import.meta.url));

/** Marker lives in the <body>: branding injection rewrites <title> (issue #34). */
const FIXTURE_INDEX =
  "<!doctype html><html><head><title>Paddock</title></head><body><div id=root>paddock SPA</div></body></html>";

/** The five conventional aliases retired in #569 — must NOT be exempt any more. */
const RETIRED_ALIASES = ["/healthz", "/-/health", "/health", "/readyz", "/livez"];

interface Harness {
  built: BuiltApp;
  tmp: string;
  restore: () => void;
}

/** Boot the real app with a real web dist and `trusted-header` auth engaged. */
async function boot(): Promise<Harness> {
  const tmp = await makeTmpDir("paddock-health-paths-");
  const home = path.join(tmp, "home");
  const dataDir = path.join(tmp, "data");
  const projectsRoot = path.join(dataDir, "projects");
  const webDist = path.join(tmp, "web-dist");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.mkdir(webDist, { recursive: true });
  await fs.writeFile(path.join(webDist, "index.html"), FIXTURE_INDEX, "utf8");

  const KEYS = [
    "HOME",
    "PATH",
    "HOST",
    "LOG_LEVEL",
    "CLAUDE_HOME",
    "PADDOCK_DATA_DIR",
    "PADDOCK_PROJECTS_DIR",
    "PADDOCK_WEB_DIST",
    "PADDOCK_FAKE_SCRIPT",
    "PADDOCK_AUTH_MODE",
    "PADDOCK_AUTH_USER_HEADER",
    "PADDOCK_BRAND_NAME",
    "PADDOCK_BRAND_LOGO",
    "PADDOCK_BRAND_ACCENT",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];

  process.env.HOME = home;
  // Pin loopback so the safe-by-default bind guard (#435) doesn't refuse to boot
  // under a dev box's ambient HOST=0.0.0.0.
  process.env.HOST = "127.0.0.1";
  delete process.env.CLAUDE_HOME;
  delete process.env.PADDOCK_FAKE_SCRIPT;
  for (const k of ["PADDOCK_BRAND_NAME", "PADDOCK_BRAND_LOGO", "PADDOCK_BRAND_ACCENT"]) {
    delete process.env[k];
  }
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.PADDOCK_DATA_DIR = dataDir;
  process.env.PADDOCK_PROJECTS_DIR = projectsRoot;
  process.env.PADDOCK_WEB_DIST = webDist;
  process.env.LOG_LEVEL = "silent";
  // Auth ON — the deployment shape where the exemption is load-bearing.
  process.env.PADDOCK_AUTH_MODE = "trusted-header";
  process.env.PADDOCK_AUTH_USER_HEADER = "X-Forwarded-User";

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

describe("integration: auth health-path exemptions match the router (issue #569)", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await h.built.close().catch(() => undefined);
      h.restore();
      await rmTmpDir(h.tmp);
      h = null;
    }
  });

  // THE guard against recurrence: adding a path to HEALTH_PATHS without also
  // registering a route fails here, because the SPA shell is not JSON.
  it("every HEALTH_PATHS member is a registered route answering JSON without a credential", async () => {
    h = await boot();
    const app = h.built.app;
    expect(HEALTH_PATHS.size).toBeGreaterThan(0);

    for (const url of HEALTH_PATHS) {
      // Browser-shaped Accept is the hostile case: it is exactly what satisfies
      // the "is a navigation → serve the shell" branch of the not-found handler.
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, `${url} must be reachable unauthenticated`).toBe(200);
      expect(res.headers["content-type"], `${url} must answer JSON, not the app shell`).toMatch(
        /application\/json/,
      );
      expect(res.body, `${url} must not be the SPA shell`).not.toContain("paddock SPA");
      expect(res.json().ok).toBe(true);
    }
  });

  // The inversion that made #569 a bug rather than the intended SPA fallback:
  // an unregistered path answers honestly, so an exempted-but-unregistered one
  // silently turned that "unauthorized" into "200 healthy".
  it("an unregistered extension-less path 401s, so exemption is what grants SPA reachability", async () => {
    h = await boot();
    const res = await h.built.app.inject({
      method: "GET",
      url: "/definitely-not-a-route",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("auth_required");
  });

  it("the five retired aliases are no longer exempt — they 401 like any other path", async () => {
    h = await boot();
    for (const url of RETIRED_ALIASES) {
      const res = await h.built.app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html" },
      });
      expect(res.statusCode, `${url} must not be waved past auth`).toBe(401);
      expect(res.body, `${url} must not serve the SPA shell to an anonymous probe`).not.toContain(
        "paddock SPA",
      );
    }
  });

  // normalizePath (auth.ts) strips the query string before matching, so a probe
  // URL carrying one still reaches the route. Previously untested for a health
  // path, so a regression here would have silently 401'd real monitoring.
  it("exempts a health path carrying a query string", async () => {
    h = await boot();
    for (const url of ["/api/health?x=1", "/api/health?probe=k8s&t=1"]) {
      const res = await h.built.app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} must be exempt after normalization`).toBe(200);
      expect(res.json().ok).toBe(true);
    }
  });

  // normalizePath also strips a trailing slash, but that only affects the AUTH
  // decision — Fastify's router is not configured with `ignoreTrailingSlash`, so
  // `/api/health/` matches no route. The honest outcome is a JSON 404 (an /api
  // path never reaches the SPA fallback), NOT a false 200: a probe pointed at the
  // slashed form fails loudly rather than reporting healthy. Pinned so nobody
  // "fixes" the exemption half of this and calls the probe URL supported.
  it("treats a trailing-slash health path as exempt-but-unrouted: JSON 404, never the shell", async () => {
    h = await boot();
    for (const url of ["/api/health/", "/api/health/?probe=k8s"]) {
      const res = await h.built.app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, `${url} is exempt from auth but matches no route`).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.body).not.toContain("paddock SPA");
      // 404 (not 401) is what proves the exemption itself applied.
      expect(res.json().error).toBe("not found");
    }
  });
});
