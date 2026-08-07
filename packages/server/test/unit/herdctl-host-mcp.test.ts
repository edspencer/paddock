/**
 * The MCP servers paddock attaches, where they are actually observable: the agent
 * config it hands herdctl. Both sources — `claude.mcpServers: host` (#691 step 5)
 * and the instance's own `mcpServers:` block (step 6).
 *
 * `mcp_servers` is the ONE seam that reaches both runtimes — the SDK runtime
 * turns it into `sdkOptions.mcpServers` via `transformMcpServers`, the CLI
 * runtime serialises the same record into `--mcp-config '{"mcpServers":…}'`. So
 * asserting on the agent config is asserting on both, and these tests are what
 * stands in for the live MCP servers this box does not have.
 *
 * Every fixture is SYNTHETIC — a real `~/.claude.json` holds a user's own servers
 * and sometimes their secrets, and is never read here.
 */
import { describe, it, expect } from "vitest";
import {
  buildAgentConfig,
  buildSweeperConfig,
  buildTriggerConfig,
} from "../../src/herdctl-agent-config.js";
import { FLEET_ALLOWED_TOOLS, BROWSER_MCP_TOOL } from "../../src/herdctl-agent-names.js";
import { EMPTY_MCP_SOURCES, parseHostMcpConfig, type McpSources } from "../../src/claude-mcp.js";
import { EMPTY_HOST_PLUGINS, type HostPluginSource } from "../../src/claude-plugins.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";

const cfg = (over: Partial<PaddockConfig> = {}): PaddockConfig =>
  ({
    nativeSystemPrompt: true,
    browserMcp: false,
    dataDir: "/tmp/paddock-fixture",
    ...over,
  }) as unknown as PaddockConfig;

const project = (workingDir = "/home/ed/code/api"): Project =>
  ({
    slug: "api",
    name: "API",
    dir: workingDir,
    workingDir,
    model: "claude-opus-4-8",
  }) as unknown as Project;

/** A synthetic `~/.claude.json` with one server in each of the two scopes. */
const hostConfig = parseHostMcpConfig(
  JSON.stringify({
    mcpServers: { notion: { command: "notion-mcp", args: ["--stdio"] } },
    projects: {
      "/home/ed/code/api": { mcpServers: { pg: { command: "pg-mcp", env: { PGHOST: "db" } } } },
      "/home/ed/code/web": { mcpServers: { figma: { command: "figma-mcp" } } },
    },
  }),
);

describe("buildAgentConfig: claude.mcpServers own vs host (#691)", () => {
  /**
   * THE test for this lever. `own` and `host` differ in exactly one observable
   * way — what paddock hands the runtime — and nothing else about the config
   * moves. Before step 5 both columns were the left one, for everybody.
   */
  it("hands the runtime nothing under `own` and the user's servers under `host`", () => {
    const own = buildAgentConfig(cfg(), project(), undefined, EMPTY_MCP_SOURCES);
    const host = buildAgentConfig(cfg(), project(), undefined, hostConfig);

    expect(own.mcp_servers).toBeUndefined();
    expect(host.mcp_servers).toEqual({
      notion: { command: "notion-mcp", args: ["--stdio"] },
      pg: { command: "pg-mcp", env: { PGHOST: "db" } },
    });
    // Nothing else about the agent changes. An `own` config must stay
    // byte-identical to what shipped before this lever existed.
    expect({ ...own, mcp_servers: undefined, allowed_tools: undefined }).toEqual({
      ...host,
      mcp_servers: undefined,
      allowed_tools: undefined,
    });
  });

  /**
   * Without this the lever ships as a no-op with no error to search for: both
   * runtimes auto-deny any tool missing from an explicit `allowed_tools`, so an
   * attached-but-unlisted server connects and then has every call refused.
   * herdctl auto-adds the patterns for INJECTED servers only — config
   * `mcp_servers` get none, which is why `mcp__playwright__*` is hard-coded into
   * the fleet defaults.
   */
  it("widens the allowlist by each host server's tool pattern, or they are all denied", () => {
    const host = buildAgentConfig(cfg(), project(), undefined, hostConfig);
    expect(host.allowed_tools).toEqual([...FLEET_ALLOWED_TOOLS, "mcp__notion__*", "mcp__pg__*"]);
    // Still every default: the array is REPLACED by herdctl's merge, not merged,
    // so dropping one here would silently un-allow it (this is how `Skill` broke).
    for (const tool of FLEET_ALLOWED_TOOLS) {
      expect(host.allowed_tools).toContain(tool);
    }
  });

  it("leaves allowed_tools unset under `own`, so the fleet defaults are inherited", () => {
    const own = buildAgentConfig(cfg(), project(), undefined, EMPTY_MCP_SOURCES);
    expect(own.allowed_tools).toBeUndefined();
  });

  /**
   * The `projects[<cwd>]` scope, keyed by absolute path — the case a `--here`
   * workspace hits, because `claude mcp add` without `--scope user` writes there.
   * Two projects on one instance must not see each other's directory-scoped
   * servers.
   */
  it("gives each project only the directory scope keyed to its own working dir", () => {
    const api = buildAgentConfig(cfg(), project("/home/ed/code/api"), undefined, hostConfig);
    const web = buildAgentConfig(cfg(), project("/home/ed/code/web"), undefined, hostConfig);
    const other = buildAgentConfig(cfg(), project("/home/ed/scratch"), undefined, hostConfig);

    expect(Object.keys(api.mcp_servers as object).sort()).toEqual(["notion", "pg"]);
    expect(Object.keys(web.mcp_servers as object).sort()).toEqual(["figma", "notion"]);
    // The user scope reaches everywhere; neither directory-scoped server does.
    expect(Object.keys(other.mcp_servers as object)).toEqual(["notion"]);
    expect(api.allowed_tools).toContain("mcp__pg__*");
    expect(api.allowed_tools).not.toContain("mcp__figma__*");
  });

  it("keeps paddock's own browser server alongside, and lets it win a name clash", () => {
    const withBrowser = buildAgentConfig(
      cfg({ browserMcp: true } as Partial<PaddockConfig>),
      project(),
      undefined,
      parseHostMcpConfig(JSON.stringify({ mcpServers: { playwright: { command: "their-pw" } } })),
    );
    const servers = withBrowser.mcp_servers as Record<string, { command?: string }>;
    // Paddock's flags are box-specific (Ansible's chromium engine, --no-sandbox
    // for an unprivileged LXC); a host `playwright` would not start here.
    expect(servers.playwright.command).toBe("playwright-mcp");
    // Its pattern is already on the fleet defaults, so nothing is added and the
    // allowlist is not restated at all — a second copy would be dead weight.
    expect(withBrowser.allowed_tools).toBeUndefined();
    expect(FLEET_ALLOWED_TOOLS).toContain(BROWSER_MCP_TOOL);
  });

  /**
   * Scope, asserted rather than assumed. The sweeper is tool-less by design and
   * each trigger declares its own narrow allowlist, so a host server attached to
   * either would be a stdio process spawned per fire that nothing can call.
   */
  it("never attaches host servers to the sweeper or to a trigger", () => {
    const sweeper = buildSweeperConfig(cfg(), project());
    const trigger = buildTriggerConfig(cfg(), project(), "nightly", {
      trigger: { type: "schedule", cron: "0 3 * * *" },
      run: {},
    } as unknown as Parameters<typeof buildTriggerConfig>[3]);
    expect(sweeper.mcp_servers).toBeUndefined();
    expect(trigger.mcp_servers).toBeUndefined();
  });

  it("defaults to isolated when no source is passed at all", () => {
    // Every pre-existing caller omits the argument; it has to mean `own`.
    expect(buildAgentConfig(cfg(), project()).mcp_servers).toBeUndefined();
  });
});

/**
 * #691 step 6 — servers this instance declares for ITSELF, in the top-level
 * `mcpServers:` block. Same seam, same trap: an attached server whose tool
 * pattern is not on the keeper's allowlist has every call auto-denied, with no
 * prompt and nothing in the logs.
 */
describe("buildAgentConfig: instance-declared mcpServers (#691 step 6)", () => {
  const declaredOnly = (
    declared: Record<string, { command?: string; url?: string }>,
  ): McpSources => ({ ...EMPTY_MCP_SOURCES, declared });

  /**
   * THE test for step 6. A declared server has to arrive on `mcp_servers` (the
   * one record both runtimes read) AND on `allowed_tools` — either half alone
   * ships something that looks configured and does nothing.
   */
  it("reaches the agent config with its allowlist pattern", () => {
    const config = buildAgentConfig(
      cfg(),
      project(),
      undefined,
      declaredOnly({ notion: { command: "notion-mcp" } }),
    );
    expect(config.mcp_servers).toEqual({ notion: { command: "notion-mcp" } });
    expect(config.allowed_tools).toEqual([...FLEET_ALLOWED_TOOLS, "mcp__notion__*"]);
  });

  it("reaches EVERY project, unlike the host's directory scope", () => {
    // Instance-wide is the whole point: the block says what paddock has, and
    // paddock's projects are not a scoping dimension of that question.
    const sources = declaredOnly({ notion: { command: "notion-mcp" } });
    for (const dir of ["/home/ed/code/api", "/home/ed/code/web", "/srv/elsewhere"]) {
      expect(buildAgentConfig(cfg(), project(dir), undefined, sources).mcp_servers).toEqual({
        notion: { command: "notion-mcp" },
      });
    }
  });

  /**
   * Precedence. `paddock.config.yaml` is a statement about THIS instance;
   * `~/.claude.json` is ambient machine state that happens to be readable. The
   * narrower answer wins — including over the host's per-directory scope, which
   * beats the host's user scope.
   */
  it("wins over the same name inherited from the host, in either host scope", () => {
    const sources: McpSources = {
      ...hostConfig,
      declared: { notion: { command: "mine" }, pg: { command: "mine-too" } },
    };
    const config = buildAgentConfig(cfg(), project("/home/ed/code/api"), undefined, sources);
    const servers = config.mcp_servers as Record<string, { command?: string }>;
    expect(servers.notion.command).toBe("mine"); // host user scope
    expect(servers.pg.command).toBe("mine-too"); // host DIRECTORY scope
    // One pattern each, not two: the allowlist is keyed by server name.
    expect(config.allowed_tools).toEqual([...FLEET_ALLOWED_TOOLS, "mcp__notion__*", "mcp__pg__*"]);
  });

  /**
   * The one collision paddock's own side still wins. Its flags are box-specific,
   * and `browserMcp` is a toggle in the same file — so an operator who wants
   * theirs turns it off. Not silent: `declaredMcpNotices` warns by name at boot.
   */
  it("still loses to paddock's own browser server", () => {
    const config = buildAgentConfig(
      cfg({ browserMcp: true } as Partial<PaddockConfig>),
      project(),
      undefined,
      declaredOnly({ playwright: { command: "my-playwright" } }),
    );
    const servers = config.mcp_servers as Record<string, { command?: string }>;
    expect(servers.playwright.command).toBe("playwright-mcp");
  });

  it("never attaches a declared server to the sweeper or to a trigger", () => {
    // Same scope decision as the host lever: the sweeper is tool-less and each
    // trigger carries its own narrow allowlist, so either would spawn a process
    // per fire that nothing could call.
    // Neither builder even takes an McpSources argument — which IS the
    // structural guarantee, and is what this pins against a future signature.
    expect(buildSweeperConfig(cfg(), project()).mcp_servers).toBeUndefined();
    expect(
      buildTriggerConfig(cfg(), project(), "nightly", {
        trigger: { type: "schedule", cron: "0 3 * * *" },
        run: {},
      } as unknown as Parameters<typeof buildTriggerConfig>[3]).mcp_servers,
    ).toBeUndefined();
  });
});

/**
 * The host's PLUGINS on the same seam (#700, consuming herdctl 5.32.0's `plugins`
 * passthrough). Asserted here rather than in `claude-plugins.test.ts` because the
 * thing that can silently break is not the enumeration — it is the two keys
 * landing on the same agent config together, since a plugin whose server is
 * attached without its `mcp__…__*` pattern has every call auto-denied with no
 * prompt and nothing in the logs.
 *
 * Nothing here loads a plugin; the paths are synthetic and never touched.
 */
describe("buildAgentConfig: host plugins (#700)", () => {
  const hostPlugins: HostPluginSource = {
    plugins: [{ type: "local", path: "/home/ed/.claude/plugins/cache/acme/slack/1.0.0" }],
    toolPatterns: ["mcp__plugin_slack_chat__*"],
    caveats: [],
  };

  it("passes them as `plugins` and widens the allowlist by their tool patterns", () => {
    const config = buildAgentConfig(cfg(), project(), undefined, EMPTY_MCP_SOURCES, hostPlugins);
    expect(config.plugins).toEqual(hostPlugins.plugins);
    expect(config.allowed_tools).toEqual([...FLEET_ALLOWED_TOOLS, "mcp__plugin_slack_chat__*"]);
  });

  /**
   * The allowlist is ONE array and herdctl's `mergeAgentConfig` REPLACES arrays
   * rather than merging them, so an agent that widens it inherits nothing from the
   * fleet defaults. Both sources therefore have to be restated together or the
   * second one silently removes the first.
   */
  it("widens by the plugins' patterns AND the servers', in one array", () => {
    const config = buildAgentConfig(cfg(), project(), undefined, hostConfig, hostPlugins);
    expect(config.allowed_tools).toEqual([
      ...FLEET_ALLOWED_TOOLS,
      "mcp__notion__*",
      "mcp__pg__*",
      "mcp__plugin_slack_chat__*",
    ]);
  });

  it("leaves a config with no plugins byte-identical to before the lever", () => {
    // The default argument means every existing caller — and every project on an
    // instance with `instructions: own` — keeps meaning "no plugins".
    const before = buildAgentConfig(cfg(), project(), undefined, EMPTY_MCP_SOURCES);
    const after = buildAgentConfig(
      cfg(),
      project(),
      undefined,
      EMPTY_MCP_SOURCES,
      EMPTY_HOST_PLUGINS,
    );
    expect(after).toEqual(before);
    expect("plugins" in after).toBe(false);
    expect(after.allowed_tools).toBeUndefined();
  });

  it("never attaches a plugin to the sweeper or to a trigger", () => {
    // Same scope decision as both MCP sources, and the same structural guarantee:
    // neither builder takes a HostPluginSource at all.
    expect(buildSweeperConfig(cfg(), project()).plugins).toBeUndefined();
    expect(
      buildTriggerConfig(cfg(), project(), "nightly", {
        trigger: { type: "schedule", cron: "0 3 * * *" },
        run: {},
      } as unknown as Parameters<typeof buildTriggerConfig>[3]).plugins,
    ).toBeUndefined();
  });
});
