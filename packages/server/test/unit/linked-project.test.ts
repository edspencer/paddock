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

  it("a linked project is repoBacked, with cwd = the linked dir and no seeded CLAUDE.md", async () => {
    const p = await store.create({ name: "Foo", path: checkout, summary: "linked" });

    expect(p.path).toBe(checkout);
    expect(p.workingDir).toBe(checkout);
    expect(p.dir).toBe(path.join(root, "foo"));
    // repoBacked drives the sweeper's CLAUDE.md suppression — the linked repo has
    // its own upstream-owned one that the sweeper must never write (#206 item 5).
    expect(p.repoBacked).toBe(true);
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
    expect(reread.repoBacked).toBe(true);
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
    expect(nPatched.repoBacked).toBe(false);
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

  it("rejects a directory with no .git", async () => {
    const plain = await makeTmpDir("paddock-plain-");
    await expect(store.create({ name: "Plain", path: plain })).rejects.toMatchObject({
      code: "invalid",
    });
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

  it("a rejected linked path leaves no project directory behind", async () => {
    await expect(store.create({ name: "Bad", path: "/nope/missing" })).rejects.toThrow(
      ProjectError,
    );
    // Validation runs before ANY mkdir, so there is nothing to roll back.
    await expect(fs.access(path.join(root, "bad"))).rejects.toThrow();
  });
});
