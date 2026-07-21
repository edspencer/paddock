import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

const run = promisify(execFile);

/**
 * A local git repo (no network) a project can be promoted onto — carries its OWN
 * CLAUDE.md so we can prove the checkout is real. A plain path is a valid repo URL.
 */
async function makeSourceRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main", dir]);
  await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Upstream Repo\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", [
    "-C", dir,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "init",
  ]);
  return dir;
}

describe("integration: promote notebook → repo-backed over REST (issue #213)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("promotes in place, keeps metadata, and re-registers the keeper at the checkout", async () => {
    const src = await makeSourceRepo(path.join(t.tmp, "_src", "demo.git"));

    // Create a notebook project with a bit of curated metadata.
    const created = (
      await t.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Promote Me", summary: "planning notes" },
      })
    ).json().project;
    expect(created.repoBacked).toBe(false);
    expect(created.workingDir).toBe(created.dir);

    // Promote.
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/promote-me/promote",
      payload: { repo: src },
    });
    expect(res.statusCode).toBe(200);
    const p = res.json().project;
    expect(p.repoBacked).toBe(true);
    expect(p.repo).toBe(src);
    expect(p.workingDir).toBe(path.join(p.dir, "demo"));

    // The repo was actually cloned into the checkout.
    expect(await fs.readFile(path.join(p.workingDir, "CLAUDE.md"), "utf8")).toContain("Upstream Repo");
    // The notebook's CLAUDE.md was dropped (defer to the repo's own).
    await expect(fs.access(path.join(p.dir, "CLAUDE.md"))).rejects.toBeTruthy();

    // The keeper still registered (re-registered at the new cwd) + transcript symlink.
    const fleet = (await t.app.inject({ method: "GET", url: "/api/fleet" })).json();
    const names = (fleet.agents as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain("keeper-promote-me");

    // GET reflects the promotion + preserves the sidecar metadata (changelog).
    const got = (await t.app.inject({ method: "GET", url: "/api/projects/promote-me" })).json();
    expect(got.project.repoBacked).toBe(true);
    expect(got.project.summary).toBe("planning notes");
    expect(got.changelog).toContain("Project opened.");
  });

  it("rejects promoting an already-repo-backed project (400)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/promote-me/promote",
      payload: { repo: path.join(t.tmp, "_src", "demo.git") },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing repo body (400) and an unknown project (404)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Bare NB" } });
    const noRepo = await t.app.inject({
      method: "POST",
      url: "/api/projects/bare-nb/promote",
      payload: {},
    });
    expect(noRepo.statusCode).toBe(400);

    const ghost = await t.app.inject({
      method: "POST",
      url: "/api/projects/ghost/promote",
      payload: { repo: "/tmp/whatever.git" },
    });
    expect(ghost.statusCode).toBe(404);
  });

  it("rolls back a failed clone, leaving the notebook intact (400)", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Survivor NB" } });
    const bogus = path.join(t.tmp, "_src", "does-not-exist.git");
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/survivor-nb/promote",
      payload: { repo: bogus },
    });
    expect(res.statusCode).toBe(400);
    // Still a notebook, no stray checkout, CLAUDE.md intact.
    const got = (await t.app.inject({ method: "GET", url: "/api/projects/survivor-nb" })).json();
    expect(got.project.repoBacked).toBe(false);
    await expect(fs.access(path.join(got.project.dir, "CLAUDE.md"))).resolves.toBeUndefined();
  });
});
