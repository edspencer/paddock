import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProjectStore, ROOT_KEY, isRootKey, slugify } from "../../src/projects.js";
import { SLUG_RE, ROOT_AGENT_KEY, agentKeyFor } from "../../src/project-paths.js";
import {
  keeperAgentName,
  keeperSlugFromAgent,
  sweeperAgentName,
  hookAgentName,
  triggerAgentName,
} from "../../src/herdctl-agent-names.js";
import { buildKeeperConfig } from "../../src/herdctl-agent-config.js";
import { AGENT_NAME_PATTERN } from "@herdctl/core";
import { childOf, HUMAN_ROOT } from "../../src/run-provenance.js";
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
 * The workspace model (#531) — root workspace RESOLUTION.
 *
 * A workspace is keyed by its path RELATIVE to `projectsRoot`, so the root's key
 * is the empty string and `dirFor` is `path.join(root, key)` — one seam, no
 * branch. The claims that model rests on are cheap to assert and expensive to
 * get wrong, so each gets a test: the root always exists (no `project.yaml`
 * gate), it never appears in enumeration, the destructive/repo-backing paths
 * refuse it, and every derived herdctl agent name is actually legal.
 */
describe("root workspace (#531) — resolution", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-root-");
    store = new ProjectStore(root);
    await store.init();
  });
  afterEach(() => rmTmpDir(root));

  it("keys the root as the empty relative path, which no project slug can be", () => {
    expect(isRootKey(ROOT_KEY)).toBe(true);
    expect(ROOT_KEY).toBe("");
    expect(isRootKey("root")).toBe(false);
    // A project key is a slug, and SLUG_RE requires at least one character — so
    // the root's key is not merely reserved, it is unreachable by construction.
    expect(SLUG_RE.test(ROOT_KEY)).toBe(false);
    expect(slugify("")).toBe("");
  });

  it("RESOLVES the root with no project.yaml on disk at all — existence is not a record", async () => {
    // The old model gated the root on `<projectsRoot>/project.yaml` and returned
    // null until someone created it (the Enable card, and "Project not found:
    // __root" on every fresh instance). The root IS the instance directory: it
    // always exists, and an absent record just means nothing is customised yet.
    await expect(fs.access(path.join(root, "project.yaml"))).rejects.toBeTruthy();

    expect(await store.exists(ROOT_KEY)).toBe(true);
    const got = await store.get(ROOT_KEY);
    expect(got.slug).toBe(ROOT_KEY);
    expect(got.dir).toBe(root);
    // Never repo-backed: the root's dir already IS the instance's backing repo.
    expect(got.workingDir).toBe(root);
    expect(got.repoBacked).toBe(false);
  });

  it("defaults the root's name to the projects-root directory basename", async () => {
    // No record at all.
    expect((await store.get(ROOT_KEY)).name).toBe(path.basename(root));

    // …and a hand-written record with no `name` reads the same way.
    await fs.writeFile(path.join(root, "project.yaml"), YAML.stringify({ summary: "hi" }));
    const got = await store.get(ROOT_KEY);
    expect(got.name).toBe(path.basename(root));
    expect(got.summary).toBe("hi");
  });

  it("keeps the root OUT of list() — enumeration only walks CHILDREN", async () => {
    await store.create({ name: "Alpha" });
    const slugs = (await store.list()).map((p) => p.slug);
    expect(slugs).toEqual(["alpha"]);
    expect(slugs).not.toContain(ROOT_KEY);
    // Belt and braces: even once the root HAS a record, it stays out.
    await store.update(ROOT_KEY, { summary: "now recorded" });
    expect((await store.list()).map((p) => p.slug)).toEqual(["alpha"]);
  });

  it("gitignores the root's .chats/ at init(), the way project chats already are", async () => {
    // No creation step: `init()` is housekeeping for a workspace that always exists.
    const ignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("/.chats/");
  });

  it("preserves an existing root .gitignore, and is idempotent about .chats", async () => {
    const other = await makeTmpDir("paddock-root-ignore-");
    try {
      await fs.writeFile(path.join(other, ".gitignore"), "clones/\n.chats/\n");
      await new ProjectStore(other).init();
      const ignore = await fs.readFile(path.join(other, ".gitignore"), "utf8");
      expect(ignore).toContain("clones/");
      // The equivalent `.chats/` form already covers it — don't append a duplicate.
      expect(ignore.match(/\.chats\//g)).toHaveLength(1);
    } finally {
      await rmTmpDir(other);
    }
  });

  it("refuses to delete the root workspace (its dir is the whole projects root)", async () => {
    await store.create({ name: "Alpha" });
    await expect(store.remove(ROOT_KEY)).rejects.toMatchObject({ code: "invalid" });
    // Nothing was removed — the root still resolves and its children survive.
    expect((await store.get(ROOT_KEY)).dir).toBe(root);
    expect((await store.list()).map((p) => p.slug)).toEqual(["alpha"]);
    await fs.access(path.join(root, "alpha", "project.yaml"));
  });

  it("refuses to promote the root to repo-backed", async () => {
    await expect(store.promote(ROOT_KEY, "/tmp/whatever")).rejects.toMatchObject({
      code: "invalid",
    });
    expect((await store.get(ROOT_KEY)).repoBacked).toBe(false);
  });

  it("writes project.yaml LAZILY — on the first edit, at <projectsRoot>/project.yaml", async () => {
    await expect(fs.access(path.join(root, "project.yaml"))).rejects.toBeTruthy();
    const updated = await store.update(ROOT_KEY, { summary: "edited", model: "claude-opus-4-5" });
    expect(updated.summary).toBe("edited");
    expect(updated.slug).toBe(ROOT_KEY);
    // The record lands AT the projects root, not in a subdirectory.
    const raw = YAML.parse(await fs.readFile(path.join(root, "project.yaml"), "utf8"));
    expect(raw.summary).toBe("edited");
    // …and it round-trips.
    expect((await store.get(ROOT_KEY)).summary).toBe("edited");
  });

  it("reads and writes the root's OVERVIEW/CHANGELOG at the projects root", async () => {
    await store.writeOverview(ROOT_KEY, "# Root overview\n");
    expect(await fs.readFile(path.join(root, "OVERVIEW.md"), "utf8")).toContain("Root overview");
    expect(await store.readOverview(ROOT_KEY)).toContain("Root overview");
    await store.writeChangelog(ROOT_KEY, "- did a thing\n");
    expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8")).toContain("did a thing");
  });
});

describe("root workspace (#531) — the keeper is an ordinary keeper", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-root-agent-");
    store = new ProjectStore(root);
    await store.init();
  });
  afterEach(() => rmTmpDir(root));

  it("implies herdctl agent names that are legal under BOTH herdctl patterns", () => {
    // REGRESSION TEST. Agent-name legality is the subtler kind of assumption,
    // because herdctl validates agent names in TWO places with DIFFERENT rules:
    //
    //   addAgent      AGENT_NAME_PATTERN     /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
    //   session store SAFE_IDENTIFIER_PATTERN /^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/
    //
    // The previous design's `__root__` passes the first and FAILS the second
    // (trailing underscore), so `keeper-__root__` registered happily and then
    // threw PathTraversalError on the first session resume. `_root` ends
    // alphanumeric, so it satisfies both. All four builders must hold.
    for (const name of [
      keeperAgentName(ROOT_KEY),
      sweeperAgentName(ROOT_KEY),
      hookAgentName(ROOT_KEY, "x"),
      triggerAgentName(ROOT_KEY, "x"),
    ]) {
      expect(AGENT_NAME_PATTERN.test(name), `${name} vs AGENT_NAME_PATTERN`).toBe(true);
      expect(SAFE_IDENTIFIER_PATTERN.test(name), `${name} vs SAFE_IDENTIFIER_PATTERN`).toBe(true);
    }
    expect(keeperAgentName(ROOT_KEY)).toBe("keeper-_root");
    expect(sweeperAgentName(ROOT_KEY)).toBe("sweeper-_root");
    expect(hookAgentName(ROOT_KEY, "x")).toBe("hook-_root-x");
    expect(triggerAgentName(ROOT_KEY, "x")).toBe("trigger-_root-x");
  });

  it("encodes the root ONLY in the agent namespace, and cannot collide with a slug", () => {
    // `agentKeyFor` is the single boundary encoding — a project key rides through
    // untouched, so no builder needs a root branch.
    expect(agentKeyFor(ROOT_KEY)).toBe(ROOT_AGENT_KEY);
    expect(agentKeyFor("alpha")).toBe("alpha");
    expect(keeperAgentName("alpha")).toBe("keeper-alpha");
    // SLUG_RE rejects underscores, so no project can ever be named `_root` and
    // steal the root's agent names.
    expect(SLUG_RE.test(ROOT_AGENT_KEY)).toBe(false);
    expect(slugify("_root")).not.toBe(ROOT_AGENT_KEY);
  });

  it("refuses a project whose slug would shadow the root's agent key", async () => {
    await expect(store.create({ name: "Root", slug: ROOT_AGENT_KEY })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it('round-trips keeperSlugFromAgent, and keeps "" DISTINCT from null', () => {
    // The load-bearing one. The root workspace's key IS the empty string, so a
    // falsy check (`if (!slug) return;`) in wake/turn/job routing silently drops
    // EVERY root chat. `null` means "not a keeper agent at all"; `""` means "the
    // root keeper" — callers must compare against null explicitly.
    const rootKey = keeperSlugFromAgent(keeperAgentName(ROOT_KEY));
    expect(rootKey).toBe("");
    expect(rootKey).not.toBeNull();
    expect(rootKey === null).toBe(false);
    expect(typeof rootKey).toBe("string");

    expect(keeperSlugFromAgent("keeper-_root")).toBe("");
    expect(keeperSlugFromAgent("keeper-alpha")).toBe("alpha");
    // Not a keeper at all → null, and that is a DIFFERENT answer from `""`.
    expect(keeperSlugFromAgent("sweeper-foo")).toBeNull();
    expect(keeperSlugFromAgent("sweeper-_root")).toBeNull();
    expect(keeperSlugFromAgent("trigger-_root-x")).toBeNull();
    expect(keeperSlugFromAgent("scratch")).toBeNull();
  });

  it("builds a keeper config rooted at projectsRoot with max_concurrent SET", async () => {
    const project = await store.get(ROOT_KEY);
    const cfg = { nativeSystemPrompt: true, browserMcp: false } as unknown as PaddockConfig;
    const config = buildKeeperConfig(cfg, project);
    expect(config.name).toBe("keeper-_root");
    expect(config.working_directory).toBe(root);
    // An agent that omits `instances` gets serialized at 1 concurrent turn. The
    // root keeper is an ordinary keeper and must NOT be serialized.
    expect(config.instances).toEqual({ max_concurrent: 10 });
  });
});

/**
 * Chat lineage across the root. `parentProject` is an unvalidated string end to
 * end, so a root chat's lineage edge is RECORDED like any other — carrying the
 * root's key, `""`. These lock the recording half in so a future narrowing
 * doesn't silently orphan root chats.
 *
 * NOTE: the RESOLUTION half is currently NOT true of the root — `chat-dto.ts`
 * (`makeParentResolver`) and `run-provenance.ts` (`parseProvenance`) both gate
 * the edge on a TRUTHY `parentProject`, which drops `""`. That is precisely the
 * falsy-check hazard the keeper-name round-trip test above exists to guard
 * against, and it wants a src fix rather than a test change; it is called out in
 * the report accompanying this change rather than encoded as a failing test.
 */
describe("root workspace (#531) — chat lineage carries the root key", () => {
  it("stamps a recorded edge whose parent lives at the root", () => {
    expect(childOf(HUMAN_ROOT, { project: ROOT_KEY, sessionId: "abc" })).toEqual({
      origin: "spawned",
      depth: 1,
      parentSessionId: "abc",
      parentProject: ROOT_KEY,
    });
  });

  it("keeps the root's parent edge distinguishable from an absent one", () => {
    const rooted = childOf(HUMAN_ROOT, { project: ROOT_KEY, sessionId: "abc" });
    const orphan = childOf(HUMAN_ROOT);
    // `""` is a RECORDED project, not a missing one.
    expect("parentProject" in rooted).toBe(true);
    expect(rooted.parentProject).toBe("");
    expect("parentProject" in orphan).toBe(false);
    expect(orphan.parentProject).toBeUndefined();
  });
});
