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

async function boot(opts: { withDist: boolean }): Promise<Harness> {
  const tmp = await makeTmpDir("paddock-static-");
  const home = path.join(tmp, "home");
  const dataDir = path.join(tmp, "data");
  const projectsRoot = path.join(dataDir, "projects");
  const webDist = path.join(tmp, "web-dist");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
  if (opts.withDist) {
    await fs.mkdir(webDist, { recursive: true });
    await fs.writeFile(path.join(webDist, "index.html"), "<!doctype html><title>paddock SPA</title>", "utf8");
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
  };
  process.env.HOME = home;
  delete process.env.CLAUDE_HOME;
  delete process.env.PADDOCK_FAKE_SCRIPT;
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.PADDOCK_DATA_DIR = dataDir;
  process.env.PADDOCK_PROJECTS_DIR = projectsRoot;
  process.env.PADDOCK_WEB_DIST = opts.withDist ? webDist : path.join(tmp, "no-such-dist");
  process.env.LOG_LEVEL = "silent";

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

    // A client-side route (non-/api, non-/ws GET) falls back to index.html.
    const spaRoute = await h.built.app.inject({ method: "GET", url: "/projects/anything" });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toContain("paddock SPA");

    // The API still works (and an unknown /api path is a JSON 404, not the SPA).
    const api = await h.built.app.inject({ method: "GET", url: "/api/health" });
    expect(api.json().ok).toBe(true);
    const apiMiss = await h.built.app.inject({ method: "GET", url: "/api/nope" });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json().error).toBe("not found");
  });

  it("runs API-only (no crash) when serveStatic is on but the dist is missing", async () => {
    h = await boot({ withDist: false });
    const api = await h.built.app.inject({ method: "GET", url: "/api/health" });
    expect(api.json().ok).toBe(true);
  });
});
