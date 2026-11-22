/**
 * The `claude.connectors` key, where it is observable: the server names paddock
 * derives and the keeper agent config it hands herdctl.
 *
 * The name fixtures are real: each pair is a claude.ai display name and the tool
 * prefix the bundled Claude Code produced for it in a live session.
 */
import { describe, it, expect } from "vitest";
import {
  connectorServerName,
  connectorToolPattern,
  isUsableConnectorName,
} from "../../src/claude-connectors.js";
import { buildAgentConfig, buildTriggerConfig } from "../../src/herdctl-agent-config.js";
import { FLEET_ALLOWED_TOOLS } from "../../src/herdctl-agent-names.js";
import { EMPTY_MCP_SOURCES } from "../../src/claude-mcp.js";
import { EMPTY_HOST_PLUGINS } from "../../src/claude-plugins.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";

describe("connectorServerName", () => {
  it.each([
    ["Claude Docs", "mcp__claude_ai_Claude_Docs__"],
    ["Google Drive", "mcp__claude_ai_Google_Drive__"],
    ["Google Calendar", "mcp__claude_ai_Google_Calendar__"],
    ["Gmail", "mcp__claude_ai_Gmail__"],
    ["claude_security", "mcp__claude_ai_claude_security__"],
  ])("names %s the way Claude Code does", (displayName, prefix) => {
    expect(`mcp__${connectorServerName(displayName)}__`).toBe(prefix);
    expect(connectorToolPattern(displayName)).toBe(`${prefix}*`);
  });

  it("keeps hyphens and collapses other punctuation, as the CLI's normaliser does", () => {
    expect(connectorServerName("Zoom for Claude")).toBe("claude_ai_Zoom_for_Claude");
    expect(connectorServerName("Acme - CRM (EU)")).toBe("claude_ai_Acme_-_CRM_EU");
  });
});

describe("isUsableConnectorName", () => {
  it.each(["Gmail", "Google Drive", "Acme - CRM (EU)", "claude_security"])("accepts %s", (n) => {
    expect(isUsableConnectorName(n)).toBe(true);
  });

  it.each(["", "...", "***", "-", "_ _", "()"])(
    "rejects %j, whose pattern would be mcp__claude_ai__* or reach another server",
    (n) => {
      expect(isUsableConnectorName(n)).toBe(false);
    },
  );

  it("never lets a star or double underscore into the pattern", () => {
    const pattern = connectorToolPattern("a__b*c");
    expect(pattern).toBe("mcp__claude_ai_a_b_c__*");
  });
});

const cfg = (connectors?: string[]): PaddockConfig =>
  ({
    nativeSystemPrompt: true,
    browserMcp: false,
    dataDir: "/tmp/paddock-fixture",
    ...(connectors ? { claude: { connectors } } : {}),
  }) as unknown as PaddockConfig;

const project = (over: Partial<Project> = {}): Project =>
  ({
    slug: "api",
    name: "API",
    dir: "/home/ed/code/api",
    workingDir: "/home/ed/code/api",
    model: "claude-opus-4-8",
    ...over,
  }) as unknown as Project;

const keeper = (c: PaddockConfig, p: Project, autoMemoryDir?: string) =>
  buildAgentConfig(c, p, undefined, EMPTY_MCP_SOURCES, EMPTY_HOST_PLUGINS, undefined, autoMemoryDir);

describe("buildAgentConfig: claude.connectors", () => {
  it("changes nothing when no connector is named", () => {
    const unset = keeper(cfg(), project());
    const empty = keeper(cfg([]), project());
    expect(empty).toEqual(unset);
    expect(unset.allowed_tools).toBeUndefined();
    expect(unset.settings).toBeUndefined();
  });

  it("allows exactly the named connectors and makes MCP startup blocking", () => {
    const config = keeper(cfg(["Gmail", "Google Drive"]), project());
    expect(config.allowed_tools).toEqual([
      ...FLEET_ALLOWED_TOOLS,
      "mcp__claude_ai_Gmail__*",
      "mcp__claude_ai_Google_Drive__*",
    ]);
    expect(config.settings).toEqual({ env: { MCP_CONNECTION_NONBLOCKING: "false" } });
  });

  it("keeps the auto-memory setting alongside the env", () => {
    const config = keeper(cfg(["Gmail"]), project(), "/data/memory/api");
    expect(config.settings).toEqual({
      autoMemoryDirectory: "/data/memory/api",
      env: { MCP_CONNECTION_NONBLOCKING: "false" },
    });
  });

  it("gives a docker project no connectors", () => {
    const config = keeper(cfg(["Gmail"]), project({ docker: true }));
    expect(config.allowed_tools).toBeUndefined();
    expect(config.settings).toBeUndefined();
  });

  it("is keeper-only: a trigger agent gets neither the patterns nor the env", () => {
    const trigger = buildTriggerConfig(cfg(["Gmail"]), project(), "nightly", {
      trigger: { type: "schedule", cron: "0 3 * * *" },
      run: { prompt: "tidy up" },
    } as never);
    expect(JSON.stringify(trigger)).not.toContain("claude_ai");
    expect(trigger.settings).toBeUndefined();
  });
});
