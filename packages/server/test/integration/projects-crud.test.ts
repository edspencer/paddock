import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";

describe("integration: project CRUD over REST (real fleet, fake claude)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("boots the real fleet and reports status", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/fleet" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The fleet should have initialized. A fresh instance with no projects
    // registers nothing, so the status object itself is the assertion.
    expect(body.status).toBeTruthy();
    expect(Array.isArray(body.agents)).toBe(true);
  });

  it("exposes the static model list", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultModel).toBe("claude-opus-5");
    expect(body.models.length).toBeGreaterThanOrEqual(3);
  });

  it("creates → lists → gets → updates → deletes a project, registering its keeper", async () => {
    // Create.
    const create = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Garage Heater", group: "house", domain: ["plumbing"] },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().project;
    expect(created.slug).toBe("garage-heater");
    expect(created.group).toBe("house");

    // The keeper agent shows up in the fleet.
    const fleet = (await t.app.inject({ method: "GET", url: "/api/fleet" })).json();
    const names = (fleet.agents as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain("keeper-garage-heater");

    // List.
    const list = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    expect(list.projects.map((p: { slug: string }) => p.slug)).toContain("garage-heater");

    // Get (enriched: changelog + chats).
    const got = (
      await t.app.inject({ method: "GET", url: "/api/projects/garage-heater" })
    ).json();
    expect(got.project.slug).toBe("garage-heater");
    expect(got.changelog).toContain("Project opened.");
    expect(Array.isArray(got.chats)).toBe(true);

    // Update.
    const patched = (
      await t.app.inject({
        method: "PATCH",
        url: "/api/projects/garage-heater",
        payload: { status: "paused", summary: "fix it" },
      })
    ).json();
    expect(patched.project.status).toBe("paused");
    expect(patched.project.summary).toBe("fix it");

    // Delete → keeper unregistered.
    const del = await t.app.inject({ method: "DELETE", url: "/api/projects/garage-heater" });
    expect(del.statusCode).toBe(200);
    const after = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    expect(after.projects.map((p: { slug: string }) => p.slug)).not.toContain("garage-heater");
  });

  it("returns 404 for an unknown project and 409 for a duplicate slug", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/projects/ghost" })).statusCode).toBe(
      404,
    );
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Dup Proj" } });
    const dup = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Dup Proj" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects an unknown model on PATCH with 400", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Model Proj" } });
    const res = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/model-proj",
      payload: { model: "gpt-4" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCHes per-project keeper settings (issue #12)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Keeper Proj" } });
    const patched = (
      await t.app.inject({
        method: "PATCH",
        url: "/api/projects/keeper-proj",
        payload: { permissionMode: "plan", maxTurns: 42, docker: true },
      })
    ).json();
    expect(patched.project.permissionMode).toBe("plan");
    expect(patched.project.maxTurns).toBe(42);
    expect(patched.project.docker).toBe(true);
    // Re-reading the project reflects the persisted settings.
    const got = (
      await t.app.inject({ method: "GET", url: "/api/projects/keeper-proj" })
    ).json();
    expect(got.project.permissionMode).toBe("plan");
    expect(got.project.maxTurns).toBe(42);
    expect(got.project.docker).toBe(true);
  });

  it("rejects invalid keeper settings on PATCH with 400 (issue #12)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Bad Keeper" } });
    const bad = [
      { permissionMode: "yolo" },
      { maxTurns: 0 },
      { maxTurns: 9999 },
      { maxTurns: 1.5 },
      { docker: "yes" },
      // maxSpawnDepth out-of-range / non-integer (issue #262).
      { maxSpawnDepth: -1 },
      { maxSpawnDepth: 9 },
      { maxSpawnDepth: 1.5 },
      { maxSpawnDepth: "1" },
    ];
    for (const payload of bad) {
      const res = await t.app.inject({
        method: "PATCH",
        url: "/api/projects/bad-keeper",
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("PATCHes a maxSpawnDepth override and clears it back to inherit (issue #262)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Spawn Proj" } });
    // Set a per-project override (0 is a valid override — disables spawned tools).
    const set = (
      await t.app.inject({
        method: "PATCH",
        url: "/api/projects/spawn-proj",
        payload: { maxSpawnDepth: 2 },
      })
    ).json();
    expect(set.project.maxSpawnDepth).toBe(2);
    // `null` clears it — the DTO drops the field so it inherits the instance default.
    const cleared = (
      await t.app.inject({
        method: "PATCH",
        url: "/api/projects/spawn-proj",
        payload: { maxSpawnDepth: null },
      })
    ).json();
    expect(cleared.project.maxSpawnDepth).toBeUndefined();
  });

  it("PATCHes a per-project models allow-list and clears it back to inherit (#457)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Models Proj" } });
    // A valid subset of the instance list (full catalog by default) is accepted;
    // the override preserves the requested order (set membership — order is not
    // load-bearing; the web resolves offered = instance list filtered to it).
    const set = (
      await t.app.inject({
        method: "PATCH",
        url: "/api/projects/models-proj",
        payload: { models: ["claude-sonnet-5", "claude-opus-5"] },
      })
    ).json();
    expect(set.project.models).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    // Re-reading reflects the persisted override.
    const got = (
      await t.app.inject({ method: "GET", url: "/api/projects/models-proj" })
    ).json();
    expect(got.project.models).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    // `null` clears it — the DTO drops the field so it offers the instance list.
    const cleared = (
      await t.app.inject({
        method: "PATCH",
        url: "/api/projects/models-proj",
        payload: { models: null },
      })
    ).json();
    expect(cleared.project.models).toBeUndefined();
  });

  it("rejects an unknown id in a per-project models allow-list with 400 (#457)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Bad Models" } });
    const res = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/bad-models",
      payload: { models: ["claude-opus-5", "gpt-4"] },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The one property this route must never break: **a PATCH cannot move a
   * project's working directory.**
   *
   * `workingDirFor()` reads exactly three fields — `path`, `managed` and `repo` —
   * and the cwd it produces is baked into every transcript path, so moving it
   * strands the project's whole history on a directory nothing points at any
   * more. `path` and `managed` were already re-asserted from the current record;
   * `repo` fed the same function and was missed (#718), which is why this asserts
   * the PROPERTY rather than the three fields one at a time.
   */
  it("PATCH cannot move workingDir — path, managed and repo are all immutable (#718)", async () => {
    const created = (
      await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Immutable" } })
    ).json().project;
    const { workingDir, contentDir, dir } = created;
    expect(workingDir).toBe(dir);

    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const YAML = (await import("yaml")).default;
    const readYaml = async () =>
      YAML.parse(await fs.readFile(path.join(dir, "project.yaml"), "utf8"));

    // The first body is #718's reproduction verbatim: a value that is not a URL
    // at all, which `create()` and `promote()` both refuse via isValidRepoUrl().
    // It used to 200 and relocate BOTH dirs to `<dir>/not-a-url-at-all--rm--rf`,
    // which does not exist — every turn afterwards hung 60s waiting for a session
    // file and failed, with the existing chats stranded on the old cwd.
    const bodies = [
      { repo: "not a url at all ;rm -rf /" },
      { repo: "https://github.com/owner/other.git" },
      { path: "/tmp/somewhere-else" },
      { managed: false },
      { repo: "https://github.com/o/r.git", managed: false, path: "/tmp/x" },
    ];
    for (const payload of bodies) {
      const label = JSON.stringify(payload);
      const res = await t.app.inject({
        method: "PATCH",
        url: "/api/projects/immutable",
        payload,
      });
      expect(res.statusCode, label).toBe(200);
      const project = res.json().project;
      expect(project.workingDir, label).toBe(workingDir);
      expect(project.contentDir, label).toBe(contentDir);
      expect(project.managed, label).toBe(true);
      expect(project.repo, label).toBeUndefined();
      expect(project.path, label).toBeUndefined();
      // On disk too — the DTO hides fields the yaml carries, which is exactly why
      // #721 was invisible from the UI.
      const yaml = await readYaml();
      expect(yaml.repo, label).toBeUndefined();
      expect(yaml.path, label).toBeUndefined();
      expect(yaml.managed, label).toBe(true);
    }

    // A re-GET agrees, and the working dir still exists — #718's symptom was a
    // cwd pointing at a directory nothing ever created.
    const got = (
      await t.app.inject({ method: "GET", url: "/api/projects/immutable" })
    ).json().project;
    expect(got.workingDir).toBe(workingDir);
    await expect(fs.stat(got.workingDir)).resolves.toBeTruthy();
  });

  it("PATCH drops unknown body keys instead of persisting them verbatim (#721)", async () => {
    const created = (
      await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Allowlist" } })
    ).json().project;

    const res = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/allowlist",
      payload: {
        // A legitimate field in the SAME body must still apply — the allowlist
        // filters the body, it does not reject it.
        summary: "kept",
        bogusKey: "hello-audit",
        nested: { a: [1, 2, { b: "c" }] },
        // Derived DTO fields are not on-disk fields; a forged one used to land in
        // project.yaml alongside the value the store computes.
        contentDir: "/tmp/evil",
        dir: "/tmp/evil",
        hasOverview: true,
        // Identity, and fields owned by their own endpoints.
        slug: "hijacked",
        started: "1999-01-01",
        pinned: ["../../etc/passwd"],
        triggers: { evil: { kind: "schedule" } },
      },
    });
    expect(res.statusCode).toBe(200);
    const project = res.json().project;
    expect(project.summary).toBe("kept");
    expect(project.slug).toBe("allowlist");

    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const YAML = (await import("yaml")).default;
    const yaml = YAML.parse(await fs.readFile(path.join(created.dir, "project.yaml"), "utf8"));
    expect(yaml.summary).toBe("kept");
    expect(yaml.slug).toBe("allowlist");
    expect(yaml.started).toBe(created.started);
    // `pinned` IS an on-disk field — owned by /pins, not patchable here.
    expect(yaml.pinned).toEqual([]);
    for (const key of ["bogusKey", "nested", "contentDir", "dir", "hasOverview", "triggers"]) {
      expect(Object.hasOwn(yaml, key), key).toBe(false);
    }
  });

  it("pins and unpins a file", async () => {
    const created = (
      await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Pin Proj" } })
    ).json().project;
    // Write a file into the project dir, then pin it.
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.writeFile(path.join(created.dir, "notes.md"), "# notes", "utf8");

    const pin = await t.app.inject({
      method: "PUT",
      url: "/api/projects/pin-proj/pins",
      payload: { file: "notes.md" },
    });
    expect(pin.statusCode).toBe(200);
    expect(pin.json().project.pinned).toEqual(["notes.md"]);

    const unpin = await t.app.inject({
      method: "DELETE",
      url: "/api/projects/pin-proj/pins/notes.md",
    });
    expect(unpin.json().project.pinned).toEqual([]);
  });
});

/**
 * A separate app whose instance offered-models allow-list is NARROWED via
 * `PADDOCK_MODELS` (issue #457 Step 2): `/api/models` reflects the allow-list +
 * the effective keeper default, and a per-project override may only subset it.
 */
describe("integration: instance models allow-list (#457)", () => {
  let t: TestApp;

  beforeAll(async () => {
    // Narrow to two models, keeper default (opus-5) deliberately EXCLUDED so the
    // effective default falls to the first offered model.
    t = await startTestApp({ models: ["claude-sonnet-5", "claude-haiku-4-5-20251001"] });
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("GET /api/models reflects the allow-list + the effective keeper default", async () => {
    const body = (await t.app.inject({ method: "GET", url: "/api/models" })).json();
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    // Keeper default (opus-5) isn't offered → the first offered model wins.
    expect(body.defaultModel).toBe("claude-sonnet-5");
  });

  it("accepts a per-project subset but rejects an id the instance hides (#457)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Subset Proj" } });
    // Within the instance list → accepted.
    const ok = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/subset-proj",
      payload: { models: ["claude-sonnet-5"] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project.models).toEqual(["claude-sonnet-5"]);
    // A known catalog model the INSTANCE doesn't offer → 400 (can't widen).
    const bad = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/subset-proj",
      payload: { models: ["claude-opus-5"] },
    });
    expect(bad.statusCode).toBe(400);
  });
});
