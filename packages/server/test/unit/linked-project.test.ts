/**
 * Linked projects (issue #206) — `path:` points a project's working directory at
 * a git checkout the user already has, used IN PLACE with no copy.
 *
 * The tests here are weighted toward one property above all others, because it is
 * the only one whose failure mode is destroying somebody's real work:
 *
 *   **Paddock never writes into, and never deletes, the linked directory.**
 *
 * Two of them assert that by fingerprinting the linked tree (every path, plus
 * every file's bytes and mtime) before and after an operation and demanding it
 * come back byte-identical — rather than by asserting the absence of the specific
 * files we happen to know about today. A future feature that starts writing a new
 * dotfile into the cwd fails these tests; an allow-list of known filenames would
 * not have noticed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import YAML from "yaml";
import {
  ProjectStore,
  ProjectError,
  workingDirFor,
  isPathInside,
} from "../../src/projects.js";
import { ensureProjectChats } from "../../src/transcripts.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const run = promisify(execFile);

/** A real git checkout, standing in for the user's `~/Code/foo`. */
async function makeCheckout(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main", dir]);
  await fs.writeFile(path.join(dir, "CLAUDE.md"), "# The user's own repo\n");
  await fs.writeFile(path.join(dir, "README.md"), "# real work\n");
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", [
    "-C", dir,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "init",
  ]);
  return dir;
}

/**
 * A fingerprint of a directory tree: every relative path, and for files their
 * bytes + mtime. Compared for EQUALITY across an operation, so any creation,
 * deletion or modification anywhere in the tree shows up as a diff.
 */
async function fingerprint(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(dir, rel);
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      const childAbs = path.join(dir, childRel);
      if (entry.isDirectory()) {
        out[childRel] = "dir";
        await walk(childRel);
      } else if (entry.isSymbolicLink()) {
        out[childRel] = `symlink:${await fs.readlink(childAbs)}`;
      } else {
        const st = await fs.stat(childAbs);
        const bytes = await fs.readFile(childAbs);
        out[childRel] = `file:${st.mtimeMs}:${bytes.toString("base64")}`;
      }
    }
  };
  await walk("");
  return out;
}

describe("workingDirFor / isPathInside with a linked path (issue #206)", () => {
  it("returns the linked path verbatim, and it WINS over repo", () => {
    expect(workingDirFor("/d/projects/p", undefined, "/home/ed/Code/foo")).toBe(
      "/home/ed/Code/foo",
    );
    // `path:` and `repo:` are deliberately NOT mutually exclusive (#206 findings
    // §4): a linked project may record a repo URL for the adoption remote-match
    // and as a DR re-clone hint, and it must not move the cwd.
    expect(
      workingDirFor("/d/projects/p", "https://github.com/o/foo.git", "/home/ed/Code/foo"),
    ).toBe("/home/ed/Code/foo");
    // Unchanged behaviour when absent.
    expect(workingDirFor("/d/projects/p", "https://github.com/o/foo.git")).toBe(
      "/d/projects/p/foo",
    );
    expect(workingDirFor("/d/projects/p")).toBe("/d/projects/p");
  });

  it("isPathInside does not treat a sibling with a shared prefix as a child", () => {
    expect(isPathInside("/data/projects/a", "/data/projects")).toBe(true);
    expect(isPathInside("/data/projects", "/data/projects")).toBe(true);
    // The bug a bare startsWith would have: `projects-old` is NOT under `projects`.
    expect(isPathInside("/data/projects-old", "/data/projects")).toBe(false);
    expect(isPathInside("/home/ed/Code/foo", "/data/projects")).toBe(false);
  });
});

describe("ProjectStore — linked projects (issue #206)", () => {
  let root: string;
  let dataDir: string;
  let checkout: string;
  let store: ProjectStore;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-data-");
    root = path.join(dataDir, "projects");
    await fs.mkdir(root, { recursive: true });
    checkout = await makeCheckout(path.join(await makeTmpDir("paddock-code-"), "foo"));
    store = new ProjectStore(root, dataDir);
    await store.init();
  });
  afterEach(async () => {
    await rmTmpDir(dataDir);
    await rmTmpDir(path.dirname(checkout));
  });

  // --- the headline property -------------------------------------------------

  it("creating a linked project writes ZERO files into the linked directory", async () => {
    const before = await fingerprint(checkout);

    const p = await store.create({ name: "Foo", path: checkout });

    expect(await fingerprint(checkout)).toEqual(before);
    // And specifically none of the things a repo-backed project would have got.
    for (const f of [".gitignore", ".chats", "CLAUDE.md.paddock", "project.yaml", ".paddock"]) {
      // `.gitignore`/`CLAUDE.md` may legitimately pre-exist in a real repo; the
      // fingerprint above is what proves we didn't touch them. These assert the
      // ones we know Paddock creates elsewhere are simply absent.
      if (f === ".gitignore" || f === "CLAUDE.md.paddock") continue;
      await expect(fs.access(path.join(checkout, f))).rejects.toThrow();
    }
    expect(p.workingDir).toBe(checkout);
  });

  it("transcripts land in <slug>/.chats/, not in the linked repo", async () => {
    const p = await store.create({ name: "Foo", path: checkout });
    const before = await fingerprint(checkout);
    const claudeHome = path.join(dataDir, "claude-home");

    // This is the call the keeper registration makes (`herdctl.ts`). The two-arg
    // split is the whole mechanism: cwd is the linked repo, the store is the
    // metadata dir.
    await ensureProjectChats(p.workingDir, p.dir, {
      path: claudeHome,
      transcripts: "own",
      userHome: path.join(dataDir, "user-claude"),
    });

    // The store exists in the METADATA dir …
    const st = await fs.lstat(path.join(p.dir, ".chats"));
    expect(st.isDirectory()).toBe(true);
    // … the encoded path in paddock's own home redirects to it …
    const encoded = path.join(claudeHome, "projects", p.workingDir.replace(/[^a-zA-Z0-9]/g, "-"));
    expect((await fs.lstat(encoded)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(encoded)).toBe(await fs.realpath(path.join(p.dir, ".chats")));
    // … and the linked repo is untouched.
    expect(await fingerprint(checkout)).toEqual(before);
  });

  it("removing a linked project deletes the metadata dir and NOT the linked directory", async () => {
    const p = await store.create({ name: "Foo", path: checkout });
    const before = await fingerprint(checkout);

    const removed = await store.remove(p.slug);

    expect(removed.slug).toBe(p.slug);
    await expect(fs.access(p.dir)).rejects.toThrow(); // metadata dir gone
    expect(await fingerprint(checkout)).toEqual(before); // real work intact
    // Belt and braces: the git repo still works.
    const { stdout } = await run("git", ["-C", checkout, "log", "--oneline"]);
    expect(stdout.trim()).toContain("init");
  });

  // --- DTO shape / round-trip ------------------------------------------------

  it("a linked project is UNMANAGED, with cwd = the linked dir and no seeded CLAUDE.md", async () => {
    const p = await store.create({ name: "Foo", path: checkout, summary: "linked" });

    expect(p.path).toBe(checkout);
    expect(p.workingDir).toBe(checkout);
    expect(p.dir).toBe(path.join(root, "foo"));
    // `managed: false` is what suppresses the sweeper's CLAUDE.md curation — the
    // linked repo owns its own, and the sweeper must never write it.
    expect(p.managed).toBe(false);
    // An unmanaged project's curated files stay sidecarred in the metadata dir.
    expect(p.contentDir).toBe(p.dir);
    expect(p.repo).toBeUndefined();

    // No per-project CLAUDE.md seeded, and no sidecar .gitignore (nothing nested).
    await expect(fs.access(path.join(p.dir, "CLAUDE.md"))).rejects.toThrow();
    await expect(fs.access(path.join(p.dir, ".gitignore"))).rejects.toThrow();
    // The metadata that DOES belong in the data repo is there.
    await expect(fs.access(path.join(p.dir, "CHANGELOG.md"))).resolves.toBeUndefined();
  });

  it("path round-trips through project.yaml", async () => {
    const p = await store.create({ name: "Foo", path: checkout });
    const raw = await fs.readFile(path.join(p.dir, "project.yaml"), "utf8");
    expect(YAML.parse(raw).path).toBe(checkout);

    const reread = await store.get(p.slug);
    expect(reread.path).toBe(checkout);
    expect(reread.workingDir).toBe(checkout);
    expect(reread.managed).toBe(false);
  });

  it("accepts a repo URL alongside path — the cwd stays the linked dir, no clone happens", async () => {
    const p = await store.create({
      name: "Foo",
      path: checkout,
      repo: "https://github.com/owner/foo.git",
    });
    expect(p.workingDir).toBe(checkout);
    expect(p.repo).toBe("https://github.com/owner/foo.git");
    // Nothing was cloned into the metadata dir.
    await expect(fs.access(path.join(p.dir, "foo"))).rejects.toThrow();
  });

  it("a linked path canonicalises symlinks, so the stored cwd is the real one", async () => {
    const link = path.join(await makeTmpDir("paddock-link-"), "alias");
    await fs.symlink(checkout, link);
    const p = await store.create({ name: "Foo", path: link });
    expect(p.path).toBe(checkout);
    await rmTmpDir(path.dirname(link));
  });

  // --- immutability ----------------------------------------------------------

  it("update cannot re-point a linked project, nor link a notebook one", async () => {
    const linked = await store.create({ name: "Foo", path: checkout });
    const elsewhere = await makeCheckout(path.join(await makeTmpDir("paddock-other-"), "bar"));

    // Re-point: ignored, cwd unchanged.
    const patched = await store.update(linked.slug, {
      summary: "edited",
      path: elsewhere,
    } as never);
    expect(patched.summary).toBe("edited");
    expect(patched.path).toBe(checkout);
    expect(patched.workingDir).toBe(checkout);

    // Link a notebook via a stray key: ignored, stays a notebook.
    const notebook = await store.create({ name: "Notes" });
    const nPatched = await store.update(notebook.slug, { path: elsewhere } as never);
    expect(nPatched.path).toBeUndefined();
    expect(nPatched.managed).toBe(true);
    expect(nPatched.workingDir).toBe(nPatched.dir);

    await rmTmpDir(path.dirname(elsewhere));
  });

  it("promote refuses a linked project (it would clone into the user's repo)", async () => {
    const linked = await store.create({ name: "Foo", path: checkout });
    const before = await fingerprint(checkout);

    await expect(
      store.promote(linked.slug, "https://github.com/owner/other.git"),
    ).rejects.toMatchObject({ code: "invalid" });

    expect(await fingerprint(checkout)).toEqual(before);
  });

  // --- validation ------------------------------------------------------------

  it("rejects a relative path", async () => {
    await expect(store.create({ name: "Rel", path: "Code/foo" })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await store.exists("rel")).toBe(false);
  });

  it("rejects a path that does not exist", async () => {
    await expect(
      store.create({ name: "Gone", path: path.join(checkout, "nope") }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await store.exists("gone")).toBe(false);
  });

  it("rejects a file (not a directory)", async () => {
    await expect(
      store.create({ name: "File", path: path.join(checkout, "README.md") }),
    ).rejects.toMatchObject({ code: "not_directory" });
  });

  it("ACCEPTS a directory with no .git — paddock probes for git, never requires it", async () => {
    // This is the one place paddock could have grown a mandatory git check, and
    // deliberately has not. Everywhere else it degrades: `isRepo()` goes false,
    // the Changes tab removes itself, commit/push return "not a repo" — and the
    // default E2E server runs on a non-git directory on purpose.
    const plain = await makeTmpDir("paddock-plain-");
    const p = await store.create({ name: "Plain", path: plain, managed: false });
    expect(p.workingDir).toBe(plain);
    expect(p.managed).toBe(false);
    await rmTmpDir(plain);
  });

  it("accepts a linked git WORKTREE, whose .git is a FILE not a directory", async () => {
    const wt = path.join(await makeTmpDir("paddock-wt-"), "branch-b");
    await run("git", ["-C", checkout, "worktree", "add", "-q", "-b", "b", wt]);
    expect((await fs.lstat(path.join(wt, ".git"))).isFile()).toBe(true);

    const p = await store.create({ name: "Worktree", path: wt });
    expect(p.workingDir).toBe(wt);

    await run("git", ["-C", checkout, "worktree", "remove", "--force", wt]);
    await rmTmpDir(path.dirname(wt));
  });

  it("rejects a path inside the projects root", async () => {
    const inside = path.join(root, "sneaky");
    await makeCheckout(inside);
    await expect(store.create({ name: "Sneaky", path: inside })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects a path inside the data dir but outside the projects root", async () => {
    const inside = path.join(dataDir, "claude-home-ish");
    await makeCheckout(inside);
    await expect(store.create({ name: "Inner", path: inside })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects a symlink that points back inside the projects root", async () => {
    // The containment check resolves symlinks FIRST, so an innocent-looking path
    // outside the root cannot smuggle one in.
    const target = path.join(root, "victim");
    await makeCheckout(target);
    const alias = path.join(await makeTmpDir("paddock-alias-"), "alias");
    await fs.symlink(target, alias);

    await expect(store.create({ name: "Alias", path: alias })).rejects.toMatchObject({
      code: "invalid",
    });
    await rmTmpDir(path.dirname(alias));
  });

  it("rejects a path overlapping another project's working directory, both directions", async () => {
    await store.create({ name: "Foo", path: checkout });

    // A child of an existing linked cwd.
    const child = path.join(checkout, "src");
    await run("git", ["init", "-q", child]);
    await expect(store.create({ name: "Child", path: child })).rejects.toMatchObject({
      code: "invalid",
    });

    // The PARENT of an existing linked cwd is just as broken.
    const parent = path.dirname(checkout);
    await run("git", ["init", "-q", parent]);
    await expect(store.create({ name: "Parent", path: parent })).rejects.toMatchObject({
      code: "invalid",
    });

    // And the exact same dir twice.
    await expect(store.create({ name: "Again", path: checkout })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("a rejected path leaves no project directory behind", async () => {
    await expect(
      store.create({ name: "Bad", path: "/nope/missing", managed: false }),
    ).rejects.toThrow(ProjectError);
    // Validation runs before ANY mkdir, so there is nothing to roll back.
    await expect(fs.access(path.join(root, "bad"))).rejects.toThrow();
  });
});

describe("the managed axis (issue #206)", () => {
  let root: string;
  let dataDir: string;
  let store: ProjectStore;
  let warnings: string[];

  /** Write a `project.yaml` by hand, to stand in for one an older paddock wrote. */
  const writeYaml = async (slug: string, lines: string[]): Promise<void> => {
    await fs.mkdir(path.join(root, slug), { recursive: true });
    await fs.writeFile(path.join(root, slug, "project.yaml"), lines.join("\n"), "utf8");
  };

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-data-");
    root = path.join(dataDir, "projects");
    await fs.mkdir(root, { recursive: true });
    warnings = [];
    store = new ProjectStore(root, dataDir, { warn: (m) => warnings.push(m) });
    await store.init();
  });
  afterEach(async () => {
    await rmTmpDir(dataDir);
  });

  // --- the derived default, and why it cannot be a constant ------------------

  it("derives `managed` for a LEGACY project.yaml that predates the key", async () => {
    // The upgrade path, and the whole reason the default is derived rather than
    // simply `true`. Both files are the shape paddock wrote before #206.
    await writeYaml("legacy-notebook", [
      "name: Legacy Notebook",
      "slug: legacy-notebook",
      "status: active",
      "started: 2025-01-01",
      "",
    ]);
    await writeYaml("legacy-repo", [
      "name: Legacy Repo",
      "slug: legacy-repo",
      "status: active",
      "started: 2025-01-01",
      "repo: https://github.com/owner/thing.git",
      "",
    ]);

    // A notebook stays managed …
    expect((await store.get("legacy-notebook")).managed).toBe(true);
    // … and a repo-backed one stays UNMANAGED. If an absent key meant `true`, this
    // would flip on upgrade and the sweeper would start writing CLAUDE.md into
    // somebody's checkout.
    expect((await store.get("legacy-repo")).managed).toBe(false);
  });

  it("writes `managed` explicitly on a new project, so nothing relies on the default", async () => {
    const created = await store.create({ name: "Notes" });
    const raw = YAML.parse(await fs.readFile(path.join(created.dir, "project.yaml"), "utf8"));
    expect(raw.managed).toBe(true);
  });

  it("does NOT rewrite a legacy file merely by reading it", async () => {
    // `normalize` carries `managed` only when it is explicitly on disk, so a
    // `list()` leaves the file byte-identical and the derived value never becomes
    // sticky by accident.
    const lines = [
      "name: Legacy",
      "slug: legacy",
      "status: active",
      "started: 2025-01-01",
      "repo: https://github.com/owner/thing.git",
      "",
    ];
    await writeYaml("legacy", lines);
    await store.list();
    expect(await fs.readFile(path.join(root, "legacy", "project.yaml"), "utf8")).toBe(
      lines.join("\n"),
    );
  });

  // --- the rejected combination ----------------------------------------------

  it("rejects `managed: true` together with `repo` rather than silently dropping one", async () => {
    await expect(
      store.create({ name: "Both", managed: true, repo: "https://github.com/o/r.git" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await store.exists("both")).toBe(false);
  });

  it("rejects an unmanaged project with neither path nor repo", async () => {
    await expect(store.create({ name: "Nothing", managed: false })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  // --- managed + an external path --------------------------------------------

  it("managed + path: content follows the path, the registry entry stays in the data dir", async () => {
    const notes = path.join(await makeTmpDir("paddock-notes-"), "my-notes");

    const p = await store.create({ name: "My Notes", path: notes, managed: true });

    expect(p.managed).toBe(true);
    expect(p.workingDir).toBe(notes);
    expect(p.contentDir).toBe(notes);

    // The curated trio lives out at the path — the accepted consequence being
    // that these do NOT end up in the paddock data dir.
    expect(await fs.readFile(path.join(notes, "CHANGELOG.md"), "utf8")).toContain(
      "Project opened.",
    );
    await expect(fs.access(path.join(notes, "CLAUDE.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(p.dir, "CHANGELOG.md"))).rejects.toThrow();
    await expect(fs.access(path.join(p.dir, "CLAUDE.md"))).rejects.toThrow();

    // Application state does not move: `project.yaml` is the registry entry
    // paddock discovers projects by scanning for.
    await expect(fs.access(path.join(p.dir, "project.yaml"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(notes, "project.yaml"))).rejects.toThrow();

    // …and the curated readers/writers follow the content too.
    await store.writeOverview(p.slug, "# Overview\n\nstate\n");
    expect(await fs.readFile(path.join(notes, "OVERVIEW.md"), "utf8")).toContain("state");
    expect(await store.readOverview(p.slug)).toContain("state");
    expect((await store.get(p.slug)).hasOverview).toBe(true);

    await rmTmpDir(path.dirname(notes));
  });

  it("managed + path CREATES a directory that doesn't exist yet", async () => {
    const notes = path.join(await makeTmpDir("paddock-notes-"), "not", "yet", "here");
    const p = await store.create({ name: "Fresh", path: notes, managed: true });
    expect(p.workingDir).toBe(notes);
    expect((await fs.stat(notes)).isDirectory()).toBe(true);
    await rmTmpDir(path.dirname(notes));
  });

  it("managed + path never clobbers notes that are already there", async () => {
    const notes = await makeTmpDir("paddock-existing-notes-");
    await fs.writeFile(path.join(notes, "CHANGELOG.md"), "# my own history\n");
    await fs.writeFile(path.join(notes, "CLAUDE.md"), "# my own conventions\n");

    await store.create({ name: "Existing", path: notes, managed: true });

    expect(await fs.readFile(path.join(notes, "CHANGELOG.md"), "utf8")).toBe("# my own history\n");
    expect(await fs.readFile(path.join(notes, "CLAUDE.md"), "utf8")).toBe("# my own conventions\n");
    await rmTmpDir(notes);
  });

  // --- acquisition -----------------------------------------------------------

  it("clones the repo INTO a nominated path that does not exist yet", async () => {
    const src = await makeCheckout(path.join(await makeTmpDir("paddock-src-"), "src"));
    const dest = path.join(await makeTmpDir("paddock-dest-"), "cloned");

    const p = await store.create({ name: "Cloned", path: dest, repo: src });

    expect(p.managed).toBe(false);
    expect(p.workingDir).toBe(dest);
    expect(p.repo).toBe(src);
    // A real clone landed there: the source's content, and its own .git.
    expect(await fs.readFile(path.join(dest, "README.md"), "utf8")).toContain("real work");
    expect((await fs.stat(path.join(dest, ".git"))).isDirectory()).toBe(true);

    await rmTmpDir(path.dirname(src));
    await rmTmpDir(path.dirname(dest));
  });

  it("warns — but does not fail — when an existing path's remote differs from `repo`", async () => {
    const checkout = await makeCheckout(path.join(await makeTmpDir("paddock-co-"), "foo"));
    await run("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/real/foo.git"]);

    const p = await store.create({
      name: "Mismatch",
      path: checkout,
      repo: "https://github.com/someone-else/other.git",
    });

    // Used as given — the directory the user named is the one they meant …
    expect(p.workingDir).toBe(checkout);
    // … but the mismatch is said out loud rather than silently ignored (#659).
    expect(warnings.join(" ")).toMatch(/do not include the declared repo/i);
    await rmTmpDir(path.dirname(checkout));
  });

  it("does NOT warn when the remote matches, modulo URL spelling", async () => {
    const checkout = await makeCheckout(path.join(await makeTmpDir("paddock-co-"), "foo"));
    await run("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/real/foo.git"]);

    // Same repo, different spelling: scp-style ssh, and no `.git` suffix.
    await store.create({ name: "Match", path: checkout, repo: "git@github.com:real/foo" });

    expect(warnings).toEqual([]);
    await rmTmpDir(path.dirname(checkout));
  });

  // --- cleanup: only ever what this call created -----------------------------

  it("uses a PRE-EXISTING directory rather than cloning into it, and never removes it", async () => {
    // The footgun the cleanup rule exists for: a nominated directory that already
    // holds the user's files. It must be used as-is, and an unclonable `repo`
    // alongside it must not put it anywhere near a recursive delete.
    const target = await makeTmpDir("paddock-precious-");
    await fs.writeFile(path.join(target, "irreplaceable.txt"), "please do not delete\n");
    const bogus = path.join(root, "_src", "does-not-exist.git");

    const p = await store.create({ name: "Precious", path: target, repo: bogus });

    expect(p.workingDir).toBe(target);
    expect(await fs.readFile(path.join(target, "irreplaceable.txt"), "utf8")).toBe(
      "please do not delete\n",
    );
    await rmTmpDir(target);
  });

  it("a failed clone removes the directory it created, and nothing above it", async () => {
    const parent = await makeTmpDir("paddock-parent-");
    await fs.writeFile(path.join(parent, "sibling.txt"), "keep me\n");
    const dest = path.join(parent, "cloned");
    const bogus = path.join(root, "_src", "does-not-exist.git");

    await expect(
      store.create({ name: "Doomed", path: dest, repo: bogus }),
    ).rejects.toMatchObject({ code: "invalid" });

    // The clone target we created is gone …
    await expect(fs.access(dest)).rejects.toThrow();
    // … the parent, which we did NOT create, is untouched …
    expect(await fs.readFile(path.join(parent, "sibling.txt"), "utf8")).toBe("keep me\n");
    // … and no half-made project is left behind.
    expect(await store.exists("doomed")).toBe(false);
    await expect(fs.access(path.join(root, "doomed"))).rejects.toThrow();

    await rmTmpDir(parent);
  });

  // NOTE on what the test above can and cannot prove. `git clone` removes its own
  // target when it fails, so the "the clone target is gone" assertion stays green
  // even if paddock's rollback never ran — it is really pinning the SECOND half,
  // that the pre-existing parent survives. There is no failure reachable through
  // the public API that leaves clone debris behind for paddock to clean up, so the
  // completeness of the rollback rests on the shape of the code (`acquirePath`
  // records the directory BEFORE the risky step, and `create` wraps every step
  // after the slug dir in one try/rollback) rather than on a test. Recording after
  // the fact would be untestable AND wrong; recording before is untestable and
  // right, which is why it is written the way it is.
});
