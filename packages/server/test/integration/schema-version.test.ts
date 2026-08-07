/**
 * Schema versioning end-to-end through a real booted instance (issue #724).
 *
 * The unit suite (`test/unit/schema-version.test.ts`) pins the guard's decisions
 * against `loadPaddockConfig` and a bare `ProjectStore`. This one proves the two
 * things only a real boot can: that a `paddock.config.yaml` declaring its
 * version still starts an instance (the field must not read as a stray unknown
 * key that trips anything), and that a project from the future is absent from
 * `GET /api/projects` while its file survives the boot untouched.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { CONFIG_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "../../src/schema-version.js";

describe("integration: schemaVersion on the two on-disk formats (#724)", () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.teardown();
    t = undefined;
  });

  it("boots with a config file that declares its schema version", async () => {
    t = await startTestApp({
      configFile: { schemaVersion: CONFIG_SCHEMA_VERSION, logLevel: "silent" },
    });
    const res = await t.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
  });

  it("stamps a newly created project's file, and hides one from the future", async () => {
    t = await startTestApp();

    // A project this build created carries the version explicitly.
    const created = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Ordinary" },
    });
    expect(created.statusCode).toBe(201);
    const onDisk = await fs.readFile(
      path.join(t.projectsRoot, "ordinary", "project.yaml"),
      "utf8",
    );
    expect(YAML.parse(onDisk).schemaVersion).toBe(PROJECT_SCHEMA_VERSION);

    // A project directory copied in from a NEWER paddock. Skipped, not fatal:
    // the instance keeps serving, which is the whole reason this half of the
    // guard is not a refusal.
    const futureDir = path.join(t.projectsRoot, "futuristic");
    const futureFile = path.join(futureDir, "project.yaml");
    const body = [
      "schemaVersion: 99",
      "name: Futuristic",
      "slug: futuristic",
      "status: active",
      "started: 2025-01-01",
      "aKeyThisBuildHasNeverSeen: keep me",
      "",
    ].join("\n");
    await fs.mkdir(futureDir, { recursive: true });
    await fs.writeFile(futureFile, body, "utf8");

    const list = await t.app.inject({ method: "GET", url: "/api/projects" });
    expect(list.statusCode).toBe(200);
    const slugs = (list.json() as { projects: { slug: string }[] }).projects.map((p) => p.slug);
    expect(slugs).toContain("ordinary");
    expect(slugs).not.toContain("futuristic");

    // Hidden, never touched.
    expect(await fs.readFile(futureFile, "utf8")).toBe(body);
  });
});
