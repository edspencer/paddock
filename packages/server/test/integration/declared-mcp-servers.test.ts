import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";
import { declaredMcpNotices } from "../../src/mcp-servers.js";

/**
 * The top-level `mcpServers:` block (#691 step 6) through a REAL boot: a server a
 * user declares to paddock itself, rather than one borrowed from the machine.
 *
 * ## What this can and cannot prove
 *
 * Nothing here starts an MCP server or calls a tool — there are none on this box
 * and no way to stand one up in CI. An agent config is data until a turn runs,
 * and no turn runs here. What it proves is everything on paddock's side:
 *
 *  1. a declared server reaches the agent config, WITH its allowlist pattern —
 *     without which it attaches and has every call auto-denied;
 *  2. an `env:VAR_NAME` reference is resolved from the real environment;
 *  3. the declaration beats the same name inherited from `~/.claude.json`;
 *  4. **its secrets do not leave the process** — not through an API response, not
 *     through anything paddock logs, and not through the Settings screen's write
 *     path.
 *
 * `SECRET` is a synthetic value that exists only in this file, which is what
 * makes the leak assertions exact rather than approximate.
 */
const SECRET = "ntn_totally-fake-secret-9f3a2b";
const SECRET_VAR = "PADDOCK_TEST_FAKE_NOTION_TOKEN";

/** The block a user would write, with the credential kept out of the file. */
const DECLARED = {
  notion: {
    command: "notion-mcp-not-real",
    args: ["--stdio"],
    env: { NOTION_TOKEN: `env:${SECRET_VAR}`, NOTION_VERSION: "2022-06-28" },
  },
};

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

describe("integration: instance-declared MCP servers (#691 step 6)", () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.teardown();
    t = undefined;
  });

  /**
   * THE test. Both halves have to land: `mcp_servers` is the record both runtimes
   * read, and `allowed_tools` is what stops every one of the server's tools being
   * auto-denied with no prompt. Shipping one without the other looks correct and
   * does nothing.
   */
  it("puts a declared server on every keeper, with its allowlist pattern", async () => {
    t = await startTestApp({
      configFile: { mcpServers: DECLARED },
      env: { [SECRET_VAR]: SECRET },
    });
    for (const dir of ["/nonexistent/a", "/nonexistent/b"]) {
      const keeper = keeperConfigFor(t, dir);
      expect(keeper.mcp_servers).toEqual({
        notion: {
          command: "notion-mcp-not-real",
          args: ["--stdio"],
          // The reference resolved against the real process environment.
          env: { NOTION_TOKEN: SECRET, NOTION_VERSION: "2022-06-28" },
        },
      });
      expect(keeper.allowed_tools).toContain("mcp__notion__*");
    }
  });

  it("drops the server when the referenced variable is not set", async () => {
    // Fail closed: a server started without the credential it was declared with
    // would either fail every call confusingly or connect unauthenticated.
    t = await startTestApp({ configFile: { mcpServers: DECLARED } });
    expect(t.cfg.mcpServers).toEqual({});
    expect(keeperConfigFor(t, "/nonexistent/a").mcp_servers).toBeUndefined();
    expect(t.cfg.mcpServersDiagnostics.warnings.join("\n")).toContain(SECRET_VAR);
  });

  it("wins over the same server name inherited from the host", async () => {
    t = await startTestApp({
      configFile: { mcpServers: { notion: { command: "mine-not-real" } } },
      hostClaudeJson: { mcpServers: { notion: { command: "theirs-not-real" } } },
      env: { PADDOCK_CLAUDE_MCP_SERVERS: "host" },
    });
    const servers = keeperConfigFor(t, "/nonexistent/a").mcp_servers as Record<
      string,
      { command?: string }
    >;
    // paddock.config.yaml is a statement about THIS instance; ~/.claude.json is
    // ambient machine state. The narrower answer wins.
    expect(servers.notion.command).toBe("mine-not-real");
  });

  it("is independent of claude.mcpServers, which stays `own`", async () => {
    // Declaring a server must not turn on inheritance — they are different
    // questions, which is why the block is a sibling of `claude:` and not a key
    // inside it.
    // `own` is now stated rather than assumed: #878 moved the default to `host`,
    // and what this test is about — declaring a server must not flip inheritance
    // — needs inheritance off for a reason the test controls.
    t = await startTestApp({
      configFile: {
        profile: "paranoid",
        mcpServers: { notion: { command: "mine-not-real" } },
      },
      hostClaudeJson: { mcpServers: { pg: { command: "theirs-not-real" } } },
    });
    expect(t.cfg.claude.mcpServers).toBe("own");
    expect(Object.keys(keeperConfigFor(t, "/nonexistent/a").mcp_servers as object)).toEqual([
      "notion",
    ]);
  });

  /**
   * The leak test, and the reason this feature needed one: this is the first
   * place in #691 where a user types a credential into paddock's own config.
   *
   * The three arrays scanned below are the COMPLETE set of things paddock says
   * about the block — `app.ts` logs `mcpServersDiagnostics.errors` at error,
   * `.warnings` at warn, and `declaredMcpNotices(...)` at info, and nothing else
   * mentions it. So scanning them is scanning every log line this feature can
   * produce, without depending on capturing a pino stream.
   */
  it("keeps the secret out of every API response and every log line", async () => {
    t = await startTestApp({
      configFile: {
        // Inlined as well as referenced, so the noisier path is covered too.
        mcpServers: { ...DECLARED, remote: { url: `https://mcp.example.test/mcp?key=${SECRET}` } },
      },
      env: { [SECRET_VAR]: SECRET },
    });
    // It really is loaded — otherwise this test proves nothing.
    expect(t.cfg.mcpServers.notion.env).toEqual({
      NOTION_TOKEN: SECRET,
      NOTION_VERSION: "2022-06-28",
    });

    for (const url of [
      "/api/instance-config",
      "/api/health",
      "/api/me",
      "/api/models",
      "/api/fleet",
      "/api/projects",
      "/api/transcription",
    ]) {
      const res = await t.app.inject({ method: "GET", url });
      expect(res.body, `${url} leaked the token`).not.toContain(SECRET);
    }
    // The Settings surface in particular: it renders whatever is in its FIELDS
    // table verbatim, so a row for this block would publish tokens to any
    // authenticated UI user. There is deliberately no such row.
    const settings = await t.app.inject({ method: "GET", url: "/api/instance-config" });
    expect(JSON.parse(settings.body).groups.flatMap((g: { fields: { key: string }[] }) => g.fields)
      .map((f: { key: string }) => f.key)).not.toContain("mcpServers");

    const everythingLogged = [
      ...t.cfg.mcpServersDiagnostics.errors,
      ...t.cfg.mcpServersDiagnostics.warnings,
      ...declaredMcpNotices({ servers: t.cfg.mcpServers }).map((n) => n.message),
    ].join("\n");
    expect(everythingLogged).not.toContain(SECRET);
    // Not vacuous: it did have things to say about both servers.
    expect(everythingLogged).toContain("notion");
    expect(everythingLogged).toContain("remote");
  });

  /**
   * The Settings screen writes `paddock.config.yaml` through the `yaml` Document
   * API precisely so unmanaged keys survive. `mcpServers:` is unmanaged AND holds
   * credentials, so "survives a Settings write" is worth pinning rather than
   * inferring — clobbering it would silently unconfigure every declared server on
   * the next boot.
   */
  it("survives a write from the Settings screen untouched", async () => {
    t = await startTestApp({
      configFile: { mcpServers: DECLARED },
      env: { [SECRET_VAR]: SECRET },
    });
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/instance-config",
      payload: { patch: { "brand.name": "Renamed" } },
    });
    expect(res.statusCode).toBe(200);
    const written = await fs.readFile(path.join(t.tmp, "paddock.config.yaml"), "utf8");
    expect(written).toContain("notion-mcp-not-real");
    expect(written).toContain(`env:${SECRET_VAR}`);
    // And the file still holds only the reference, never the resolved value.
    expect(written).not.toContain(SECRET);
  });
});
