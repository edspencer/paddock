/**
 * What an EMPTY `allowed_tools` actually does downstream (issue #647).
 *
 * Paddock expresses "tool-less" as `allowed_tools: []` — the sweeper
 * (`buildSweeperConfig`) and any event trigger with `run.tools: []`
 * (`triggerToAgentToolConfig`). Several comments used to claim that the CLI
 * runtime "then denies every tool". It does not: BOTH herdctl runtimes emit the
 * allow-list only when it is NON-EMPTY, so an empty list is indistinguishable
 * from an unset one and the agent gets Claude Code's default tool behaviour.
 *
 * The existing tests only assert the config VALUE (`allowed_tools` === `[]`),
 * never what the runtime does with it — which is exactly how the false comment
 * survived. These assertions pin the real herdctl argument/option construction
 * for `^5.31.0`, against the real public API in both runtimes:
 *
 *  - CLI: `new CLIRuntime({ processSpawner })` — a documented injection seam;
 *    we capture the argv herdctl would hand `claude` and never spawn anything.
 *  - SDK: `toSDKOptions()` — herdctl's exported agent→SDK-options projection.
 *
 * HONESTY NOTE: this is a BEHAVIOUR PIN, not a fail-first regression test. The
 * #647 fix was a comment/copy correction, so nothing here failed before it. Its
 * job is to make the corrected comments load-bearing: if someone implements the
 * enforcement in #319 (a `disallowedTools` complement, a sentinel, or
 * `canUseTool`) without revisiting those comments, this fails loudly and points
 * at them.
 */
import { describe, it, expect } from "vitest";
import { toSDKOptions } from "@herdctl/core";
// `CLIRuntime` is not re-exported from the package root, so the CLI half has to
// reach for the module the issue cites by path. That is deliberate: the whole
// point is to assert against herdctl's REAL argv builder rather than a local
// re-implementation of it. If herdctl ever moves the file, this fails at import
// — loudly, which is the correct outcome for a claim about its behaviour.
import { CLIRuntime } from "@herdctl/core/dist/runner/runtime/cli-runtime.js";
import { triggerToAgentToolConfig } from "../../src/trigger-config.js";
import { buildSweeperConfig } from "../../src/herdctl-agent-config.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";

const cfg = { dataDir: "/tmp/data" } as PaddockConfig;
const project = { slug: "demo", name: "Demo", dir: "/tmp/demo" } as unknown as Project;

/** Sentinel thrown by the fake spawner — argv is built before the spawn call. */
class Spawned extends Error {}

/**
 * Run herdctl's REAL CLI argument construction for an agent config and return the
 * argv it would have passed to `claude`. The spawner throws instead of spawning,
 * so nothing runs and no session directory is touched.
 */
async function cliArgsFor(agent: Record<string, unknown>): Promise<string[]> {
  let captured: string[] = [];
  const runtime = new CLIRuntime({
    processSpawner: ((args: string[]) => {
      captured = args;
      throw new Spawned();
    }) as never,
  });
  try {
    // Draining the async iterable is what runs the arg-building body; the
    // runtime turns the spawner's throw into an error result and finishes.
    for await (const _ of runtime.execute({
      prompt: "curate",
      agent: { name: "t", working_directory: "/tmp/demo", ...agent } as never,
    } as never)) {
      // no-op — we only care about the argv the spawner was handed
    }
  } catch (err) {
    if (!(err instanceof Spawned)) throw err;
  }
  if (captured.length === 0) throw new Error("the fake spawner was never called");
  return captured;
}

describe("an empty allowed_tools is not a tool-less agent (#647)", () => {
  it("CLI runtime: allowed_tools:[] emits NO --allowedTools flag", async () => {
    const args = await cliArgsFor({ allowed_tools: [] });
    expect(args).not.toContain("--allowedTools");
    // …and nothing else stands in for it: no deny-all, no sentinel.
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--tools");
  });

  it("CLI runtime: a NON-empty allowed_tools does emit the flag (the control)", async () => {
    const args = await cliArgsFor({ allowed_tools: ["Read", "Bash"] });
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Bash");
  });

  it("SDK runtime: allowed_tools:[] sets no allowedTools option at all", () => {
    const opts = toSDKOptions({ name: "t", allowed_tools: [] } as never) as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty("allowedTools");
    expect(opts).not.toHaveProperty("disallowedTools");
    // An empty grant is byte-identical to never having declared one.
    expect(opts).toEqual(toSDKOptions({ name: "t" } as never));
  });

  it("SDK runtime: a NON-empty allowed_tools is passed through (the control)", () => {
    const opts = toSDKOptions({ name: "t", allowed_tools: ["Read"] } as never) as Record<
      string,
      unknown
    >;
    expect(opts.allowedTools).toEqual(["Read"]);
  });

  it("a tools:[] EVENT trigger therefore reaches the runtime unrestricted", async () => {
    const agent = triggerToAgentToolConfig({ prompt: "x", session: "new", tools: [] } as never);
    expect(agent.allowed_tools).toEqual([]);
    expect(await cliArgsFor(agent)).not.toContain("--allowedTools");
    expect(toSDKOptions({ name: "t", ...agent } as never)).not.toHaveProperty("allowedTools");
  });

  it("the sweeper's allowed_tools:[] is equally unenforced (it is safe for other reasons)", async () => {
    const sweeper = buildSweeperConfig(cfg, project);
    expect(sweeper.allowed_tools).toEqual([]);
    expect(await cliArgsFor(sweeper as Record<string, unknown>)).not.toContain("--allowedTools");
    // The guarantees that DO hold for the sweeper: a hard turn bound, and a system
    // prompt that tells the model not to use tools. (Plus no injected MCP and a
    // non-interactive `claude -p`, neither of which is visible in this config.)
    expect(sweeper.max_turns).toBe(4);
    expect(String(sweeper.system_prompt)).toMatch(/You DO NOT use any tools/);
  });
});
