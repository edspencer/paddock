/**
 * The root ("scratch") agent's working directory — issue #512.
 *
 * `nativeSystemPrompt` defaults to true, so Paddock sets NO `system_prompt` for
 * the scratch agent: 100% of a root chat's standing instructions come from
 * Claude Code's own CLAUDE.md walk-up from the cwd. The cwd is therefore
 * load-bearing, and it used to point at `<dataDir>/scratch` — a SIBLING of the
 * backing repo, with nothing above it, so root chats silently started with zero
 * instance context.
 *
 * The cwd is now `projectsRoot`: the instance's backing repo checkout, whose
 * top-level `CLAUDE.md` is the canonical instance-wide one (it's inside the repo,
 * so it's version-controlled and pushed with everything else). These tests pin
 * that, and pin that the change is about the cwd ONLY — the transcript store
 * stays out of the repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { buildScratchConfig, buildKeeperConfig } from "../../src/herdctl-agent-config.js";
import { loadPaddockConfig, type PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const cfg = (over: Partial<PaddockConfig> = {}): PaddockConfig =>
  ({
    dataDir: "/data",
    projectsRoot: "/data/projects",
    scratchDir: "/data/scratch",
    scratchWorkingDir: "/data/projects",
    nativeSystemPrompt: true,
    ...over,
  }) as PaddockConfig;

describe("scratch agent working directory (#512)", () => {
  it("runs in the backing repo checkout (projectsRoot), NOT the scratch dir", () => {
    const c = cfg();
    expect(buildScratchConfig(c).working_directory).toBe(c.projectsRoot);
    expect(buildScratchConfig(c).working_directory).not.toBe(c.scratchDir);
  });

  it("puts the instance CLAUDE.md (<projectsRoot>/CLAUDE.md) on the cwd walk-up", () => {
    const c = cfg();
    const cwd = buildScratchConfig(c).working_directory as string;
    const instanceClaudeMd = path.join(c.projectsRoot, "CLAUDE.md");
    // Claude Code walks UP from the cwd, so the file must be in the cwd or an
    // ancestor of it. Under the old cwd (<dataDir>/scratch) it was in neither.
    expect(path.dirname(instanceClaudeMd)).toBe(cwd);
    expect(path.relative(c.scratchDir, instanceClaudeMd).startsWith("..")).toBe(true);
  });

  it("shares that ancestor with every keeper — one two-level native-context model", () => {
    const c = cfg();
    const project = {
      slug: "demo",
      name: "Demo",
      dir: "/data/projects/demo",
      workingDir: "/data/projects/demo/checkout",
    } as unknown as Project;
    const keeperCwd = buildKeeperConfig(c, project).working_directory as string;
    const scratchCwd = buildScratchConfig(c).working_directory as string;
    // Both sit at-or-below projectsRoot, so <projectsRoot>/CLAUDE.md is reachable
    // from both by the same mechanism (no special-casing for the root).
    expect(path.relative(c.projectsRoot, keeperCwd).startsWith("..")).toBe(false);
    expect(path.relative(c.projectsRoot, scratchCwd).startsWith("..")).toBe(false);
  });

  it("still sets NO system_prompt when native (the walk-up IS the whole mechanism)", () => {
    expect(buildScratchConfig(cfg()).system_prompt).toBeUndefined();
    expect(buildScratchConfig(cfg({ nativeSystemPrompt: false })).system_prompt).toBeTruthy();
  });

});

const ENV_KEYS = ["PADDOCK_DATA_DIR", "PADDOCK_PROJECTS_DIR", "PADDOCK_SCRATCH_DIR"];

describe("loadPaddockConfig: scratchWorkingDir (#512)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-scratch-cfg-");
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("is the projects root, and the scratch STORE stays a separate dir", () => {
    const cfg = loadPaddockConfig();
    expect(cfg.scratchWorkingDir).toBe(cfg.projectsRoot);
    expect(cfg.scratchDir).not.toBe(cfg.projectsRoot);
    expect(cfg.scratchDir).toBe(path.join(dataDir, "scratch"));
  });

  it("still honours PADDOCK_SCRATCH_DIR — as the store, not the cwd", () => {
    process.env.PADDOCK_SCRATCH_DIR = path.join(dataDir, "elsewhere");
    const cfg = loadPaddockConfig();
    expect(cfg.scratchDir).toBe(path.join(dataDir, "elsewhere"));
    expect(cfg.scratchWorkingDir).toBe(cfg.projectsRoot);
  });

  it("follows PADDOCK_PROJECTS_DIR (the cwd IS the backing repo, wherever it is)", () => {
    process.env.PADDOCK_PROJECTS_DIR = path.join(dataDir, "repo");
    const cfg = loadPaddockConfig();
    expect(cfg.scratchWorkingDir).toBe(path.join(dataDir, "repo"));
  });
});
