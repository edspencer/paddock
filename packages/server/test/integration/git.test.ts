import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

/**
 * Git backing-store features over REST against a REAL temp git repo (the
 * projects root is `git init`'d by the harness). Covers status (clean +
 * dirty), diff, and commit.
 */
describe("integration: git status/diff/commit (real git repo)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ gitRepo: true });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Git Proj" } });
    // Commit the freshly-created project dir so the next change is detectable.
    await t.app.inject({
      method: "POST",
      url: "/api/projects/git-proj/git/commit",
      payload: { message: "add project" },
    });
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("reports repo + branch and a clean subtree", async () => {
    const status = (
      await t.app.inject({ method: "GET", url: "/api/projects/git-proj/git/status" })
    ).json();
    expect(status.repo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.clean).toBe(true);
    expect(status.files).toEqual([]);
  });

  it("reports an untracked + a modified file in the project subtree", async () => {
    const project = (
      await t.app.inject({ method: "GET", url: "/api/projects/git-proj" })
    ).json().project;
    // New untracked file.
    await fs.writeFile(path.join(project.dir, "new.md"), "# new", "utf8");
    // Modify a tracked file (CHANGELOG.md was committed at setup).
    await fs.appendFile(path.join(project.dir, "CHANGELOG.md"), "\n- a change\n", "utf8");

    const status = (
      await t.app.inject({ method: "GET", url: "/api/projects/git-proj/git/status" })
    ).json();
    expect(status.clean).toBe(false);
    const byPath = Object.fromEntries(
      status.files.map((f: { path: string; untracked: boolean }) => [f.path, f]),
    );
    expect(byPath["new.md"].untracked).toBe(true);
    expect(byPath["CHANGELOG.md"].untracked).toBe(false);
  });

  it("produces a unified diff for the tracked change", async () => {
    const diff = await t.app.inject({
      method: "GET",
      url: "/api/projects/git-proj/git/diff",
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.headers["content-type"]).toContain("text/plain");
    expect(diff.body).toContain("CHANGELOG.md");
    expect(diff.body).toContain("+- a change");
  });

  it("commits the project subtree and returns a hash; a second commit is a no-op", async () => {
    const commit = (
      await t.app.inject({
        method: "POST",
        url: "/api/projects/git-proj/git/commit",
        payload: { message: "save work" },
      })
    ).json();
    expect(commit.committed).toBe(true);
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);

    // Now clean.
    const status = (
      await t.app.inject({ method: "GET", url: "/api/projects/git-proj/git/status" })
    ).json();
    expect(status.clean).toBe(true);

    // Nothing to commit → committed:false.
    const noop = (
      await t.app.inject({
        method: "POST",
        url: "/api/projects/git-proj/git/commit",
        payload: { message: "nothing" },
      })
    ).json();
    expect(noop.committed).toBe(false);
  });

  it("the fleet-level /api/git reports the repo", async () => {
    const git = (await t.app.inject({ method: "GET", url: "/api/git" })).json();
    expect(git.repo).toBe(true);
    expect(git.branch).toBe("main");
    expect(git.github).toBeTruthy();
  });
});

describe("integration: git features hidden when the store is not a repo", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp(); // no gitRepo
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "No Git" } });
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("reports repo:false (UI hides the git affordance)", async () => {
    const status = (
      await t.app.inject({ method: "GET", url: "/api/projects/no-git/git/status" })
    ).json();
    expect(status.repo).toBe(false);
    const git = (await t.app.inject({ method: "GET", url: "/api/git" })).json();
    expect(git.repo).toBe(false);
  });
});
