import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import YAML from "yaml";
import {
  ProjectStore,
  ProjectError,
  slugify,
  fileKind,
  contentTypeFor,
  repoCheckoutName,
  workingDirFor,
  isValidRepoUrl,
  normalizeLinks,
} from "../../src/projects.js";
import { KEEPER_DEFAULT_MODEL } from "../../src/models.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const run = promisify(execFile);

/**
 * Create a local git repo (issue #187 test fixture) with a CLAUDE.md + README so
 * a repo-backed project can be cloned WITHOUT any network. Returns its path; a
 * plain filesystem path is an accepted repo URL (isValidRepoUrl).
 */
async function makeSourceRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main", dir]);
  await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Upstream Repo\n\nThe repo's own identity file.\n");
  await fs.writeFile(path.join(dir, "README.md"), "# demo repo\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", [
    "-C", dir,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "init",
  ]);
  return dir;
}

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

  it("maps image extensions to the image kind (issue #61)", () => {
    for (const n of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.avif", "h.ico"]) {
      expect(fileKind(n)).toBe("image");
    }
    // Non-image binaries still fall through to text (no dedicated kind yet).
    expect(fileKind("archive.zip")).toBe("text");
  });
});

describe("contentTypeFor", () => {
  it("returns the image MIME for image extensions, octet-stream otherwise", () => {
    expect(contentTypeFor("x.png")).toBe("image/png");
    expect(contentTypeFor("x.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("x.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
  });

  it("returns the video MIME for video extensions (issue #126)", () => {
    expect(contentTypeFor("x.mp4")).toBe("video/mp4");
    expect(contentTypeFor("x.webm")).toBe("video/webm");
    expect(contentTypeFor("x.mov")).toBe("video/quicktime");
    expect(contentTypeFor("x.m4v")).toBe("video/x-m4v");
    // .webp stays an image, never a video (extension-collision guard).
    expect(contentTypeFor("x.webp")).toBe("image/webp");
  });

  it("serves a .pdf as application/pdf (not octet-stream / text)", () => {
    expect(contentTypeFor("x.pdf")).toBe("application/pdf");
    expect(contentTypeFor("x.PDF")).toBe("application/pdf");
    // A .pdf must NOT be classified as an image kind.
    expect(fileKind("x.pdf")).toBe("text");
  });
});

describe("repo-backed helpers (issue #187)", () => {
  it("repoCheckoutName derives a filesystem-safe basename, sans .git", () => {
    expect(repoCheckoutName("https://github.com/owner/paddock.git")).toBe("paddock");
    expect(repoCheckoutName("https://github.com/owner/paddock")).toBe("paddock");
    expect(repoCheckoutName("git@github.com:owner/My.Repo.git")).toBe("My.Repo");
    expect(repoCheckoutName("/local/path/to/repo/")).toBe("repo");
    expect(repoCheckoutName("file:///tmp/x/demo.git")).toBe("demo");
    // Degenerate input never yields an empty / traversal-y name.
    expect(repoCheckoutName("https://host/")).toBe("host");
    expect(repoCheckoutName("...")).toBe("repo");
  });

  it("workingDirFor is the checkout for repo-backed, else the dir itself", () => {
    expect(workingDirFor("/d/projects/p")).toBe("/d/projects/p");
    expect(workingDirFor("/d/projects/p", "https://github.com/o/repo.git")).toBe(
      "/d/projects/p/repo",
    );
  });

  it("isValidRepoUrl accepts real git URLs and rejects junk", () => {
    expect(isValidRepoUrl("https://github.com/o/r.git")).toBe(true);
    expect(isValidRepoUrl("git@github.com:o/r.git")).toBe(true);
    expect(isValidRepoUrl("ssh://git@host/o/r.git")).toBe(true);
    expect(isValidRepoUrl("file:///tmp/repo")).toBe(true);
    expect(isValidRepoUrl("/abs/local/repo")).toBe(true);
    expect(isValidRepoUrl("")).toBe(false);
    expect(isValidRepoUrl("not a url")).toBe(false);
    expect(isValidRepoUrl("ftp://host/x")).toBe(false);
  });
});

describe("normalizeLinks (legacy bare-string links)", () => {
  it("coerces a bare YAML string list into {label,url} objects", () => {
    // The shape that crashed the Settings pane: `links: [ - https://… ]`.
    expect(normalizeLinks(["https://github.com/edspencer/hushpod", "https://podcasts.valfenda.net"])).toEqual([
      { label: "", url: "https://github.com/edspencer/hushpod" },
      { label: "", url: "https://podcasts.valfenda.net" },
    ]);
  });

  it("keeps well-formed object links (trimmed) and tolerates a mixed list", () => {
    expect(
      normalizeLinks([
        { label: " GitHub ", url: " https://x.test " },
        "https://bare.test",
      ]),
    ).toEqual([
      { label: "GitHub", url: "https://x.test" },
      { label: "", url: "https://bare.test" },
    ]);
  });

  it("drops url-less / malformed entries and non-array input", () => {
    expect(normalizeLinks([" ", { label: "no url" }, 42, null])).toEqual([]);
    expect(normalizeLinks(undefined)).toEqual([]);
    expect(normalizeLinks("https://not-a-list.test")).toEqual([]);
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
    // A minimal per-project CLAUDE.md is seeded at creation (issue #177).
    const claude = await fs.readFile(path.join(root, "water-heater", "CLAUDE.md"), "utf8");
    expect(claude).toContain("# Water Heater");
    expect(claude).toContain("Durable project identity & conventions");
  });

  it("seeds CLAUDE.md with the summary when one is given (#177)", async () => {
    await store.create({ name: "Themed", summary: "A themed thing." });
    const claude = await store.readClaudeMd("themed");
    expect(claude).toContain("# Themed");
    expect(claude).toContain("A themed thing.");
  });

  it("writeClaudeCurated replaces the Curated notes section, preserving human content above (#177/#379)", async () => {
    await store.create({ name: "Amend", summary: "Base." });
    const seeded = await store.readClaudeMd("amend");

    await store.writeClaudeCurated("amend", "- First durable fact.");
    let body = await store.readClaudeMd("amend");
    // Human-authored seed (name + summary) is preserved verbatim above the note.
    expect(body.startsWith(seeded.trimEnd())).toBe(true);
    expect(body).toContain("## Curated notes");
    expect(body).toContain("- First durable fact.");

    // A second write REPLACES the curated body wholesale (dedup/prune model,
    // #379) — the heading isn't duplicated and the stale note is gone.
    await store.writeClaudeCurated("amend", "- Second durable fact.");
    body = await store.readClaudeMd("amend");
    expect(body.match(/## Curated notes/g)?.length).toBe(1);
    expect(body).not.toContain("- First durable fact.");
    expect(body).toContain("- Second durable fact.");
    // Human header still intact after the wholesale rewrite.
    expect(body.startsWith(seeded.trimEnd())).toBe(true);
  });

  it("writeClaudeCurated is a no-op for blank input (#379)", async () => {
    await store.create({ name: "Blank" });
    const before = await store.readClaudeMd("blank");
    await store.writeClaudeCurated("blank", "   \n  ");
    expect(await store.readClaudeMd("blank")).toBe(before);
    expect(before).not.toContain("## Curated notes");
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
    const updated = await store.update("m", { model: "claude-sonnet-5" });
    expect(updated.model).toBe("claude-sonnet-5");
    const parsed = YAML.parse(await fs.readFile(path.join(root, "m", "project.yaml"), "utf8"));
    expect(parsed.model).toBe("claude-sonnet-5");
  });

  it("keeper settings resolve to defaults and round-trip when set (issue #12)", async () => {
    await store.create({ name: "K" });
    // Defaults resolved in the DTO for a project that never set them.
    const got = await store.get("k");
    expect(got.permissionMode).toBe("acceptEdits");
    expect(got.maxTurns).toBe(200);
    expect(got.docker).toBe(false);

    // Overrides persist to disk and survive a re-read.
    const updated = await store.update("k", {
      permissionMode: "plan",
      maxTurns: 42,
      docker: true,
    });
    expect(updated.permissionMode).toBe("plan");
    expect(updated.maxTurns).toBe(42);
    expect(updated.docker).toBe(true);

    const parsed = YAML.parse(await fs.readFile(path.join(root, "k", "project.yaml"), "utf8"));
    expect(parsed.permissionMode).toBe("plan");
    expect(parsed.maxTurns).toBe(42);
    expect(parsed.docker).toBe(true);

    const reread = await store.get("k");
    expect(reread.permissionMode).toBe("plan");
    expect(reread.maxTurns).toBe(42);
    expect(reread.docker).toBe(true);
  });

  it("driveMode override sets, persists, and clears back to inherit (issue #122)", async () => {
    await store.create({ name: "D" });
    // No override initially — the field is absent from the DTO + yaml.
    const created = await store.get("d");
    expect(created.driveMode).toBeUndefined();

    // Setting an override persists to disk.
    const set = await store.update("d", { driveMode: "session" });
    expect(set.driveMode).toBe("session");
    let parsed = YAML.parse(await fs.readFile(path.join(root, "d", "project.yaml"), "utf8"));
    expect(parsed.driveMode).toBe("session");

    // An unrelated update leaves the override untouched (undefined = no change).
    const untouched = await store.update("d", { summary: "hi" });
    expect(untouched.driveMode).toBe("session");

    // `null` CLEARS the override -> inherit the global default (field removed).
    const cleared = await store.update("d", { driveMode: null });
    expect(cleared.driveMode).toBeUndefined();
    parsed = YAML.parse(await fs.readFile(path.join(root, "d", "project.yaml"), "utf8"));
    expect("driveMode" in parsed).toBe(false);
    // Re-read from disk confirms it stayed cleared.
    expect((await store.get("d")).driveMode).toBeUndefined();
  });

  it("maxSpawnDepth override sets, persists, and clears back to inherit (issue #262)", async () => {
    await store.create({ name: "MSD" });
    // No override initially — absent from the DTO + yaml (inherits instance default).
    const created = await store.get("msd");
    expect(created.maxSpawnDepth).toBeUndefined();

    // Setting an override persists to disk (0 is a real override, not 'absent').
    const set = await store.update("msd", { maxSpawnDepth: 0 });
    expect(set.maxSpawnDepth).toBe(0);
    let parsed = YAML.parse(await fs.readFile(path.join(root, "msd", "project.yaml"), "utf8"));
    expect(parsed.maxSpawnDepth).toBe(0);

    // An unrelated update leaves the override untouched (undefined = no change).
    const untouched = await store.update("msd", { summary: "hi" });
    expect(untouched.maxSpawnDepth).toBe(0);

    // A different override value replaces it.
    const bumped = await store.update("msd", { maxSpawnDepth: 3 });
    expect(bumped.maxSpawnDepth).toBe(3);

    // `null` CLEARS the override -> inherit the instance default (field removed).
    const cleared = await store.update("msd", { maxSpawnDepth: null });
    expect(cleared.maxSpawnDepth).toBeUndefined();
    parsed = YAML.parse(await fs.readFile(path.join(root, "msd", "project.yaml"), "utf8"));
    expect("maxSpawnDepth" in parsed).toBe(false);
    expect((await store.get("msd")).maxSpawnDepth).toBeUndefined();
  });

  it("recovery override sets, persists, sanitises, and clears back to inherit (#301)", async () => {
    await store.create({ name: "REC" });
    // No override initially — absent from the DTO + yaml (inherits every default).
    const created = await store.get("rec");
    expect(created.recovery).toBeUndefined();

    // Setting a partial override persists only the valid fields to disk.
    const set = await store.update("rec", {
      recovery: { surfaceKilledTask: false, autoReDrive: true },
    });
    expect(set.recovery).toEqual({ surfaceKilledTask: false, autoReDrive: true });
    let parsed = YAML.parse(await fs.readFile(path.join(root, "rec", "project.yaml"), "utf8"));
    expect(parsed.recovery).toEqual({ surfaceKilledTask: false, autoReDrive: true });

    // An unrelated update leaves the override untouched (undefined = no change).
    const untouched = await store.update("rec", { summary: "hi" });
    expect(untouched.recovery).toEqual({ surfaceKilledTask: false, autoReDrive: true });

    // A new override object REPLACES it; invalid fields are dropped on write.
    const replaced = await store.update("rec", {
      recovery: { debounceMs: 1200, maxRetries: -5 } as never,
    });
    expect(replaced.recovery).toEqual({ debounceMs: 1200 });

    // An all-invalid override clears it entirely (nothing valid to persist).
    const wiped = await store.update("rec", { recovery: { maxRetries: -1 } as never });
    expect(wiped.recovery).toBeUndefined();
    parsed = YAML.parse(await fs.readFile(path.join(root, "rec", "project.yaml"), "utf8"));
    expect("recovery" in parsed).toBe(false);

    // `null` explicitly CLEARS the override -> inherit the instance default.
    await store.update("rec", { recovery: { autoReDrive: true } });
    const cleared = await store.update("rec", { recovery: null });
    expect(cleared.recovery).toBeUndefined();
    parsed = YAML.parse(await fs.readFile(path.join(root, "rec", "project.yaml"), "utf8"));
    expect("recovery" in parsed).toBe(false);
  });

  it("curation override sets, persists, sanitises, and clears back to inherit (#384)", async () => {
    await store.create({ name: "CUR" });
    const created = await store.get("cur");
    expect(created.curation).toBeUndefined();

    // A partial override persists only the fields it sets (others inherit at sweep time).
    const set = await store.update("cur", { curation: { changelogMaxTokens: 4000 } });
    expect(set.curation).toEqual({ changelogMaxTokens: 4000 });
    let parsed = YAML.parse(await fs.readFile(path.join(root, "cur", "project.yaml"), "utf8"));
    expect(parsed.curation).toEqual({ changelogMaxTokens: 4000 });

    // An unrelated update leaves it untouched.
    const untouched = await store.update("cur", { summary: "hi" });
    expect(untouched.curation).toEqual({ changelogMaxTokens: 4000 });

    // A new object REPLACES it; non-positive / non-integer fields are dropped.
    const replaced = await store.update("cur", {
      curation: { overviewMaxTokens: 1500, claudeMaxTokens: 0 } as never,
    });
    expect(replaced.curation).toEqual({ overviewMaxTokens: 1500 });

    // An all-invalid override clears it entirely.
    const wiped = await store.update("cur", { curation: { changelogMaxTokens: -1 } as never });
    expect(wiped.curation).toBeUndefined();

    // `null` explicitly CLEARS the override -> inherit the instance default.
    await store.update("cur", { curation: { claudeMaxTokens: 3000 } });
    const cleared = await store.update("cur", { curation: null });
    expect(cleared.curation).toBeUndefined();
    parsed = YAML.parse(await fs.readFile(path.join(root, "cur", "project.yaml"), "utf8"));
    expect("curation" in parsed).toBe(false);
  });

  it("keeper settings are absent from a sparse yaml until set (round-trip discipline)", async () => {
    await fs.mkdir(path.join(root, "sparse2"));
    await fs.writeFile(
      path.join(root, "sparse2", "project.yaml"),
      "name: Sparse2\nslug: sparse2\n",
      "utf8",
    );
    const dto = await store.get("sparse2");
    // DTO reports concrete defaults …
    expect(dto.permissionMode).toBe("acceptEdits");
    expect(dto.maxTurns).toBe(200);
    expect(dto.docker).toBe(false);
    // … but the on-disk yaml still has none of the keeper keys.
    const parsed = YAML.parse(await fs.readFile(path.join(root, "sparse2", "project.yaml"), "utf8"));
    expect(parsed.permissionMode).toBeUndefined();
    expect(parsed.maxTurns).toBeUndefined();
    expect(parsed.docker).toBeUndefined();
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

  it("reads a legacy bare-string links list as {label,url} DTO and self-heals on save", async () => {
    // Reproduces the hushpod crash: an old hand-authored project.yaml whose
    // `links` are bare strings, not {label,url} objects.
    await fs.mkdir(path.join(root, "legacy"));
    await fs.writeFile(
      path.join(root, "legacy", "project.yaml"),
      "name: Legacy\nslug: legacy\nlinks:\n  - https://github.com/edspencer/hushpod\n  - https://podcasts.valfenda.net\n",
      "utf8",
    );

    const dto = await store.get("legacy");
    // DTO links are ALWAYS well-formed objects (SettingsPane's `l.url.trim()`
    // would otherwise throw during render on a string entry).
    expect(dto.links).toEqual([
      { label: "", url: "https://github.com/edspencer/hushpod" },
      { label: "", url: "https://podcasts.valfenda.net" },
    ]);

    // A save round-trips the file into the object form — the project self-heals.
    await store.update("legacy", { summary: "touched" });
    const parsed = YAML.parse(await fs.readFile(path.join(root, "legacy", "project.yaml"), "utf8"));
    expect(parsed.links).toEqual([
      { label: "", url: "https://github.com/edspencer/hushpod" },
      { label: "", url: "https://podcasts.valfenda.net" },
    ]);
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

  it("pinFile accepts a nested file and stores its full project-relative path", async () => {
    const p = await store.create({ name: "PinsNested" });
    await fs.mkdir(path.join(p.dir, "design", "sub"), { recursive: true });
    await fs.writeFile(path.join(p.dir, "design", "sub", "plan.md"), "deep", "utf8");

    const pinned = await store.pinFile("pinsnested", "design/sub/plan.md");
    expect(pinned.pinned).toEqual(["design/sub/plan.md"]);
    const parsed = YAML.parse(await fs.readFile(path.join(p.dir, "project.yaml"), "utf8"));
    expect(parsed.pinned).toEqual(["design/sub/plan.md"]);

    // A traversal that dips through a real subdir but escapes the project is still rejected.
    await expect(store.pinFile("pinsnested", "design/../../escape.md")).rejects.toMatchObject({
      code: "invalid",
    });

    const un = await store.unpinFile("pinsnested", "design/sub/plan.md");
    expect(un.pinned).toEqual([]);
  });

  it("writeChangelog replaces the file wholesale and asserts the canonical title (#379)", async () => {
    await store.create({ name: "CL" });
    const today = new Date().toISOString().slice(0, 10);
    // The sweeper returns the FULL changelog body; Paddock owns the title.
    await store.writeChangelog("cl", `## ${today}\n- first note\n- second note`);
    let body = await fs.readFile(path.join(root, "cl", "CHANGELOG.md"), "utf8");
    expect(body).toContain("# Changelog — cl");
    expect(body).toContain(`## ${today}`);
    expect(body).toContain("- first note");
    expect(body).toContain("- second note");

    // A second write REPLACES the file (wholesale, not append) — old entries gone.
    await store.writeChangelog("cl", `## ${today}\n- only the newest`);
    body = await fs.readFile(path.join(root, "cl", "CHANGELOG.md"), "utf8");
    expect(body).toContain("- only the newest");
    expect(body).not.toContain("- first note");
    // A model-supplied top-level heading is dropped so the title isn't doubled.
    await store.writeChangelog("cl", `# Changelog — cl\n\n## ${today}\n- deduped title`);
    body = await fs.readFile(path.join(root, "cl", "CHANGELOG.md"), "utf8");
    expect(body.match(/# Changelog — cl/g)?.length).toBe(1);
    expect(body).toContain("- deduped title");
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

  it("readFileWithKind returns image kind + empty content without UTF-8 mangling (issue #61)", async () => {
    const p = await store.create({ name: "Img" });
    // A 1×1 transparent PNG — real binary bytes with a high byte (0x89) that
    // UTF-8 decoding would turn into a replacement character.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(path.join(p.dir, "pixel.png"), png);

    const wk = await store.readFileWithKind("img", "pixel.png");
    expect(wk).toEqual({ name: "pixel.png", kind: "image", content: "" });

    const raw = await store.readFileBytes("img", "pixel.png");
    expect(raw.mime).toBe("image/png");
    expect(Buffer.compare(raw.bytes, png)).toBe(0); // byte-identical, not mangled
  });

  it("readFileBytes enforces the traversal guard and 404s on miss (issue #61)", async () => {
    await store.create({ name: "Bytes" });
    await expect(store.readFileBytes("bytes", "../../etc/passwd")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(store.readFileBytes("bytes", "nope.png")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("listFiles returns entries (no dotfiles), directories first (#259)", async () => {
    const p = await store.create({ name: "LF" });
    await fs.writeFile(path.join(p.dir, "b.md"), "", "utf8");
    await fs.writeFile(path.join(p.dir, "a.md"), "", "utf8");
    await fs.writeFile(path.join(p.dir, ".secret"), "", "utf8");
    await fs.mkdir(path.join(p.dir, "design"), { recursive: true });
    const entries = await store.listFiles("lf");
    const names = entries.map((e) => e.name);
    // project.yaml + CHANGELOG.md are also files; assert kind + dotfile skip.
    expect(names).toContain("a.md");
    expect(names).toContain("b.md");
    expect(names).not.toContain(".secret");
    expect(entries.find((e) => e.name === "design")?.kind).toBe("dir");
    expect(entries.find((e) => e.name === "a.md")?.kind).toBe("file");
    // Directories sort ahead of files, and each group is alphabetical
    // (case-insensitive localeCompare, so "a.md" sorts near "CHANGELOG.md").
    const byName = (a: string, b: string) => a.localeCompare(b);
    const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.name);
    const files = entries.filter((e) => e.kind === "file").map((e) => e.name);
    expect(names).toEqual([...dirs, ...files]);
    expect(dirs).toEqual([...dirs].sort(byName));
    expect(files).toEqual([...files].sort(byName));
  });

  it("listFiles descends into a subdirectory and guards traversal (#259)", async () => {
    const p = await store.create({ name: "SUB" });
    await fs.mkdir(path.join(p.dir, "design"), { recursive: true });
    await fs.writeFile(path.join(p.dir, "design", "plan.md"), "hi", "utf8");
    const nested = await store.listFiles("sub", "design");
    expect(nested.map((e) => e.name)).toEqual(["plan.md"]);
    // A file (not a directory) reports not_directory so the UI can view it.
    await expect(store.listFiles("sub", "design/plan.md")).rejects.toMatchObject({
      code: "not_directory",
    });
    // A missing directory is not_found.
    await expect(store.listFiles("sub", "nope")).rejects.toMatchObject({
      code: "not_found",
    });
    // Path traversal outside the project dir is rejected.
    await expect(store.listFiles("sub", "../..")).rejects.toMatchObject({
      code: "invalid",
    });
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

  // --- repo-backed projects (issue #187) --------------------------------

  it("notebook project: repoBacked false, workingDir === dir", async () => {
    const p = await store.create({ name: "Notebook" });
    expect(p.repoBacked).toBe(false);
    expect(p.repo).toBeUndefined();
    expect(p.workingDir).toBe(p.dir);
  });

  it("repo-backed create clones the repo, sets workingDir to the checkout, and skips CLAUDE.md", async () => {
    const src = await makeSourceRepo(path.join(root, "_src", "demo.git"));
    const p = await store.create({ name: "Repo Proj", repo: src });

    // DTO: repo-backed, cwd is the nested checkout (named after the repo).
    expect(p.repoBacked).toBe(true);
    expect(p.repo).toBe(src);
    expect(p.workingDir).toBe(path.join(p.dir, "demo"));

    // The repo was actually cloned into the checkout (its files are present).
    expect(await fs.readFile(path.join(p.workingDir, "CLAUDE.md"), "utf8")).toContain(
      "Upstream Repo",
    );
    expect(await fs.access(path.join(p.workingDir, ".git")).then(() => true)).toBe(true);

    // The sweeper-owned per-project CLAUDE.md is NOT seeded at the metadata dir —
    // a repo-backed project defers to the repo's OWN CLAUDE.md (in the checkout).
    await expect(fs.access(path.join(p.dir, "CLAUDE.md"))).rejects.toBeTruthy();

    // OVERVIEW/CHANGELOG are still sidecarred in the metadata dir.
    expect(await fs.readFile(path.join(p.dir, "CHANGELOG.md"), "utf8")).toContain(
      "Project opened.",
    );

    // A sidecar .gitignore keeps the nested checkout out of the data repo.
    const gi = await fs.readFile(path.join(p.dir, ".gitignore"), "utf8");
    expect(gi).toContain("/demo/");
    expect(gi).toContain("/.chats/");

    // `repo` persists in project.yaml and round-trips through get().
    const parsed = YAML.parse(await fs.readFile(path.join(p.dir, "project.yaml"), "utf8"));
    expect(parsed.repo).toBe(src);
    const reread = await store.get(p.slug);
    expect(reread.repoBacked).toBe(true);
    expect(reread.workingDir).toBe(path.join(p.dir, "demo"));
  });

  it("repo-backed create rejects an invalid repo URL without leaving a project behind", async () => {
    await expect(store.create({ name: "Bad", repo: "not a url" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(store.exists("bad")).resolves.toBe(false);
  });

  it("repo-backed create rolls back the dir when the clone fails", async () => {
    // A well-formed but nonexistent local path is a valid URL that git can't clone.
    const bogus = path.join(root, "_src", "does-not-exist.git");
    await expect(store.create({ name: "Ghost", repo: bogus })).rejects.toMatchObject({
      code: "invalid",
    });
    // The half-created project dir was cleaned up.
    await expect(store.exists("ghost")).resolves.toBe(false);
    await expect(fs.access(path.join(root, "ghost"))).rejects.toBeTruthy();
  });

  // --- promote notebook → repo-backed in place (issue #213) --------------

  it("promote clones the repo, flips to repo-backed, and preserves chats + metadata", async () => {
    const src = await makeSourceRepo(path.join(root, "_src", "demo.git"));
    // A notebook with real chat history + notes + a settings override.
    const nb = await store.create({ name: "Note Book", summary: "planning notes" });
    await store.update(nb.slug, { model: "claude-opus-4-8" });
    await store.writeOverview(nb.slug, "# Overview\n\ncurrent state\n");
    await store.writeChangelog(nb.slug, "## 2026-07-21\n- did a thing");
    // Seed a fake transcript in .chats to prove it survives the promotion.
    const chatsDir = path.join(nb.dir, ".chats");
    await fs.mkdir(chatsDir, { recursive: true });
    await fs.writeFile(path.join(chatsDir, "sess-1.jsonl"), '{"type":"user"}\n');
    expect((await store.get(nb.slug)).repoBacked).toBe(false);

    const p = await store.promote(nb.slug, src);

    // DTO flips to repo-backed; cwd is the nested checkout named after the repo.
    expect(p.repoBacked).toBe(true);
    expect(p.repo).toBe(src);
    expect(p.workingDir).toBe(path.join(p.dir, "demo"));
    expect(p.dir).toBe(nb.dir); // same metadata dir — in place, no move

    // Repo actually cloned into the checkout.
    expect(await fs.readFile(path.join(p.workingDir, "CLAUDE.md"), "utf8")).toContain("Upstream Repo");
    expect(await fs.access(path.join(p.workingDir, ".git")).then(() => true)).toBe(true);

    // The notebook's sweeper-owned CLAUDE.md is dropped (defer to the repo's own).
    await expect(fs.access(path.join(p.dir, "CLAUDE.md"))).rejects.toBeTruthy();

    // Chats + sidecar metadata + settings all preserved.
    expect(await fs.readFile(path.join(chatsDir, "sess-1.jsonl"), "utf8")).toContain('"type":"user"');
    expect(await fs.readFile(path.join(p.dir, "OVERVIEW.md"), "utf8")).toContain("current state");
    expect(await fs.readFile(path.join(p.dir, "CHANGELOG.md"), "utf8")).toContain("did a thing");
    expect(p.summary).toBe("planning notes");
    expect(p.model).toBe("claude-opus-4-8");

    // Sidecar .gitignore covers the checkout + transcript store.
    const gi = await fs.readFile(path.join(p.dir, ".gitignore"), "utf8");
    expect(gi).toContain("/demo/");
    expect(gi).toContain("/.chats/");

    // Persisted + round-trips through get().
    const reread = await store.get(p.slug);
    expect(reread.repoBacked).toBe(true);
    expect(reread.workingDir).toBe(path.join(p.dir, "demo"));
    expect(reread.repo).toBe(src);
  });

  it("promote rejects an already-repo-backed project", async () => {
    const src = await makeSourceRepo(path.join(root, "_src", "demo.git"));
    const p = await store.create({ name: "Already", repo: src });
    await expect(store.promote(p.slug, src)).rejects.toMatchObject({ code: "invalid" });
  });

  it("promote rejects an invalid repo URL and leaves the notebook untouched", async () => {
    const nb = await store.create({ name: "Keep Me" });
    await expect(store.promote(nb.slug, "not a url")).rejects.toMatchObject({ code: "invalid" });
    const reread = await store.get(nb.slug);
    expect(reread.repoBacked).toBe(false);
    // The notebook's CLAUDE.md is still there (nothing was mutated).
    expect(await fs.access(path.join(nb.dir, "CLAUDE.md")).then(() => true)).toBe(true);
  });

  it("promote rolls back on clone failure, leaving the notebook fully intact", async () => {
    const nb = await store.create({ name: "Survivor", summary: "keep my notes" });
    const chatsDir = path.join(nb.dir, ".chats");
    await fs.mkdir(chatsDir, { recursive: true });
    await fs.writeFile(path.join(chatsDir, "sess-x.jsonl"), '{"type":"user"}\n');

    // A well-formed but nonexistent local path is a valid URL git can't clone.
    const bogus = path.join(root, "_src", "does-not-exist.git");
    await expect(store.promote(nb.slug, bogus)).rejects.toMatchObject({ code: "invalid" });

    // Still a notebook, chats + CLAUDE.md + summary intact, no stray checkout dir.
    const reread = await store.get(nb.slug);
    expect(reread.repoBacked).toBe(false);
    expect(reread.repo).toBeUndefined();
    expect(reread.summary).toBe("keep my notes");
    expect(await fs.access(path.join(nb.dir, "CLAUDE.md")).then(() => true)).toBe(true);
    expect(await fs.readFile(path.join(chatsDir, "sess-x.jsonl"), "utf8")).toContain('"type":"user"');
    await expect(fs.access(path.join(nb.dir, repoCheckoutName(bogus)))).rejects.toBeTruthy();
  });

  it("promote refuses to clobber an existing checkout-named directory", async () => {
    const src = await makeSourceRepo(path.join(root, "_src", "demo.git"));
    const nb = await store.create({ name: "Occupied" });
    // A pre-existing `demo/` dir (the derived checkout name) blocks the promote.
    await fs.mkdir(path.join(nb.dir, "demo"), { recursive: true });
    await fs.writeFile(path.join(nb.dir, "demo", "keep.txt"), "mine\n");
    await expect(store.promote(nb.slug, src)).rejects.toMatchObject({ code: "exists" });
    // Untouched: still a notebook, the pre-existing dir + its file survive.
    expect((await store.get(nb.slug)).repoBacked).toBe(false);
    expect(await fs.readFile(path.join(nb.dir, "demo", "keep.txt"), "utf8")).toBe("mine\n");
  });
});

/** Patch fields into a project's on-disk yaml (test helper). */
async function patchYaml(root: string, slug: string, patch: Record<string, unknown>) {
  const file = path.join(root, slug, "project.yaml");
  const parsed = YAML.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, YAML.stringify({ ...parsed, ...patch }), "utf8");
}
