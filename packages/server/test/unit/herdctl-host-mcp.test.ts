/**
 * `claude.mcpServers` where it is actually observable: the agent config paddock
 * hands herdctl (#691 step 5).
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
import { EMPTY_HOST_MCP, parseHostMcpConfig } from "../../src/claude-mcp.js";
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
    const own = buildAgentConfig(cfg(), project(), undefined, EMPTY_HOST_MCP);
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
    const own = buildAgentConfig(cfg(), project(), undefined, EMPTY_HOST_MCP);
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
