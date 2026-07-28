import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ProjectStore, ROOT_SLUG } from "../../src/projects.js";
import { resolveInProject, listFiles } from "../../src/project-files.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * The freeform file surface must REFUSE hidden (dot-prefixed) paths, not merely
 * omit them from listings.
 *
 * `listFiles` has always dropped dot entries from what it returns, but that is
 * presentation: naming the path explicitly still resolved it, and the read
 * route's `:name` param decodes `%2F`, so a "single segment" accepts a whole
 * nested path. Together those made `…/files/.chats%2F<id>.jsonl` and
 * `…/files/.git%2Fconfig` readable. The root project (#516) widened that from
 * one project's subtree to the whole instance.
 *
 * Defense-in-depth rather than a privilege boundary (any caller who can reach
 * these routes can already run Bash via a keeper chat) — but "hidden in the
 * listing" should not be the only thing guarding a transcript.
 */
describe("project-files — hidden paths are refused, not just hidden", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-hidden-");
    store = new ProjectStore(root);
    await store.init();
    await store.create({ name: "Alpha" });
    await store.createRoot({ name: "Root" });
    // The shapes that actually matter: a transcript store and a git config.
    await fs.mkdir(path.join(root, ".chats"), { recursive: true });
    await fs.writeFile(path.join(root, ".chats", "s1.jsonl"), '{"secret":"transcript"}\n');
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "config"), "url = https://x:TOKEN@example/r\n");
    await fs.mkdir(path.join(root, "alpha", ".chats"), { recursive: true });
    await fs.writeFile(path.join(root, "alpha", ".chats", "s2.jsonl"), '{"secret":"proj"}\n');
    await fs.writeFile(path.join(root, "alpha", "notes.md"), "# fine\n");
  });
  afterEach(() => rmTmpDir(root));

  it("refuses descending THROUGH a hidden directory — transcripts and .git alike", () => {
    for (const p of [".chats/s1.jsonl", ".git/config", ".git/refs/heads/main"]) {
      expect(() => resolveInProject(root, ROOT_SLUG, p), p).toThrow(/Invalid file path/);
    }
  });

  it("refuses a hidden directory inside an ordinary project too (pre-existing, same hole)", () => {
    expect(() => resolveInProject(root, "alpha", ".chats/s2.jsonl")).toThrow(/Invalid file path/);
  });

  it("refuses a hidden directory reached by normalisation, not just a literal one", () => {
    // The raw string contains no leading-dot segment; the RESOLVED path does.
    expect(() => resolveInProject(root, ROOT_SLUG, "alpha/../.chats/s1.jsonl")).toThrow(
      /Invalid file path/,
    );
    expect(() => resolveInProject(root, ROOT_SLUG, "./.git/config")).toThrow(/Invalid file path/);
  });

  it("STILL READS a dotfile leaf — the Changes pane depends on it", async () => {
    // Regression guard. Refusing every dot segment was the first cut and it
    // broke Changes: an untracked file has no diff, so the pane renders its
    // CONTENT through this surface — and `.gitignore` is untracked in a fresh
    // repo-backed project, because `ensureSidecarGitignore` writes it. Caught in
    // live QA as a 400 on `/api/projects/__root/files/.gitignore`.
    await fs.writeFile(path.join(root, ".gitignore"), "/.chats/\n");
    expect(resolveInProject(root, ROOT_SLUG, ".gitignore")).toBe(
      path.join(root, ".gitignore"),
    );
    expect(await store.readFile(ROOT_SLUG, ".gitignore")).toContain(".chats");
  });

  it("still refuses ordinary traversal out of the project dir", () => {
    // A genuine escape to a sibling project, and an absolute path.
    expect(() => resolveInProject(root, "alpha", "../beta/notes.md")).toThrow(
      /Invalid file path/,
    );
    expect(() => resolveInProject(root, "alpha", "/etc/passwd")).toThrow(/Invalid file path/);
    // NOT an escape: `..` that normalises back inside is fine, and stays fine.
    expect(resolveInProject(root, "alpha", "../alpha/notes.md")).toBe(
      path.join(root, "alpha", "notes.md"),
    );
  });

  it("still allows the project root and ordinary nested files", () => {
    expect(resolveInProject(root, "alpha", "")).toBe(path.join(root, "alpha"));
    expect(resolveInProject(root, "alpha", "notes.md")).toBe(
      path.join(root, "alpha", "notes.md"),
    );
    // A project dir under a DOT-PREFIXED ancestor must still work: only the
    // path relative to the project dir is examined.
    expect(resolveInProject(root, ROOT_SLUG, "alpha/notes.md")).toBe(
      path.join(root, "alpha", "notes.md"),
    );
  });

  it("refuses to LIST a hidden directory that was previously enumerable", async () => {
    // `?path=.chats` used to enumerate every transcript filename. A listing
    // target IS a directory, so unlike a read its leaf gets no pass.
    await expect(listFiles(root, ROOT_SLUG, ".chats")).rejects.toThrow(/Invalid file path/);
    await expect(listFiles(root, ROOT_SLUG, ".git")).rejects.toThrow(/Invalid file path/);
    // …while the ordinary listing still works and still omits dot entries.
    const names = (await listFiles(root, ROOT_SLUG)).map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("project.yaml");
    expect(names.some((n) => n.startsWith("."))).toBe(false);
  });

  it("refuses the reads through the ProjectStore wrappers, not just the helper", async () => {
    await expect(store.readFile(ROOT_SLUG, ".git/config")).rejects.toThrow(
      /Invalid file path/,
    );
    await expect(store.listFiles(ROOT_SLUG, ".chats")).rejects.toThrow(/Invalid file path/);
    await expect(store.readFileBytes(ROOT_SLUG, ".chats/s1.jsonl")).rejects.toThrow(
      /Invalid file path/,
    );
    await expect(store.readFileWithKind(ROOT_SLUG, ".chats/s1.jsonl")).rejects.toThrow(
      /Invalid file path/,
    );
  });
});
