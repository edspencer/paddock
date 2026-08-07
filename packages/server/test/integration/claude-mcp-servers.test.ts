import { describe, it, expect, afterEach } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { HerdctlService } from "../../src/herdctl.js";
import type { Project } from "../../src/projects.js";
import { keeperAgentName } from "../../src/herdctl-agent-names.js";

/**
 * `claude.mcpServers` (#691, step 5) through a REAL boot — the wiring the unit
 * tests cannot see.
 *
 * ## What this can and cannot prove
 *
 * There are no MCP servers on this box and no way to stand a real one up in CI,
 * so nothing here starts a server or calls a tool. What it proves is everything
 * on paddock's side of that line:
 *
 *  1. `buildApp()` reads the host's `.claude.json` — from beside the throwaway
 *     HOME, which is where Claude Code puts it — but only under `host`;
 *  2. what it read reaches the agent config paddock hands `fleet.addAgent`, which
 *     is the single record both runtimes read their MCP servers from;
 *  3. the per-directory scope resolves against each project's own working dir.
 *
 * The fixture is SYNTHETIC and the commands in it do not exist. Nothing spawns
 * them: an agent config is data until a turn runs, and no turn runs here.
 */
const HOST_CLAUDE_JSON = {
  // Claude Code writes plenty of unrelated state into this file; carrying some of
  // it proves the parse ignores what it does not own.
  firstStartTime: "2026-01-01T00:00:00.000Z",
  mcpServers: {
    notion: { command: "notion-mcp-not-real", args: ["--stdio"] },
    // A header-authenticated `sse` server: the exact shape #699 had to warn about,
    // and the reason this repo needs @herdctl/core >= 5.32.0.
    stream: {
      type: "sse",
      url: "https://mcp.example.invalid/sse",
      headers: { Authorization: "Bearer not-a-real-token" },
    },
  },
  projects: {
    "/nonexistent/scoped-project": { mcpServers: { pg: { command: "pg-mcp-not-real" } } },
  },
};

/** Reach the private builder the same way the other herdctl unit tests do. */
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

describe("integration: claude.mcpServers decides what the runtime is handed (#691)", () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.teardown();
    t = undefined;
  });

  it("own (the default) reads nothing, even with a .claude.json sitting right there", async () => {
    t = await startTestApp({ hostClaudeJson: HOST_CLAUDE_JSON });
    expect(t.cfg.claude.mcpServers).toBe("own");
    // The guarantee `own` exists to make sayable — "nothing outside the data dir
    // is read" — tested where it can be observed rather than asserted in a doc.
    expect(keeperConfigFor(t, "/nonexistent/scoped-project").mcp_servers).toBeUndefined();
  });

  it("host reads BESIDE the Claude home and puts the servers on the keeper", async () => {
    t = await startTestApp({
      hostClaudeJson: HOST_CLAUDE_JSON,
      env: { PADDOCK_CLAUDE_MCP_SERVERS: "host" },
    });
    expect(t.cfg.claude.mcpServers).toBe("host");
    const keeper = keeperConfigFor(t, "/nonexistent/plain-project");
    expect(keeper.mcp_servers).toEqual({
      notion: { command: "notion-mcp-not-real", args: ["--stdio"] },
      stream: {
        type: "sse",
        url: "https://mcp.example.invalid/sse",
        headers: { Authorization: "Bearer not-a-real-token" },
      },
    });
    // …and the allowlist is widened, or every one of its tools is auto-denied.
    expect(keeper.allowed_tools).toContain("mcp__notion__*");
    expect(keeper.name).toBe(keeperAgentName("demo"));
  });

  it("resolves projects[<cwd>] against each project's own working directory", async () => {
    // The scope a `--here` workspace hits: `claude mcp add` without `--scope
    // user` writes here, keyed by the literal absolute path.
    t = await startTestApp({
      hostClaudeJson: HOST_CLAUDE_JSON,
      env: { PADDOCK_CLAUDE_MCP_SERVERS: "host" },
    });
    const scoped = keeperConfigFor(t, "/nonexistent/scoped-project");
    const other = keeperConfigFor(t, "/nonexistent/plain-project");
    expect(Object.keys(scoped.mcp_servers as object).sort()).toEqual(["notion", "pg", "stream"]);
    expect(Object.keys(other.mcp_servers as object).sort()).toEqual(["notion", "stream"]);
    expect(scoped.allowed_tools).toContain("mcp__pg__*");
    expect(other.allowed_tools).not.toContain("mcp__pg__*");
  });

  /**
   * The assertion that retires #699's stripping warnings, made where the stripping
   * used to happen: `AgentConfigSchema` is a `z.object`, so a field it has no slot
   * for is dropped at `addAgent` with no error. Reading the agent back out of the
   * LIVE fleet is therefore the only place the answer is trustworthy — the unit
   * tests above pass identically against 5.31.x, where both fields are gone by
   * this point and a bearer-authenticated `sse` server arrives as unauthenticated
   * HTTP (and cannot find its stored OAuth token, which is keyed on a hash of
   * `{type, url, headers}`).
   *
   * So this fails on 5.31.x and passes on 5.32.0 — verified by installing both —
   * which makes it the guard for the dependency floor, not just for the code.
   */
  it("keeps `headers` and `type: sse` through AgentConfigSchema (herdctl 5.32.0)", async () => {
    t = await startTestApp({
      hostClaudeJson: HOST_CLAUDE_JSON,
      env: { PADDOCK_CLAUDE_MCP_SERVERS: "host" },
      gitRepo: true,
    });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Streamed", slug: "streamed" },
    });
    const keeper = t.herdctl.manager
      .getAgents()
      .find((a) => a.name === keeperAgentName("streamed")) as
      | { mcp_servers?: Record<string, Record<string, unknown>> }
      | undefined;
    expect(keeper?.mcp_servers?.stream).toEqual({
      type: "sse",
      url: "https://mcp.example.invalid/sse",
      headers: { Authorization: "Bearer not-a-real-token" },
    });
  });

  it("reads the key from the config file too, and boots fine with no .claude.json", async () => {
    // The common first run: `host` asked for, nothing to inherit yet. It must be
    // an unremarkable boot, not a failure — that file does not exist until the
    // user has run `claude mcp add` at least once.
    t = await startTestApp({ configFile: { claude: { mcpServers: "host" } } });
    expect(t.cfg.claude.mcpServers).toBe("host");
    expect(keeperConfigFor(t, "/nonexistent/plain-project").mcp_servers).toBeUndefined();
  });

  it("is independent of the other four levers", async () => {
    // The point of #691. Sharing MCP servers must not imply sharing transcripts,
    // instructions, hooks or a login — the welding is what caused #682/#683/#689.
    t = await startTestApp({
      hostClaudeJson: HOST_CLAUDE_JSON,
      env: { PADDOCK_CLAUDE_MCP_SERVERS: "host", PADDOCK_CLAUDE_CREDENTIALS: "own" },
    });
    expect(t.cfg.claude.mcpServers).toBe("host");
    expect(t.cfg.claude.transcripts).toBe("own");
    expect(t.cfg.claude.instructions).toBe("own");
    expect(t.cfg.claude.hooks).toBe("own");
    expect(t.cfg.claude.credentials).toBe("own");
    expect(keeperConfigFor(t, "/nonexistent/plain-project").mcp_servers).toBeDefined();
  });
});
