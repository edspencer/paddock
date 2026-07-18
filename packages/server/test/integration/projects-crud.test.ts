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
    // The fleet should have initialized; scratch agent registered.
    expect(body.status).toBeTruthy();
    const agentNames = (body.agents as Array<{ name: string }>).map((a) => a.name);
    expect(agentNames).toContain("scratch");
  });

  it("exposes the static model list", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keeperDefault).toBe("claude-opus-4-8");
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
