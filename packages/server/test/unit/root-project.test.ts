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
import { AGENT_NAME_PATTERN, type DiscoveredSession } from "@herdctl/core";
import { hookAgentName, triggerAgentName } from "../../src/herdctl-agent-names.js";
import { childOf, HUMAN_ROOT } from "../../src/run-provenance.js";
import { makeParentResolver } from "../../src/chat-dto.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";
import type { PaddockConfig } from "../../src/config.js";

/**
 * herdctl's session-store path-safety guard
 * (`@herdctl/core` `state/utils/path-safety.ts` → `SAFE_IDENTIFIER_PATTERN`).
 * NOT exported from the package's public surface, so it is mirrored here — a
 * drift shows up as the integration resume test failing, which is the real
 * guard; this one just makes the reason legible.
 */
const SAFE_IDENTIFIER_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

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
    expect(slugify("__root")).not.toBe(ROOT_SLUG);
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

  it("implies herdctl agent names that are legal under BOTH herdctl patterns", () => {
    // #516 flagged agent-name legality as an assumption, not a fact — and it is
    // the subtler kind of assumption, because herdctl validates agent names in
    // TWO places with DIFFERENT rules:
    //
    //   addAgent      AGENT_NAME_PATTERN     /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
    //   session store SAFE_IDENTIFIER_PATTERN /^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/
    //
    // The design's original `__root__` passes the first and FAILS the second
    // (trailing underscore), so `keeper-__root__` registers happily and then
    // throws PathTraversalError on the first session resume. Both must hold.
    for (const name of [
      keeperAgentName(ROOT_SLUG),
      sweeperAgentName(ROOT_SLUG),
      hookAgentName(ROOT_SLUG, "x"),
      triggerAgentName(ROOT_SLUG, "x"),
    ]) {
      expect(AGENT_NAME_PATTERN.test(name), `${name} vs AGENT_NAME_PATTERN`).toBe(true);
      expect(SAFE_IDENTIFIER_PATTERN.test(name), `${name} vs SAFE_IDENTIFIER_PATTERN`).toBe(true);
    }
    expect(keeperAgentName(ROOT_SLUG)).toBe("keeper-__root");
  });

  it("builds a keeper config rooted at projectsRoot with max_concurrent SET", async () => {
    const project = await store.createRoot({ name: "Root" });
    const cfg = { nativeSystemPrompt: true, browserMcp: false } as unknown as PaddockConfig;
    const config = buildKeeperConfig(cfg, project);
    expect(config.name).toBe("keeper-__root");
    expect(config.working_directory).toBe(root);
    // Scratch omits `instances`, so herdctl serializes its turns at 1. The root
    // is a keeper and must NOT repeat that (design decision, #516 Phase 1).
    expect(config.instances).toEqual({ max_concurrent: 10 });
  });
});

/**
 * #516 Phase 2 flagged "widen `parent: {project, sessionId}` to accept the
 * sentinel" as work. It turned out to be a no-op: `parentProject` is an
 * unvalidated string end to end (`RunProvenance` sanitises the session id, not
 * the project), so a root chat's lineage edge records and resolves like any
 * other. These lock that in so a future narrowing doesn't silently orphan root
 * chats.
 */
describe("root project (#516) — chat lineage carries the sentinel", () => {
  const session = (sessionId: string): DiscoveredSession =>
    ({
      sessionId,
      workingDirectory: "/w",
      mtime: "2026-07-27T10:00:00.000Z",
      resumable: true,
    }) as DiscoveredSession;

  it("stamps a recorded edge whose parent lives at the root", () => {
    expect(childOf(HUMAN_ROOT, { project: ROOT_SLUG, sessionId: "abc" })).toEqual({
      origin: "spawned",
      depth: 1,
      parentSessionId: "abc",
      parentProject: ROOT_SLUG,
    });
  });

  it("resolves a child of a root chat back to the root project", async () => {
    const parentOf = makeParentResolver(
      {
        get: async () => ({
          origin: "spawned",
          depth: 1,
          parentSessionId: "mgr",
          parentProject: ROOT_SLUG,
        }),
      },
      { parentChat: async () => null },
      ROOT_SLUG,
    );
    expect(await parentOf(session("child"))).toEqual({ project: ROOT_SLUG, sessionId: "mgr" });
  });
});
