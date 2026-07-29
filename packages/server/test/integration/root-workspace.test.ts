import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

/**
 * The workspace model (#531) over the REAL app.
 *
 * The root workspace always exists — no `project.yaml`, no creation endpoint,
 * no gate — and it is served by literally the same handlers a project is,
 * because the workspace-scoped route group is registered TWICE:
 *
 *   /api/root            → workspace key ""
 *   /api/projects/:slug  → workspace key params.slug
 *
 * "The root behaves exactly like a project" is therefore true by construction,
 * and the dual-mount test below is the assertion of that construction, not a
 * convenience check.
 */
describe("integration: the root workspace (#531)", () => {
  let t: TestApp;

  /** The workspace-scoped suffixes that must answer identically at both mounts. */
  const SCOPED = ["", "/chats", "/files", "/git/status", "/triggers"] as const;

  beforeAll(async () => {
    t = await startTestApp();
    // One ordinary project to mount the parametric half against.
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Alpha" } });
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("serves the root on a FRESH instance with no <projectsRoot>/project.yaml", async () => {
    // The load-bearing claim of the whole model. The old design gated the root on
    // a record and shipped an Enable card + "Project not found: __root" on every
    // fresh instance; there is nothing to create now.
    await expect(fs.access(path.join(t.projectsRoot, "project.yaml"))).rejects.toBeTruthy();

    const res = await t.app.inject({ method: "GET", url: "/api/root" });
    expect(res.statusCode).toBe(200);
    const { project, chats } = res.json();
    expect(project.slug).toBe("");
    expect(project.dir).toBe(t.projectsRoot);
    expect(project.workingDir).toBe(t.projectsRoot);
    expect(project.repoBacked).toBe(false);
    // Name defaults to the projects-root directory basename.
    expect(project.name).toBe(path.basename(t.projectsRoot));
    // An ordinary workspace detail payload: project + changelog + chats.
    expect(Array.isArray(chats)).toBe(true);
  });

  it("registers keeper-_root + sweeper-_root at boot, with no creation step", async () => {
    const fleet = (await t.app.inject({ method: "GET", url: "/api/fleet" })).json();
    const names = (fleet.agents as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain("keeper-_root");
    expect(names).toContain("sweeper-_root");
    // …and the root's transcripts are gitignored, as every workspace's are.
    expect(await fs.readFile(path.join(t.projectsRoot, ".gitignore"), "utf8")).toContain(
      "/.chats/",
    );
  });

  it("has NO creation endpoint — the old /api/root-project surface is gone", async () => {
    // Existence is not a thing you opt into any more, so neither route exists.
    expect((await t.app.inject({ method: "GET", url: "/api/root-project" })).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: "POST", url: "/api/root-project", payload: {} })).statusCode,
    ).toBe(404);
  });

  it("answers the SAME workspace endpoints at /api/root and /api/projects/:slug", async () => {
    // This is the architectural guarantee: one plugin, two mounts, identical
    // handlers and identical response shapes. A route that exists on only one of
    // them is a bug in the mount, not a missing feature.
    for (const suffix of SCOPED) {
      const rootRes = await t.app.inject({ method: "GET", url: `/api/root${suffix}` });
      const projRes = await t.app.inject({ method: "GET", url: `/api/projects/alpha${suffix}` });
      expect(rootRes.statusCode, `GET /api/root${suffix}`).toBe(200);
      expect(projRes.statusCode, `GET /api/projects/alpha${suffix}`).toBe(200);
      // Same handler ⇒ same payload shape.
      expect(Object.keys(rootRes.json()).sort(), `shape of ${suffix}`).toEqual(
        Object.keys(projRes.json()).sort(),
      );
    }
  });

  it("scopes each mount to ITS OWN workspace — same handler, different key", async () => {
    const rootFiles = (await t.app.inject({ method: "GET", url: "/api/root/files" })).json();
    const rootNames = (rootFiles.entries as Array<{ name: string }>).map((f) => f.name);
    // The root keeper's cwd contains every project — deliberately omniscient.
    expect(rootNames).toContain("alpha");

    const alphaFiles = (
      await t.app.inject({ method: "GET", url: "/api/projects/alpha/files" })
    ).json();
    const alphaNames = (alphaFiles.entries as Array<{ name: string }>).map((f) => f.name);
    expect(alphaNames).toContain("project.yaml");
    expect(alphaNames).not.toContain("alpha");

    // And the detail route reports each workspace's own identity.
    const rootProject = (await t.app.inject({ method: "GET", url: "/api/root" })).json().project;
    const alphaProject = (
      await t.app.inject({ method: "GET", url: "/api/projects/alpha" })
    ).json().project;
    expect(rootProject.slug).toBe("");
    expect(alphaProject.slug).toBe("alpha");
    expect(alphaProject.dir).toBe(path.join(t.projectsRoot, "alpha"));
  });

  it("keeps the root out of GET /api/projects — enumeration lists CHILDREN", async () => {
    const list = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    const slugs = (list.projects as Array<{ slug: string }>).map((p) => p.slug);
    expect(slugs).toContain("alpha");
    expect(slugs).not.toContain("");
    expect(slugs).not.toContain("__root");
  });

  it("leaks no root sentinel into the projects namespace", async () => {
    // Nothing named `__root` (or `_root`) is addressable as a project: those are
    // agent-namespace encodings, not identities. A clean 404, never a 500.
    for (const slug of ["__root", "_root"]) {
      const res = await t.app.inject({ method: "GET", url: `/api/projects/${slug}` });
      expect(res.statusCode, slug).toBe(404);
    }
  });

  it("accepts ordinary metadata edits on the root, writing project.yaml lazily", async () => {
    const patch = await t.app.inject({
      method: "PATCH",
      url: "/api/root",
      payload: { summary: "edited from the settings pane" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().project.summary).toBe("edited from the settings pane");
    // Only NOW does a record exist at the projects root.
    await fs.access(path.join(t.projectsRoot, "project.yaml"));
    const reread = (await t.app.inject({ method: "GET", url: "/api/root" })).json().project;
    expect(reread.summary).toBe("edited from the settings pane");
  });

  it("refuses to DELETE the root — its dir is the whole projects root", async () => {
    const del = await t.app.inject({ method: "DELETE", url: "/api/root" });
    expect(del.statusCode).toBe(400);
    // Everything survives.
    await fs.access(path.join(t.projectsRoot, "project.yaml"));
    const list = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    expect((list.projects as Array<{ slug: string }>).map((p) => p.slug)).toContain("alpha");
  });

  it("refuses to PROMOTE the root to repo-backed", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/root/promote",
      payload: { repo: "/tmp/some-repo" },
    });
    expect(res.statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/root" })).json().project.repoBacked).toBe(
      false,
    );
  });

  it("survives a restart: the root keeper is re-registered at boot", async () => {
    // The root is invisible to list(), so boot must resolve it explicitly.
    const { buildApp } = await import("../../src/app.js");
    const rebuilt = await buildApp({ serveStatic: false });
    await rebuilt.app.ready();
    try {
      const fleet = (await rebuilt.app.inject({ method: "GET", url: "/api/fleet" })).json();
      const names = (fleet.agents as Array<{ name: string }>).map((a) => a.name);
      expect(names).toContain("keeper-_root");
      // …and it still serves.
      expect((await rebuilt.app.inject({ method: "GET", url: "/api/root" })).statusCode).toBe(200);
    } finally {
      await rebuilt.close().catch(() => undefined);
    }
  });
});
