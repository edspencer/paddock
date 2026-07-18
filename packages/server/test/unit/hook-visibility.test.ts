/**
 * Chat-list visibility for hook chats (Epic G / G3, GG-5).
 *
 * G3 generalizes the old hard "keeper-only" chat listing to "every project agent
 * EXCEPT the hidden ones": the keeper + each declared `hook-<slug>-<name>` agent are
 * visible, the sweeper stays hidden. These cover the two pure/near-pure seams that
 * back that:
 *   - {@link visibleProjectAgentNames} — which agents' chats a project shows (the
 *     sweeper-stays-hidden regression lives here).
 *   - {@link HookService.getByAgentName} — the reverse-map from a chat's attributed
 *     hook agent back to its truthful-from-config hook DTO (the capability banner).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  visibleProjectAgentNames,
  keeperAgentName,
  sweeperAgentName,
  hookAgentName,
  type HerdctlService,
} from "../../src/herdctl.js";
import { HookService } from "../../src/hooks.js";
import { ProjectStore, type Project } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("visibleProjectAgentNames (GG-5 chat-list filter)", () => {
  const base: Project = {
    slug: "my-proj",
    name: "My Proj",
    dir: "/tmp/my-proj",
    workingDir: "/tmp/my-proj",
  } as Project;

  it("a hook-less project shows ONLY its keeper (sweeper + scratch never listed)", () => {
    const names = visibleProjectAgentNames(base);
    expect(names).toEqual([keeperAgentName("my-proj")]);
    // Regression: the sweeper is the hidden agent — it must never appear.
    expect(names).not.toContain(sweeperAgentName("my-proj"));
    expect(names).not.toContain("scratch");
  });

  it("includes every declared hook agent alongside the keeper", () => {
    const withHooks: Project = {
      ...base,
      hooks: {
        cleanup: { event: "onArchive", enabled: true },
        note: { event: "onArchive", enabled: false }, // disabled hooks still visible
      },
    } as Project;
    const names = visibleProjectAgentNames(withHooks);
    expect(names).toEqual([
      keeperAgentName("my-proj"),
      hookAgentName("my-proj", "cleanup"),
      hookAgentName("my-proj", "note"),
    ]);
    // The sweeper stays hidden even with hooks present.
    expect(names).not.toContain(sweeperAgentName("my-proj"));
  });
});

describe("HookService.getByAgentName (GG-6 reverse-map)", () => {
  let root: string;
  let projects: ProjectStore;
  let hooks: HookService;

  beforeEach(async () => {
    root = await makeTmpDir("paddock-hook-vis-");
    projects = new ProjectStore(root);
    await projects.init();
    // getByAgentName only reads the project record; herdctl arming is unused here.
    hooks = new HookService(projects, {} as unknown as HerdctlService);
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  it("maps a hook agent name back to its truthful-from-config DTO", async () => {
    const p = await projects.create({ name: "Hooked" });
    await projects.setHook(p.slug, "cleanup", {
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"], maxTurns: 9 },
      enabled: true,
    });
    const dto = await hooks.getByAgentName(p.slug, hookAgentName(p.slug, "cleanup"));
    expect(dto).toMatchObject({
      name: "cleanup",
      agentName: hookAgentName(p.slug, "cleanup"),
      event: "onArchive",
      enabled: true,
      capabilities: { allowedTools: ["Bash"], maxTurns: 9 },
    });
  });

  it("returns null for the keeper agent, an unknown hook, or a missing project", async () => {
    const p = await projects.create({ name: "Hooked2" });
    await projects.setHook(p.slug, "cleanup", { event: "onArchive", prompt: "x" });
    expect(await hooks.getByAgentName(p.slug, keeperAgentName(p.slug))).toBeNull();
    expect(await hooks.getByAgentName(p.slug, hookAgentName(p.slug, "ghost"))).toBeNull();
    expect(await hooks.getByAgentName("no-such-project", "hook-x-y")).toBeNull();
  });
});
