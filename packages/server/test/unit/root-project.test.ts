import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  ProjectStore,
  ProjectError,
  ROOT_SLUG,
  isRootSlug,
  slugify,
} from "../../src/projects.js";
import { SLUG_RE } from "../../src/project-paths.js";
import { keeperAgentName, sweeperAgentName } from "../../src/herdctl-agent-names.js";
import { buildKeeperConfig } from "../../src/herdctl-agent-config.js";
import { AGENT_NAME_PATTERN } from "@herdctl/core";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";
import type { PaddockConfig } from "../../src/config.js";

/**
 * "The root is a project" (issue #516) — Phase 1: root project RESOLUTION.
 *
 * The whole design rests on a small set of claims that are cheap to assert and
 * expensive to get wrong, so each gets a test: the sentinel is uncreatable by a
 * user, `dirFor` is the ONE resolution seam, the root stays out of enumeration,
 * existence is the gate, the destructive paths refuse it, and the herdctl agent
 * name it implies is actually legal.
 */
describe("root project (#516) — resolution", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-root-");
    store = new ProjectStore(root);
    await store.init();
  });
  afterEach(() => rmTmpDir(root));

  it("reserves a slug no user can ever create", () => {
    // SLUG_RE rejects underscores, so neither create() nor slugify() can mint it.
    expect(SLUG_RE.test(ROOT_SLUG)).toBe(false);
    expect(slugify("__root__")).not.toBe(ROOT_SLUG);
    expect(isRootSlug(ROOT_SLUG)).toBe(true);
    expect(isRootSlug("root")).toBe(false);
  });

  it("rejects an explicit attempt to create the sentinel as a normal project", async () => {
    await expect(store.create({ name: "Root", slug: ROOT_SLUG })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("has no root project until <projectsRoot>/project.yaml exists", async () => {
    expect(await store.getRoot()).toBeNull();
    expect(await store.exists(ROOT_SLUG)).toBe(false);
    await expect(store.get(ROOT_SLUG)).rejects.toBeInstanceOf(ProjectError);
  });

  it("resolves the root project to projectsRoot itself, as dir AND workingDir", async () => {
    const created = await store.createRoot({ name: "Homelab", summary: "the instance root" });
    expect(created.slug).toBe(ROOT_SLUG);
    expect(created.dir).toBe(root);
    // Never repo-backed: the root's dir already IS the instance's backing repo.
    expect(created.workingDir).toBe(root);
    expect(created.repoBacked).toBe(false);

    const got = await store.get(ROOT_SLUG);
    expect(got.dir).toBe(root);
    expect(got.name).toBe("Homelab");
    expect(got.summary).toBe("the instance root");
    // The record lands AT the projects root, not in a subdirectory.
    const raw = YAML.parse(await fs.readFile(path.join(root, "project.yaml"), "utf8"));
    expect(raw.slug).toBe(ROOT_SLUG);
  });

  it("defaults the root's name to the directory basename", async () => {
    const created = await store.createRoot();
    expect(created.name).toBe(path.basename(root));

    // …and a hand-written record with no `name` reads the same way.
    await fs.writeFile(path.join(root, "project.yaml"), YAML.stringify({ slug: ROOT_SLUG }));
    expect((await store.get(ROOT_SLUG)).name).toBe(path.basename(root));
  });

  it("keeps the root OUT of list() — enumeration only walks subdirectories", async () => {
    await store.createRoot({ name: "Root" });
    await store.create({ name: "Alpha" });
    const slugs = (await store.list()).map((p) => p.slug);
    expect(slugs).toEqual(["alpha"]);
    expect(slugs).not.toContain(ROOT_SLUG);
  });

  it("refuses to create the root twice", async () => {
    await store.createRoot();
    await expect(store.createRoot()).rejects.toMatchObject({ code: "exists" });
  });

  it("gitignores the root's .chats/ the way project chats already are", async () => {
    await store.createRoot();
    const ignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("/.chats/");
  });

  it("preserves an existing root .gitignore, and is idempotent about .chats", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "clones/\n.chats/\n");
    await store.createRoot();
    const ignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("clones/");
    // The equivalent `.chats/` form already covers it — don't append a duplicate.
    expect(ignore.match(/\.chats\//g)).toHaveLength(1);
  });

  it("refuses to delete the root project (its dir is the whole projects root)", async () => {
    await store.createRoot();
    await store.create({ name: "Alpha" });
    await expect(store.remove(ROOT_SLUG)).rejects.toMatchObject({ code: "invalid" });
    // Nothing was removed.
    expect(await store.getRoot()).not.toBeNull();
    expect((await store.list()).map((p) => p.slug)).toEqual(["alpha"]);
  });

  it("refuses to promote the root to repo-backed", async () => {
    await store.createRoot();
    await expect(store.promote(ROOT_SLUG, "/tmp/whatever")).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("supports ordinary metadata edits, writing back to <projectsRoot>/project.yaml", async () => {
    await store.createRoot({ name: "Root" });
    const updated = await store.update(ROOT_SLUG, { summary: "edited", model: "claude-opus-5" });
    expect(updated.summary).toBe("edited");
    expect(updated.slug).toBe(ROOT_SLUG);
    const raw = YAML.parse(await fs.readFile(path.join(root, "project.yaml"), "utf8"));
    expect(raw.summary).toBe("edited");
  });

  it("reads and writes the root's OVERVIEW/CHANGELOG at the projects root", async () => {
    await store.createRoot();
    await store.writeOverview(ROOT_SLUG, "# Root overview\n");
    expect(await fs.readFile(path.join(root, "OVERVIEW.md"), "utf8")).toContain("Root overview");
    expect(await store.readOverview(ROOT_SLUG)).toContain("Root overview");
    await store.writeChangelog(ROOT_SLUG, "- did a thing\n");
    expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8")).toContain("did a thing");
  });
});

describe("root project (#516) — the keeper is an ordinary keeper", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-root-agent-");
    store = new ProjectStore(root);
    await store.init();
  });
  afterEach(() => rmTmpDir(root));

  it("implies herdctl agent names that are actually legal", () => {
    // The design flagged this as an assumption, not a fact. herdctl's
    // AGENT_NAME_PATTERN allows underscores after the first character.
    expect(AGENT_NAME_PATTERN.test(keeperAgentName(ROOT_SLUG))).toBe(true);
    expect(AGENT_NAME_PATTERN.test(sweeperAgentName(ROOT_SLUG))).toBe(true);
    expect(keeperAgentName(ROOT_SLUG)).toBe("keeper-__root__");
  });

  it("builds a keeper config rooted at projectsRoot with max_concurrent SET", async () => {
    const project = await store.createRoot({ name: "Root" });
    const cfg = { nativeSystemPrompt: true, browserMcp: false } as unknown as PaddockConfig;
    const config = buildKeeperConfig(cfg, project);
    expect(config.name).toBe("keeper-__root__");
    expect(config.working_directory).toBe(root);
    // Scratch omits `instances`, so herdctl serializes its turns at 1. The root
    // is a keeper and must NOT repeat that (design decision, #516 Phase 1).
    expect(config.instances).toEqual({ max_concurrent: 10 });
  });
});
