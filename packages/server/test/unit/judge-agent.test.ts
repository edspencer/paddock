/**
 * The `judge-<slug>` agent (`chat-judge.ts`): its herdctl config, when it is
 * registered and torn down, that its chats stay out of every chat list, and the
 * `judge` instance config that drives it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HerdctlService,
  judgeAgentName,
  keeperSlugFromAgent,
  visibleProjectAgentNames,
} from "../../src/herdctl.js";
import { buildJudgeConfig, judgeWorkingDir } from "../../src/herdctl-agent-config.js";
import { loadPaddockConfig, type PaddockConfig } from "../../src/config.js";
import { DEFAULT_JUDGE } from "../../src/judge-config.js";
import type { Project } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const project = (over: Record<string, unknown> = {}): Project =>
  ({
    slug: "demo",
    name: "Demo",
    dir: "/tmp/demo",
    workingDir: "/tmp/demo",
    hooks: { h: {} },
    triggers: { t: {} },
    ...over,
  }) as unknown as Project;

describe("judge agent naming and visibility", () => {
  it("names the judge per project, the root included", () => {
    expect(judgeAgentName("demo")).toBe("judge-demo");
    expect(judgeAgentName("")).toBe("judge-_root");
  });

  it("is never a listed chat agent, and is not a keeper", () => {
    expect(visibleProjectAgentNames(project())).not.toContain(judgeAgentName("demo"));
    expect(keeperSlugFromAgent(judgeAgentName("demo"))).toBeNull();
  });
});

describe("buildJudgeConfig", () => {
  const cfg = { dataDir: "/data", judge: { enabled: true, model: "claude-sonnet-5" } };

  it("is a tool-less one-shot CLI agent in its own directory", () => {
    const c = buildJudgeConfig(cfg as PaddockConfig, project());
    expect(c).toMatchObject({
      name: "judge-demo",
      runtime: "cli",
      model: "claude-sonnet-5",
      allowed_tools: [],
      working_directory: "/data/judges/demo",
    });
    expect(c.max_turns).toBeLessThanOrEqual(2);
    expect(c).not.toHaveProperty("mcp_servers");
    expect(String(c.system_prompt)).toContain("DO NOT use any tools");
    expect(judgeWorkingDir(cfg as PaddockConfig, "")).toBe("/data/judges/_root");
  });

  it("falls back to the default model with no judge block", () => {
    const c = buildJudgeConfig({ dataDir: "/data" } as PaddockConfig, project());
    expect(c.model).toBe(DEFAULT_JUDGE.model);
  });
});

describe("HerdctlService judge registration", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-judge-agent-");
  });
  afterEach(() => rmTmpDir(dataDir));

  const svcWithFakeFleet = (judge?: { enabled: boolean; model: string }) => {
    const added: string[] = [];
    const removed: string[] = [];
    const svc = new HerdctlService({
      dataDir,
      claudeHome: `${dataDir}/claude-home`,
      legacyClaudeHome: `${dataDir}/user-claude`,
      claude: { transcripts: "own" },
      ...(judge ? { judge } : {}),
    } as unknown as PaddockConfig);
    (svc as unknown as { fleet: unknown }).fleet = {
      addAgent: vi.fn(async (c: { name: string }) => {
        added.push(c.name);
      }),
      removeAgent: vi.fn(async (name: string) => {
        removed.push(name);
      }),
    };
    return { svc, added, removed };
  };
  const p = () => project({ dir: dataDir, workingDir: dataDir, hooks: {}, triggers: {} });

  it("registers judge-<slug> alongside the keeper and sweeper when enabled", async () => {
    const { svc, added } = svcWithFakeFleet({ enabled: true, model: DEFAULT_JUDGE.model });
    await svc.ensureProjectAgent(p());
    expect(added).toEqual(["keeper-demo", "sweeper-demo", "judge-demo"]);
  });

  it("registers no judge when disabled or unconfigured", async () => {
    for (const judge of [{ enabled: false, model: DEFAULT_JUDGE.model }, undefined]) {
      const { svc, added } = svcWithFakeFleet(judge);
      await svc.ensureProjectAgent(p());
      expect(added).not.toContain("judge-demo");
    }
  });

  it("tears the judge down with the project regardless of the setting", async () => {
    const { svc, removed } = svcWithFakeFleet();
    await svc.removeProjectAgent("demo");
    expect(removed).toContain("judge-demo");
  });
});

describe("judge instance config", () => {
  const KEYS = [
    "PADDOCK_DATA_DIR",
    "PADDOCK_JUDGE_ENABLED",
    "PADDOCK_JUDGE_MODEL",
    "PADDOCK_CONFIG",
  ];
  const saved: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(async () => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = await makeTmpDir("paddock-judge-config-");
    process.env.PADDOCK_DATA_DIR = dir;
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dir);
  });

  it("defaults to on, on the sweeper's model", () => {
    expect(loadPaddockConfig().judge).toEqual({
      enabled: true,
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("reads the env vars, and ignores an unknown model", () => {
    process.env.PADDOCK_JUDGE_ENABLED = "0";
    process.env.PADDOCK_JUDGE_MODEL = "claude-sonnet-5";
    expect(loadPaddockConfig().judge).toEqual({ enabled: false, model: "claude-sonnet-5" });
    process.env.PADDOCK_JUDGE_MODEL = "gpt-nope";
    expect(loadPaddockConfig().judge.model).toBe(DEFAULT_JUDGE.model);
  });
});
