import { describe, it, expect, afterEach } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";

/**
 * Host Claude Code plugins through a REAL boot (#700) — including the one thing
 * only the live `FleetManager` can answer: whether `@herdctl/core`'s
 * `AgentConfigSchema` actually keeps the `plugins` key paddock now sets.
 *
 * ## Why that specific assertion is the point of this file
 *
 * The defect class #700 belongs to is "the layer underneath silently narrowed
 * what it accepts". `AgentConfigSchema` is a `z.object`, so a key it has no field
 * for is STRIPPED at `addAgent` with no error — which is exactly how `headers` and
 * `type: sse` were lost for as long as they were (#699), and how a `plugins` array
 * would be lost if this repo were built against anything before `@herdctl/core`
 * 5.32.0. Every unit test in `claude-plugins.test.ts` passes in that world.
 *
 * So the load-bearing test here reads the agent back out of the live fleet, AFTER
 * the schema has had its say. It fails against 5.31.x and passes against 5.32.0,
 * which makes it the regression guard for the dependency as much as for the code.
 *
 * ## What it still does not prove
 *
 * Nothing loads a plugin. There are no plugins on this box, the fixtures are
 * planted directories with a manifest and nothing executable in them, and no turn
 * runs. Whether the CLI, handed `--plugin-dir <dir>`, then loads that directory
 * and connects its MCP servers is the SDK's contract and is verified by neither
 * this repo nor herdctl. That needs a host with a plugin actually installed.
 */
const PLUGINS = { slack: { mcpServers: { chat: { command: "slack-mcp-not-real" } } } };

/** Reach the private builder the same way the other herdctl tests do. */
function keeperConfigFor(t: TestApp, workingDir: string): Record<string, unknown> {
  const svc = t.herdctl as unknown as {
    keeperAgentConfig: (p: Project, m?: string) => Record<string, unknown>;
  };
  return svc.keeperAgentConfig({
    slug: "demo",
    name: "Demo",
    dir: workingDir,
    workingDir,
  } as unknown as Project);
}

describe("integration: host Claude Code plugins reach the runtime (#700)", () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.teardown();
    t = undefined;
  });

  // Was "the default levers" until #878 made `instructions: host` the default
  // from `balanced` up — and that lever IS the plugin gate. Named explicitly.
  it("attaches nothing under instructions: own, with a plugin sitting right there", async () => {
    t = await startTestApp({ hostPlugins: PLUGINS, env: { PADDOCK_PROFILE: "paranoid" } });
    expect(t.cfg.claude.instructions).toBe("own");
    const keeper = keeperConfigFor(t, "/nonexistent/demo");
    expect(keeper.plugins).toBeUndefined();
    expect(keeper.allowed_tools).toBeUndefined();
  });

  it("passes the plugin and its server's tool pattern under both host levers", async () => {
    t = await startTestApp({
      hostPlugins: PLUGINS,
      env: { PADDOCK_CLAUDE_INSTRUCTIONS: "host", PADDOCK_CLAUDE_MCP_SERVERS: "host" },
    });
    const keeper = keeperConfigFor(t, "/nonexistent/demo");
    expect(keeper.plugins).toEqual([
      { type: "local", path: expect.stringContaining("plugins/cache/test-marketplace/slack") },
    ]);
    // Without this the plugin loads, its server connects, and every call to it is
    // auto-denied with no prompt and nothing in the logs.
    expect(keeper.allowed_tools).toContain("mcp__plugin_slack_chat__*");
  });

  /**
   * `claude.instructions` gates the plugin; `claude.mcpServers` gates only its MCP
   * servers, via the SDK's own `skipMcpDiscovery` flag. This is the combination
   * that says the split is real rather than decorative: the plugin's commands,
   * agents and skills are inherited, its servers are not, and no tool pattern is
   * granted for a namespace nothing occupies.
   */
  it("loads the plugin without its servers under `mcpServers: own`", async () => {
    t = await startTestApp({
      hostPlugins: PLUGINS,
      // `mcpServers: own` is the subject of this test, so it is set rather than
      // inherited from a default that #878 moved to `host`.
      env: { PADDOCK_CLAUDE_INSTRUCTIONS: "host", PADDOCK_CLAUDE_MCP_SERVERS: "own" },
    });
    expect(t.cfg.claude.mcpServers).toBe("own");
    const keeper = keeperConfigFor(t, "/nonexistent/demo");
    expect(keeper.plugins).toEqual([
      {
        type: "local",
        path: expect.stringContaining("plugins/cache/test-marketplace/slack"),
        skipMcpDiscovery: true,
      },
    ]);
    expect(keeper.allowed_tools).toBeUndefined();
  });

  /**
   * THE test, per the file header: the agent as the LIVE fleet holds it, i.e.
   * after `AgentConfigSchema.parse`. A `plugins` key the schema does not know is
   * dropped here and nowhere else, so this is what pins the dependency floor.
   */
  it("survives AgentConfigSchema — the key is still there after addAgent", async () => {
    t = await startTestApp({
      hostPlugins: PLUGINS,
      env: { PADDOCK_CLAUDE_INSTRUCTIONS: "host", PADDOCK_CLAUDE_MCP_SERVERS: "host" },
      gitRepo: true,
    });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Plugged", slug: "plugged" },
    });
    const keeper = t.herdctl.manager.getAgents().find((a) => a.name === "keeper-plugged") as
      | { plugins?: unknown[]; allowed_tools?: string[] }
      | undefined;
    expect(keeper?.plugins).toEqual([
      { type: "local", path: expect.stringContaining("plugins/cache/test-marketplace/slack") },
    ]);
    expect(keeper?.allowed_tools).toContain("mcp__plugin_slack_chat__*");
  });
});
