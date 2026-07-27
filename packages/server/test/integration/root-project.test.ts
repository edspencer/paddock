import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

/**
 * "The root is a project" (issue #516) — Phases 1+2 over the REAL app: the root
 * project resolves through the SAME `/api/projects/:slug/…` surface every other
 * project uses, its keeper is a real registered herdctl agent, and — the
 * load-bearing migration claim — an instance without a root project is byte-for-
 * byte unchanged.
 */
describe("integration: the root project (#516)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("reports no root project on a fresh instance, and registers no root keeper", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/root-project" });
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toBeNull();

    const fleet = (await t.app.inject({ method: "GET", url: "/api/fleet" })).json();
    const names = (fleet.agents as Array<{ name: string }>).map((a) => a.name);
    expect(names).not.toContain("keeper-__root__");

    // Nothing was seeded at the projects root — existence is the opt-in.
    await expect(fs.access(path.join(t.projectsRoot, "project.yaml"))).rejects.toBeTruthy();

    // A slug the user CAN'T create is still a clean 404, not a 500.
    const detail = await t.app.inject({ method: "GET", url: "/api/projects/__root__" });
    expect(detail.statusCode).toBe(404);
  });

  it("creates the root project and registers keeper-__root__ + sweeper-__root__", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/root-project",
      payload: { name: "Instance Root", summary: "everything, from the top" },
    });
    expect(create.statusCode).toBe(201);
    const project = create.json().project;
    expect(project.slug).toBe("__root__");
    expect(project.dir).toBe(t.projectsRoot);
    expect(project.workingDir).toBe(t.projectsRoot);
    expect(project.repoBacked).toBe(false);

    const fleet = (await t.app.inject({ method: "GET", url: "/api/fleet" })).json();
    const names = (fleet.agents as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain("keeper-__root__");
    expect(names).toContain("sweeper-__root__");

    // The record really is at the projects root, and .chats/ is gitignored there.
    await fs.access(path.join(t.projectsRoot, "project.yaml"));
    expect(await fs.readFile(path.join(t.projectsRoot, ".gitignore"), "utf8")).toContain(
      "/.chats/",
    );
  });

  it("refuses a second root project", async () => {
    const again = await t.app.inject({ method: "POST", url: "/api/root-project", payload: {} });
    expect(again.statusCode).toBe(409);
  });

  it("serves the root through the ordinary project detail + chat routes", async () => {
    const detail = await t.app.inject({ method: "GET", url: "/api/projects/__root__" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project.name).toBe("Instance Root");
    // An ordinary project detail payload: project + chats + changelog.
    expect(Array.isArray(detail.json().chats)).toBe(true);

    const chats = await t.app.inject({ method: "GET", url: "/api/projects/__root__/chats" });
    expect(chats.statusCode).toBe(200);
  });

  it("keeps the root out of GET /api/projects", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Alpha" } });
    const list = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    const slugs = (list.projects as Array<{ slug: string }>).map((p) => p.slug);
    expect(slugs).toContain("alpha");
    expect(slugs).not.toContain("__root__");
  });

  it("accepts ordinary metadata edits on the root", async () => {
    const patch = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/__root__",
      payload: { summary: "edited from the settings pane" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().project.summary).toBe("edited from the settings pane");
  });

  it("refuses to DELETE the root project — its dir is the whole projects root", async () => {
    const del = await t.app.inject({ method: "DELETE", url: "/api/projects/__root__" });
    expect(del.statusCode).toBe(400);
    // Everything survives.
    await fs.access(path.join(t.projectsRoot, "project.yaml"));
    const list = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    expect((list.projects as Array<{ slug: string }>).map((p) => p.slug)).toContain("alpha");
  });

  it("survives a restart: the root keeper is re-registered at boot", async () => {
    // The root is invisible to list(), so boot must resolve it explicitly.
    const { buildApp } = await import("../../src/app.js");
    const rebuilt = await buildApp({ serveStatic: false });
    await rebuilt.app.ready();
    try {
      const fleet = (await rebuilt.app.inject({ method: "GET", url: "/api/fleet" })).json();
      const names = (fleet.agents as Array<{ name: string }>).map((a) => a.name);
      expect(names).toContain("keeper-__root__");
    } finally {
      await rebuilt.close().catch(() => undefined);
    }
  });
});
