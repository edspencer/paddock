/**
 * The Changes tab and file browser when a project's `workingDir` is a linked git
 * WORKTREE (issue #710).
 *
 * A worktree is the obvious thing to point `path:` at — it is exactly the "I
 * already have this checked out" case #206 exists for — and it is the shape that
 * breaks the most assumptions at once: `.git` is a FILE holding a `gitdir:`
 * pointer rather than a directory, the real config lives outside the working
 * directory entirely, and the branch is per-worktree. #709 moved status/diff/
 * commit onto `workingDir` without anything exercising that shape.
 *
 * These drive the REAL routes against a REAL worktree, and they are weighted
 * toward the property the ticket cared about most: **every surface in the
 * Changes tab must describe ONE repository** — the one the project works in.
 * Three of them did not, and each failure was silent rather than loud (a 404 in
 * the pane, a Push button acting on Paddock's own notes repo).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const run = promisify(execFile);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

describe("integration: workingDir is a linked git worktree (#710)", () => {
  let t: TestApp;
  /** Holds the bare origin + the main checkout + the worktree, all OUTSIDE the store. */
  let outer: string;
  let origin: string;
  let checkout: string;
  let worktree: string;

  beforeAll(async () => {
    t = await startTestApp({ gitRepo: true });
    outer = await makeTmpDir("paddock-wt-");
    // A real remote, so ahead/behind and push are answerable rather than stubbed.
    origin = path.join(outer, "origin.git");
    await run("git", ["init", "-q", "--bare", "-b", "main", origin]);
    checkout = path.join(outer, "checkout");
    await run("git", ["clone", "-q", origin, checkout]);
    await fs.writeFile(path.join(checkout, "README.md"), "# real work\n");
    await run("git", ["-C", checkout, "add", "-A"]);
    await run("git", ["-C", checkout, ...ID, "commit", "-q", "-m", "init"]);
    await run("git", ["-C", checkout, "push", "-q", "-u", "origin", "main"]);
    // …and the worktree the project links, on its own branch.
    worktree = path.join(outer, "feature-wt");
    await run("git", ["-C", checkout, "worktree", "add", "-q", "-b", "feature-x", worktree]);

    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Worktree Proj", path: worktree },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().project.workingDir).toBe(worktree);
  });

  afterAll(async () => {
    await run("git", ["-C", checkout, "worktree", "remove", "--force", worktree]).catch(
      () => undefined,
    );
    await rmTmpDir(outer);
    await t.teardown();
  });

  /** `.git` really is a file here — the premise the rest of the file rests on. */
  it("the linked directory is a worktree: .git is a FILE, not a directory", async () => {
    expect((await fs.lstat(path.join(worktree, ".git"))).isFile()).toBe(true);
    expect(await fs.readFile(path.join(worktree, ".git"), "utf8")).toMatch(/^gitdir: /);
  });

  it("status reports the WORKTREE's branch, not the main checkout's", async () => {
    const status = (
      await t.app.inject({ method: "GET", url: "/api/projects/worktree-proj/git/status" })
    ).json();
    expect(status.repo).toBe(true);
    expect(status.branch).toBe("feature-x");
    expect(status.clean).toBe(true);
    // The main checkout is on `main` and is untouched by any of this.
    const mainBranch = (
      await run("git", ["-C", checkout, "rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    expect(mainBranch).toBe("main");
  });

  it("status + diff see changes made in the worktree", async () => {
    await fs.appendFile(path.join(worktree, "README.md"), "a change\n", "utf8");
    await fs.writeFile(path.join(worktree, "brand-new.md"), "# hello\nsecond line\n", "utf8");
    // A dot-DIRECTORY the file-browser guard would refuse but git happily reports.
    await fs.mkdir(path.join(worktree, ".github", "workflows"), { recursive: true });
    await fs.writeFile(path.join(worktree, ".github", "workflows", "ci.yml"), "on: push\n");

    const status = (
      await t.app.inject({ method: "GET", url: "/api/projects/worktree-proj/git/status" })
    ).json();
    expect(status.clean).toBe(false);
    const byPath = Object.fromEntries(
      status.files.map((f: { path: string }) => [f.path, f]),
    );
    expect(byPath["README.md"].untracked).toBe(false);
    expect(byPath["brand-new.md"]).toMatchObject({ untracked: true, added: 2 });
    expect(byPath[".github/workflows/ci.yml"].untracked).toBe(true);

    const diff = await t.app.inject({
      method: "GET",
      url: "/api/projects/worktree-proj/git/diff",
    });
    expect(diff.body).toContain("+a change");
  });

  // --- the untracked-file view (#710's first defect) ----------------------
  // The pane renders a new file's CONTENT in place of a diff. It fetched that
  // from the metadata-dir `/files/:name` surface, which for a linked project is
  // a different directory entirely — so every new file rendered "File not found".

  it("serves an untracked file's content from the WORKING directory", async () => {
    const r = await t.app.inject({
      method: "GET",
      url: "/api/projects/worktree-proj/git/file?path=brand-new.md",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: "markdown", content: "# hello\nsecond line\n" });
  });

  it("serves an untracked file under a DOT directory — the pane lists it, so it must render", async () => {
    // The `/files/` guard refuses any path descending through a dot directory,
    // which is right for the metadata dir and wrong here: `.github/workflows/…`
    // is an ordinary new file. Git's own answer is the gate instead.
    const r = await t.app.inject({
      method: "GET",
      url: "/api/projects/worktree-proj/git/file?path=.github%2Fworkflows%2Fci.yml",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().content).toBe("on: push\n");
  });

  it("refuses anything git does not report as untracked — .git, tracked files, escapes", async () => {
    // `.git` is a FILE in a worktree, so it is a LEAF, and the `/files/` guard
    // deliberately lets a dotfile leaf through (an untracked `.gitignore` has to
    // render). Under that rule this would have disclosed the main checkout's
    // gitdir path. Git never reports `.git`, so the git-backed gate refuses it.
    for (const p of [
      ".git", // the worktree pointer file
      ".git/config", // no such path here, but must not resolve either way
      "README.md", // tracked and modified — has a diff, not a content view
      "../checkout/README.md", // escape to the main checkout
      "/etc/passwd", // absolute escape
    ]) {
      const r = await t.app.inject({
        method: "GET",
        url: `/api/projects/worktree-proj/git/file?path=${encodeURIComponent(p)}`,
      });
      expect(r.statusCode, p).toBe(404);
    }
  });

  it("refuses an IGNORED file, which git also declines to report", async () => {
    await fs.writeFile(path.join(worktree, ".gitignore"), "secrets.env\n", "utf8");
    await fs.writeFile(path.join(worktree, "secrets.env"), "TOKEN=hunter2\n", "utf8");
    const r = await t.app.inject({
      method: "GET",
      url: "/api/projects/worktree-proj/git/file?path=secrets.env",
    });
    expect(r.statusCode).toBe(404);
    // …while the untracked `.gitignore` beside it renders, as it always has.
    const ok = await t.app.inject({
      method: "GET",
      url: "/api/projects/worktree-proj/git/file?path=.gitignore",
    });
    expect(ok.statusCode).toBe(200);
  });

  // --- remote + push (#710's second defect) -------------------------------
  // These were hard-wired to `projectsRoot` while the header beside them showed
  // the worktree's branch — so the pane invited you to push the wrong repo.

  it("remote describes the WORKTREE's origin and branch, not the backing store's", async () => {
    const info = (
      await t.app.inject({ method: "GET", url: "/api/projects/worktree-proj/git/remote" })
    ).json();
    expect(info).toMatchObject({ repo: true, configured: true, url: origin, branch: "feature-x" });
    // The fleet-level route still speaks for the store, and the two disagree —
    // which is the whole point: the per-project header must use the former.
    const fleet = (await t.app.inject({ method: "GET", url: "/api/git" })).json();
    expect(fleet.branch).not.toBe("feature-x");
    // GitHub connection state is genuinely fleet-level and rides along on both.
    expect(info.github).toEqual(fleet.github);
  });

  it("commit lands on the worktree's branch, and push sends it to the worktree's origin", async () => {
    const commit = (
      await t.app.inject({
        method: "POST",
        url: "/api/projects/worktree-proj/git/commit",
        payload: { message: "work on the feature branch" },
      })
    ).json();
    expect(commit.committed).toBe(true);
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);

    // The commit is on feature-x in the worktree; the main checkout is untouched.
    const head = (await run("git", ["-C", worktree, "log", "-1", "--format=%H%d"])).stdout;
    expect(head).toContain(commit.hash);
    expect(head).toContain("feature-x");
    const mainLog = (await run("git", ["-C", checkout, "log", "--oneline"])).stdout;
    expect(mainLog).not.toContain(commit.hash.slice(0, 7));

    const push = (
      await t.app.inject({ method: "POST", url: "/api/projects/worktree-proj/git/push" })
    ).json();
    expect(push).toMatchObject({ pushed: true });
    // The BRANCH the user was looking at is the one that reached the remote.
    const remoteBranches = (await run("git", ["-C", origin, "branch", "--list"])).stdout;
    expect(remoteBranches).toContain("feature-x");
    const remoteHead = (
      await run("git", ["-C", origin, "rev-parse", "feature-x"])
    ).stdout.trim();
    expect(remoteHead).toBe(commit.hash);
  });

  // --- the grid badge (#710's item 3) -------------------------------------

  it("the projects grid counts a linked worktree's uncommitted files", async () => {
    // `dirtyCounts()` buckets one store-wide `git status` by first path segment,
    // so it structurally cannot see a directory outside the store. The list route
    // falls back to `dirtyCountAt(workingDir)` for exactly those projects (#206).
    await fs.writeFile(path.join(worktree, "after-commit.md"), "more\n", "utf8");
    const list = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    const wt = list.projects.find((p: { slug: string }) => p.slug === "worktree-proj");
    expect(wt.workingDir).toBe(worktree);
    expect(wt.dirty).toBeGreaterThan(0);
  });

  // --- repo detection (#710's item 4) --------------------------------------

  it("repo-ness is answered per directory, so a non-repo link stays a non-repo", async () => {
    const plain = path.join(outer, "not-a-repo");
    await fs.mkdir(plain, { recursive: true });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Plain Link", path: plain },
    });
    const status = (
      await t.app.inject({ method: "GET", url: "/api/projects/plain-link/git/status" })
    ).json();
    // The store IS a repo and the worktree IS a repo; neither leaks into this one.
    expect(status).toMatchObject({ repo: false, clean: true, files: [] });
    const remote = (
      await t.app.inject({ method: "GET", url: "/api/projects/plain-link/git/remote" })
    ).json();
    expect(remote).toMatchObject({ repo: false, configured: false });
    const push = (
      await t.app.inject({ method: "POST", url: "/api/projects/plain-link/git/push" })
    ).json();
    expect(push).toMatchObject({ pushed: false, error: "not a repo" });
  });

  // --- the file browser (#710's item 2, second half) -----------------------

  it("the file browser still shows the project's NOTES, and never the linked tree", async () => {
    // An UNMANAGED project's curated files are sidecarred in the metadata dir and
    // Paddock writes nothing into the user's checkout — so the Files tab is
    // deliberately not a code browser here. It must also not become one by
    // accident: nothing in the worktree may be reachable through it.
    const listed = (
      await t.app.inject({ method: "GET", url: "/api/projects/worktree-proj/files" })
    ).json();
    const names = listed.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("project.yaml");
    expect(names).not.toContain("README.md");
    expect(names).not.toContain("brand-new.md");
    const leak = await t.app.inject({
      method: "GET",
      url: "/api/projects/worktree-proj/files/brand-new.md",
    });
    expect(leak.statusCode).toBe(404);
  });
});

/**
 * A MANAGED project with a `path:` keeps its curated trio OUT at that path
 * (`contentDirFor`), and the file browser must follow it there (#710). It
 * joined `projectsRoot + slug` instead, so the Files tab listed a directory
 * holding nothing but `project.yaml` and every note 404'd.
 */
describe("integration: the file browser follows a managed project's content dir (#710)", () => {
  let t: TestApp;
  let notes: string;

  beforeAll(async () => {
    t = await startTestApp({ gitRepo: true });
    notes = path.join(await makeTmpDir("paddock-managed-"), "my-notes");
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Managed Path", path: notes, managed: true },
    });
  });
  afterAll(async () => {
    await rmTmpDir(path.dirname(notes));
    await t.teardown();
  });

  it("lists and reads the curated files where they actually live", async () => {
    // Paddock seeds CLAUDE.md + CHANGELOG.md into the nominated path on create.
    expect(await fs.readdir(notes)).toEqual(expect.arrayContaining(["CLAUDE.md", "CHANGELOG.md"]));
    const listed = (
      await t.app.inject({ method: "GET", url: "/api/projects/managed-path/files" })
    ).json();
    const names = listed.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("CLAUDE.md");
    expect(names).toContain("CHANGELOG.md");

    const file = await t.app.inject({
      method: "GET",
      url: "/api/projects/managed-path/files/CLAUDE.md",
    });
    expect(file.statusCode).toBe(200);
    expect(file.json().content).toContain("Managed Path");
  });

  it("still refuses traversal out of the content dir", async () => {
    for (const p of ["..%2Fescaped.md", "%2Fetc%2Fpasswd"]) {
      const r = await t.app.inject({
        method: "GET",
        url: `/api/projects/managed-path/files/${p}`,
      });
      expect(r.statusCode, p).toBe(400);
    }
  });
});
