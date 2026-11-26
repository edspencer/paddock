/**
 * The keeper and trigger agents read the Claude home on both runtimes.
 *
 * herdctl's SDK adapter defaults any agent with a `working_directory` to
 * `settingSources: ["project"]`, so an SDK turn never read the Claude home's
 * skills, CLAUDE.md, agents, commands or `settings.json`, while a CLI turn read
 * all of them. Paddock now declares Claude Code's own default. These assertions
 * run herdctl's REAL projections, the same seams `empty-allowed-tools-runtime`
 * uses: `toSDKOptions()` for the SDK and `CLIRuntime`'s argv builder for the CLI.
 */
import { describe, it, expect } from "vitest";
import { toSDKOptions } from "@herdctl/core";
import { CLIRuntime } from "@herdctl/core/dist/runner/runtime/cli-runtime.js";
import {
  buildAgentConfig,
  buildSweeperConfig,
  buildTriggerConfig,
} from "../../src/herdctl-agent-config.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";
import type { PaddockTrigger } from "../../src/trigger-config.js";

const cfg = { dataDir: "/tmp/data", nativeSystemPrompt: true } as PaddockConfig;
const project = {
  slug: "demo",
  name: "Demo",
  dir: "/tmp/demo",
  workingDir: "/tmp/demo",
} as unknown as Project;
const trigger = {
  trigger: { type: "schedule", cron: "0 9 * * *" },
  run: { prompt: "hi" },
} as unknown as PaddockTrigger;

const keeper = buildAgentConfig(cfg, project);
const triggerAgent = buildTriggerConfig(cfg, project, "nightly", trigger);

/** Sentinel thrown by the fake spawner — argv is built before the spawn call. */
class Spawned extends Error {}

/** herdctl's real CLI argv for an agent config; the spawner throws, so nothing runs. */
async function cliArgsFor(agent: Record<string, unknown>): Promise<string[]> {
  let captured: string[] = [];
  const runtime = new CLIRuntime({
    processSpawner: ((args: string[]) => {
      captured = args;
      throw new Spawned();
    }) as never,
  });
  try {
    for await (const _ of runtime.execute({
      prompt: "hi",
      agent: agent as never,
    } as never)) {
      // no-op — only the argv matters
    }
  } catch (err) {
    if (!(err instanceof Spawned)) throw err;
  }
  if (captured.length === 0) throw new Error("the fake spawner was never called");
  return captured;
}

describe("setting sources", () => {
  for (const [label, agent] of [
    ["keeper", keeper],
    ["trigger", triggerAgent],
  ] as const) {
    it(`${label}: the SDK runtime loads user, project and local`, () => {
      expect(toSDKOptions(agent as never).settingSources).toEqual(["user", "project", "local"]);
    });

    it(`${label}: the CLI runtime gets its own default restated`, async () => {
      const args = await cliArgsFor(agent);
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("user,project,local");
    });
  }

  it("without the declaration the SDK runtime would load only project", () => {
    const { setting_sources: _, ...undeclared } = keeper;
    expect(toSDKOptions(undeclared as never).settingSources).toEqual(["project"]);
  });

  it("the CLI-only sweeper declares nothing and keeps the CLI default", async () => {
    const sweeper = buildSweeperConfig(cfg, project);
    expect(sweeper).not.toHaveProperty("setting_sources");
    expect(await cliArgsFor(sweeper)).not.toContain("--setting-sources");
  });
});
