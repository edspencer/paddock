/**
 * The `claude.mcpServers` lever (#691 step 5) — the parse and the two scopes.
 *
 * Every fixture here is SYNTHETIC. The real `~/.claude.json` on any machine that
 * runs this suite holds a user's actual servers and, for some of them, secrets;
 * a test that read it would be non-hermetic and a liability at the same time.
 *
 * `test/unit/herdctl-host-mcp.test.ts` covers what the agent config does with the
 * result, which is where the lever is actually observable.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MCP_SERVERS_MODE,
  EMPTY_MCP_SOURCES,
  HOST_MCP_CONFIG_FILE,
  hostMcpConfigPath,
  isKnownMcpServersMode,
  loadHostMcpSource,
  mcpServersFor,
  mcpToolPattern,
  parseHostMcpConfig,
} from "../../src/claude-mcp.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("claude-mcp: the vocabulary (#691)", () => {
  it("defaults to own, like every key but credentials", () => {
    expect(DEFAULT_MCP_SERVERS_MODE).toBe("own");
  });

  it("recognises exactly the two modes", () => {
    expect(isKnownMcpServersMode("own")).toBe(true);
    expect(isKnownMcpServersMode("host")).toBe(true);
    expect(isKnownMcpServersMode("hosts")).toBe(false);
    expect(isKnownMcpServersMode("")).toBe(false);
  });

  /**
   * The finding the whole lever rests on. `.claude.json` is resolved as
   * `join(CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json")` — the HOME directory,
   * not the Claude home — so it is a SIBLING of `~/.claude` rather than an entry
   * in it. That is why no symlink bridge inside the home could ever have reached
   * it, and why MCP inheritance broke silently and separately from the other four
   * levers. If this assertion ever starts failing because someone "tidied" the
   * path into the home, the bug is back.
   */
  it("looks for .claude.json BESIDE the Claude home, not inside it", () => {
    expect(hostMcpConfigPath("/home/ed/.claude")).toBe("/home/ed/.claude.json");
    expect(hostMcpConfigPath("/home/ed/.claude")).not.toContain(
      path.join(".claude", HOST_MCP_CONFIG_FILE),
    );
  });

  it("namespaces a server's tools the way the allowlist has to match", () => {
    expect(mcpToolPattern("notion")).toBe("mcp__notion__*");
  });
});

describe("claude-mcp: parsing a .claude.json (#691)", () => {
  it("takes the top-level mcpServers as the user scope", () => {
    const src = parseHostMcpConfig(
      JSON.stringify({
        mcpServers: {
          notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
        },
      }),
    );
    expect(src.user).toEqual({
      notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
    });
    expect(src.byDir).toEqual({});
  });

  /**
   * The per-directory scope, keyed by the LITERAL absolute path. This is what
   * `claude mcp add` writes without `--scope user`, so it is the scope a `--here`
   * workspace hits — and the one an implementation that only read the top level
   * would silently miss for exactly the users most likely to notice.
   */
  it("takes projects[<absolute dir>].mcpServers as the directory scope", () => {
    const src = parseHostMcpConfig(
      JSON.stringify({
        projects: {
          "/home/ed/code/api": { mcpServers: { pg: { command: "pg-mcp" } } },
          "/home/ed/code/web": { hasTrustDialogAccepted: true },
        },
      }),
    );
    expect(src.byDir).toEqual({ "/home/ed/code/api": { pg: { command: "pg-mcp" } } });
    // A project entry with no servers contributes no key at all, so the boot
    // notice lists directories that actually declare something.
    expect(Object.keys(src.byDir)).not.toContain("/home/ed/code/web");
  });

  /**
   * The inverse of the two assertions this file used to carry (#699 → #700).
   * `headers` and `type` were stripped here because herdctl's `McpServerSchema`
   * had no field for either and would have dropped them at `addAgent` anyway;
   * carrying them was pointless and warning about the loss was the honest thing
   * to do instead. herdctl 5.32.0 (#446) added both fields, so the useful
   * assertion is now that they SURVIVE — and that nothing warns about them.
   *
   * Proven at the boundary, not inferred: with 5.32.0 installed,
   * `addAgent` → `getAgents()` → `toSDKOptions()` returns
   * `{type: "sse", url, headers}` unchanged. This test pins paddock's half of
   * that; `packages/core`'s `mcp-and-plugin-passthrough.test.ts` pins herdctl's.
   */
  it("carries `headers` and an explicit `type`, which 5.32.0 no longer strips", () => {
    const src = parseHostMcpConfig(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "sse",
            url: "https://mcp.example.com/sse",
            headers: { Authorization: "REDACTED" },
            env: { TOKEN: "x" },
          },
        },
      }),
    );
    expect(src.user.remote).toEqual({
      type: "sse",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "REDACTED" },
      env: { TOKEN: "x" },
    });
    // The whole point of the bump: no caveat, so no boot warning. An `sse` server
    // authenticated with a bearer header used to produce two.
    expect(src.caveats).toEqual([]);
  });

  it("still strips a key herdctl has no field for, without pretending otherwise", () => {
    // `tools` (an `McpServerToolPolicy[]`) is real Claude Code config and is still
    // not in `McpServerSchema`, so the narrowing is still a narrowing — it just no
    // longer breaks authentication. No caveat, because unlike `headers` losing it
    // degrades nothing an operator would recognise as a failure.
    const src = parseHostMcpConfig(
      JSON.stringify({ mcpServers: { remote: { url: "https://x/mcp", tools: ["a"] } } }),
    );
    expect(src.user.remote).toEqual({ url: "https://x/mcp" });
  });

  it("ignores a `type` it does not recognise rather than passing it on", () => {
    // herdctl's enum would strip it, and the bare-`url` ⇒ `http` inference is a
    // better fallback than a field that vanishes one layer down.
    const src = parseHostMcpConfig(
      JSON.stringify({ mcpServers: { odd: { type: "websocket", url: "https://x/ws" } } }),
    );
    expect(src.user.odd).toEqual({ url: "https://x/ws" });
  });

  it("drops — rather than degrades — a server with nothing to start", () => {
    const src = parseHostMcpConfig(JSON.stringify({ mcpServers: { broken: { args: ["--x"] } } }));
    expect(src.user).toEqual({});
    expect(src.caveats).toEqual([
      {
        name: "broken",
        kind: "dropped",
        reason: "it declares neither a `command` nor a `url`, so there is nothing to start",
      },
    ]);
  });

  /**
   * `.claude.json` is a file paddock does not own and cannot validate. Every
   * malformed shape has to return nothing rather than throw, because the
   * alternative is an instance that will not boot because of a file it only ever
   * wanted to read.
   */
  it("never throws on a malformed file", () => {
    for (const raw of ["", "not json", "[]", "null", '{"mcpServers":42}', '{"projects":[]}']) {
      expect(() => parseHostMcpConfig(raw)).not.toThrow();
      expect(parseHostMcpConfig(raw).user).toEqual({});
    }
  });
});

describe("claude-mcp: which servers an agent's directory gets (#691)", () => {
  const source = parseHostMcpConfig(
    JSON.stringify({
      mcpServers: { notion: { command: "notion-mcp" }, pg: { command: "pg-global" } },
      projects: {
        "/home/ed/code/api": { mcpServers: { pg: { command: "pg-local" } } },
      },
    }),
  );

  it("gives every directory the user scope", () => {
    expect(mcpServersFor(source, "/somewhere/else")).toEqual({
      notion: { command: "notion-mcp" },
      pg: { command: "pg-global" },
    });
  });

  it("lets the directory scope win, because it is the more specific declaration", () => {
    expect(mcpServersFor(source, "/home/ed/code/api")).toEqual({
      notion: { command: "notion-mcp" },
      pg: { command: "pg-local" },
    });
  });

  it("matches the directory exactly, the way Claude Code does — no parent walk", () => {
    // `/home/ed/code/api/packages/server` is INSIDE the scoped directory and gets
    // nothing extra. Claude Code does not inherit a parent's entry either, and
    // `host` is only worth anything if paddock's answer equals the terminal's.
    expect(mcpServersFor(source, "/home/ed/code/api/packages/server").pg).toEqual({
      command: "pg-global",
    });
  });

  it("is empty for the empty source, which is what `own` means", () => {
    expect(mcpServersFor(EMPTY_MCP_SOURCES, "/home/ed/code/api")).toEqual({});
  });
});

describe("claude-mcp: loading from disk (#691)", () => {
  let home: string;
  const cfgFor = (mcpServers: "own" | "host"): Parameters<typeof loadHostMcpSource>[0] => ({
    legacyClaudeHome: path.join(home, ".claude"),
    claude: { mcpServers },
  });

  beforeEach(async () => {
    home = await makeTmpDir("paddock-hostmcp-");
  });
  afterEach(async () => {
    await rmTmpDir(home);
  });

  const writeHostConfig = (body: unknown): Promise<void> =>
    fs.writeFile(path.join(home, ".claude.json"), JSON.stringify(body), "utf8");

  /**
   * The guarantee, tested where it can actually be observed: under `own` the
   * file is not opened, so a `.claude.json` full of servers contributes nothing.
   * "own everywhere means nothing outside the data dir is read" has to be true in
   * the one place someone would check it.
   */
  it("does not read the file at all under `own`", async () => {
    await writeHostConfig({ mcpServers: { notion: { command: "notion-mcp" } } });
    const report = await loadHostMcpSource(cfgFor("own"));
    expect(report.source).toBe(EMPTY_MCP_SOURCES);
    expect(report.notices).toEqual([]);
  });

  it("reads both scopes under `host` and names them in the boot notice", async () => {
    await writeHostConfig({
      mcpServers: { notion: { command: "notion-mcp" } },
      projects: { "/home/ed/code/api": { mcpServers: { pg: { command: "pg-mcp" } } } },
    });
    const report = await loadHostMcpSource(cfgFor("host"));
    expect(report.source.user.notion).toEqual({ command: "notion-mcp" });
    expect(report.source.byDir["/home/ed/code/api"].pg).toEqual({ command: "pg-mcp" });
    const notice = report.notices.find((n) => n.level === "info");
    expect(notice?.message).toContain("notion");
    expect(notice?.message).toContain("/home/ed/code/api");
  });

  it("says so calmly when the file does not exist, rather than failing a boot", async () => {
    const report = await loadHostMcpSource(cfgFor("host"));
    expect(report.source).toBe(EMPTY_MCP_SOURCES);
    expect(report.notices[0].level).toBe("info");
    expect(report.notices[0].message).toContain("claude mcp add");
  });

  it("warns at boot about a server it cannot start, and only about that", async () => {
    // The `degraded` warnings #699 shipped — a dropped `headers`, a coerced
    // `sse` — are gone with herdctl 5.32.0. What remains is the one case that is
    // genuinely unusable rather than merely narrowed.
    await writeHostConfig({
      mcpServers: {
        remote: { url: "https://x/mcp", type: "sse", headers: { Authorization: "REDACTED" } },
        broken: { args: ["--x"] },
      },
    });
    const report = await loadHostMcpSource(cfgFor("host"));
    const warnings = report.notices.filter((n) => n.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("broken");
    expect(warnings[0].message).toContain("NOT attached");
  });
});
