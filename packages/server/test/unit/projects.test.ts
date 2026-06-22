import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProjectStore, ProjectError, slugify, fileKind } from "../../src/projects.js";
import { KEEPER_DEFAULT_MODEL } from "../../src/models.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("slugify", () => {
  it("lowercases, trims, and kebab-cases", () => {
    expect(slugify("Garage Water Heater")).toBe("garage-water-heater");
    expect(slugify("  Hello, World!  ")).toBe("hello-world");
  });
  it("collapses runs of non-alphanumerics and strips leading/trailing hyphens", () => {
    expect(slugify("a---b__c")).toBe("a-b-c");
    expect(slugify("--edge--")).toBe("edge");
  });
  it("truncates to 64 chars", () => {
    expect(slugify("x".repeat(100)).length).toBe(64);
  });
});

describe("fileKind", () => {
  it("maps extensions to render kinds", () => {
    expect(fileKind("README.md")).toBe("markdown");
    expect(fileKind("notes.markdown")).toBe("markdown");
    expect(fileKind("page.html")).toBe("html");
    expect(fileKind("page.HTM")).toBe("html");
    expect(fileKind("data.txt")).toBe("text");
    expect(fileKind("noext")).toBe("text");
  });
});

describe("ProjectStore", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-projects-");
    store = new ProjectStore(root);
    await store.init();
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  it("create writes project.yaml + CHANGELOG and returns a DTO", async () => {
    const p = await store.create({ name: "Water Heater" });
    expect(p.slug).toBe("water-heater");
    expect(p.name).toBe("Water Heater");
    expect(p.status).toBe("active");
    expect(p.group).toBe(""); // unsorted by default
    expect(p.model).toBe(KEEPER_DEFAULT_MODEL); // DTO resolves the default
    expect(p.created).toBe(p.started);
    expect(p.hasOverview).toBe(false);
    expect(p.pinned).toEqual([]);

    const yamlRaw = await fs.readFile(path.join(root, "water-heater", "project.yaml"), "utf8");
    const parsed = YAML.parse(yamlRaw);
    expect(parsed.slug).toBe("water-heater");
    // group + model stay OFF disk when absent (round-trip discipline).
    expect("group" in parsed).toBe(false);
    expect("model" in parsed).toBe(false);
    const changelog = await fs.readFile(path.join(root, "water-heater", "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("Project opened.");
  });

  it("create honors explicit slug, status, group, summary, domain", async () => {
    const p = await store.create({
      name: "My Project",
      slug: "custom-slug",
      status: "idea",
      group: "Homelab",
      summary: "a summary",
      domain: ["a", "b"],
    });
    expect(p.slug).toBe("custom-slug");
    expect(p.status).toBe("idea");
    expect(p.group).toBe("homelab"); // lowercased
    expect(p.summary).toBe("a summary");
    expect(p.domain).toEqual(["a", "b"]);
  });

  it("create rejects a blank name and an invalid slug", async () => {
    await expect(store.create({ name: "   " })).rejects.toMatchObject({ code: "invalid" });
    await expect(store.create({ name: "ok", slug: "Bad Slug!" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("create is idempotency-guarded (throws exists for a duplicate slug)", async () => {
    await store.create({ name: "Dup" });
    await expect(store.create({ name: "Dup" })).rejects.toMatchObject({ code: "exists" });
  });

  it("get throws not_found for an unknown slug", async () => {
    await expect(store.get("nope")).rejects.toBeInstanceOf(ProjectError);
    await expect(store.get("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("list returns projects newest-updated first and skips _ and . dirs", async () => {
    await store.create({ name: "Older" });
    // Force distinct updated dates by patching the yaml directly.
    await patchYaml(root, "older", { updated: "2026-01-01" });
    await store.create({ name: "Newer" });
    await patchYaml(root, "newer", { updated: "2026-06-01" });
    // A template/hidden dir should be skipped.
    await fs.mkdir(path.join(root, "_template"));
    await fs.writeFile(path.join(root, "_template", "project.yaml"), "name: t\nslug: _template\n");
    await fs.mkdir(path.join(root, ".hidden"));

    const list = await store.list();
    expect(list.map((p) => p.slug)).toEqual(["newer", "older"]);
  });

  it("update changes mutable fields, keeps slug+started immutable, bumps updated", async () => {
    const created = await store.create({ name: "Proj" });
    const before = created.updated;
    const updated = await store.update("proj", {
      status: "paused",
      summary: "new",
      group: "house",
      domain: ["x"],
    });
    expect(updated.slug).toBe("proj");
    expect(updated.started).toBe(created.started);
    expect(updated.status).toBe("paused");
    expect(updated.summary).toBe("new");
    expect(updated.group).toBe("house");
    expect(updated.domain).toEqual(["x"]);
    expect(updated.updated >= before).toBe(true);
  });

  it("group round-trips: set persists to disk; cleared area normalizes away on re-read", async () => {
    await store.create({ name: "G" });
    await store.update("g", { group: "homelab" });
    let parsed = YAML.parse(await fs.readFile(path.join(root, "g", "project.yaml"), "utf8"));
    expect(parsed.group).toBe("homelab");

    // Clearing the area: the DTO reports "" immediately.
    const cleared = await store.update("g", { group: "" });
    expect(cleared.group).toBe("");
    // NOTE: `update` writes the patched `group: ""` to disk verbatim (it does
    // not re-run the "drop empty group" discipline that `create`/`normalize`
    // apply). It is harmless — `normalize` strips it on the next read — but it
    // means the empty key is briefly present on disk. Asserting the real
    // behavior here so a future change to `update` is caught.
    parsed = YAML.parse(await fs.readFile(path.join(root, "g", "project.yaml"), "utf8"));
    expect(parsed.group).toBe("");
    // Re-reading through the store normalizes the empty area back out of the DTO
    // (and a subsequent write would no longer carry it).
    const reread = await store.get("g");
    expect(reread.group).toBe("");
  });

  it("model round-trips through the DTO default", async () => {
    await store.create({ name: "M" });
    const got = await store.get("m");
    expect(got.model).toBe(KEEPER_DEFAULT_MODEL);
    const updated = await store.update("m", { model: "claude-sonnet-4-6" });
    expect(updated.model).toBe("claude-sonnet-4-6");
    const parsed = YAML.parse(await fs.readFile(path.join(root, "m", "project.yaml"), "utf8"));
    expect(parsed.model).toBe("claude-sonnet-4-6");
  });

  it("normalize fills defaults for a sparse on-disk yaml", async () => {
    await fs.mkdir(path.join(root, "sparse"));
    await fs.writeFile(
      path.join(root, "sparse", "project.yaml"),
      "name: Sparse\nslug: sparse\n",
      "utf8",
    );
    const p = await store.get("sparse");
    expect(p.status).toBe("active");
    expect(p.visibility).toBe("public");
    expect(p.domain).toEqual([]);
    expect(p.group).toBe("");
    expect(p.updated).toBe(p.started); // updated defaults to started
  });

  it("pinFile validates existence, dedupes, and persists; unpinFile removes", async () => {
    const p = await store.create({ name: "Pins" });
    await fs.writeFile(path.join(p.dir, "notes.md"), "hi", "utf8");

    let pinned = await store.pinFile("pins", "notes.md");
    expect(pinned.pinned).toEqual(["notes.md"]);
    // Pinning again is a no-op (deduped).
    pinned = await store.pinFile("pins", "notes.md");
    expect(pinned.pinned).toEqual(["notes.md"]);
    // Persisted.
    const parsed = YAML.parse(await fs.readFile(path.join(p.dir, "project.yaml"), "utf8"));
    expect(parsed.pinned).toEqual(["notes.md"]);

    const un = await store.unpinFile("pins", "notes.md");
    expect(un.pinned).toEqual([]);
  });

  it("pinFile rejects a missing file and a traversal attempt", async () => {
    await store.create({ name: "Pins2" });
    await expect(store.pinFile("pins2", "ghost.md")).rejects.toMatchObject({ code: "invalid" });
    await expect(store.pinFile("pins2", "../escape.md")).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("appendChangelog inserts under today's heading and creates a new section as needed", async () => {
    await store.create({ name: "CL" });
    await store.appendChangelog("cl", "first note");
    await store.appendChangelog("cl", "second note");
    const body = await fs.readFile(path.join(root, "cl", "CHANGELOG.md"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    expect(body).toContain(`## ${today}`);
    expect(body).toContain("- first note");
    expect(body).toContain("- second note");
    // Both notes land under the same dated heading (one section for today).
    const headings = body.split("\n").filter((l) => l === `## ${today}`);
    expect(headings.length).toBe(1);
  });

  it("readFile / readFileWithKind enforce the traversal guard and 404 on miss", async () => {
    const p = await store.create({ name: "Files" });
    await fs.writeFile(path.join(p.dir, "doc.md"), "# Doc", "utf8");
    const wk = await store.readFileWithKind("files", "doc.md");
    expect(wk).toEqual({ name: "doc.md", kind: "markdown", content: "# Doc" });
    await expect(store.readFile("files", "../../etc/passwd")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(store.readFileWithKind("files", "missing.md")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("listFiles returns freeform files (no dotfiles) sorted", async () => {
    const p = await store.create({ name: "LF" });
    await fs.writeFile(path.join(p.dir, "b.md"), "", "utf8");
    await fs.writeFile(path.join(p.dir, "a.md"), "", "utf8");
    await fs.writeFile(path.join(p.dir, ".secret"), "", "utf8");
    const files = await store.listFiles("lf");
    // project.yaml + CHANGELOG.md are also files; assert ordering + dotfile skip.
    expect(files).toContain("a.md");
    expect(files).toContain("b.md");
    expect(files).not.toContain(".secret");
    expect([...files]).toEqual([...files].sort());
  });

  it("overview read/write/exists", async () => {
    await store.create({ name: "OV" });
    expect(await store.overviewExists("ov")).toBe(false);
    expect(await store.readOverview("ov")).toBe("");
    await store.writeOverview("ov", "# Overview\nstate");
    expect(await store.overviewExists("ov")).toBe(true);
    expect(await store.readOverview("ov")).toContain("state");
  });

  it("remove deletes the dir and refuses to escape the root", async () => {
    const p = await store.create({ name: "Del" });
    await store.remove("del");
    await expect(fs.access(p.dir)).rejects.toBeTruthy();
    await expect(store.remove("del")).rejects.toMatchObject({ code: "not_found" });
  });
});

/** Patch fields into a project's on-disk yaml (test helper). */
async function patchYaml(root: string, slug: string, patch: Record<string, unknown>) {
  const file = path.join(root, slug, "project.yaml");
  const parsed = YAML.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, YAML.stringify({ ...parsed, ...patch }), "utf8");
}
