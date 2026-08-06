/**
 * Host Claude Code plugin enumeration (#700) — what paddock hands herdctl as
 * `agent.plugins`, and the allowlist patterns it derives for the MCP servers a
 * plugin provides.
 *
 * ## What these tests do NOT prove, said up front
 *
 * **Nothing here loads a plugin.** This box is Linux with an empty plugin root,
 * no marketplace and no credentials for a real turn, so every fixture is a
 * directory tree planted in a temp dir and every assertion is about the CONFIG
 * paddock produces from it. That is one layer below where the interesting failure
 * lives: a plugin whose directory reaches `--plugin-dir` and still does not load
 * would pass every test in this file.
 *
 * The naming is deliberate about that — "produces", "derives", "enumerates",
 * never "loads". herdctl's own `mcp-and-plugin-passthrough.test.ts` carries the
 * next layer (config → the options object handed to the SDK's `query()`), and the
 * layer after that — the CLI actually loading the directory — is the SDK's
 * contract and is verified by nobody in either repo. A `marketplace`-installed
 * plugin loading through `type: "local"` needs a real host with one installed.
 *
 * What IS load-bearing and testable is the derivation: the tool-name prefix a
 * plugin's server ends up under is not the name it is declared under, and getting
 * it wrong means every call to that server is auto-denied with no prompt and
 * nothing in the logs. {@link pluginMcpToolPattern} is pinned here against the
 * SDK's own documented example.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EMPTY_HOST_PLUGINS,
  INSTALLED_PLUGINS_FILE,
  PLUGIN_MANIFEST,
  PLUGIN_MCP_FILE,
  enumerateHostPlugins,
  hostPluginRoot,
  loadHostPlugins,
  parseInstalledPlugins,
  pluginMcpToolPattern,
  readPluginServerNames,
} from "../../src/claude-plugins.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paddock-plugins-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Plant a plugin directory: a manifest, and whatever MCP declaration is asked for. */
async function plantPlugin(
  dir: string,
  opts: {
    name?: string;
    mcpJson?: unknown;
    manifestMcp?: unknown;
    extraFiles?: Record<string, unknown>;
  } = {},
): Promise<string> {
  await fs.mkdir(path.join(dir, path.dirname(PLUGIN_MANIFEST)), { recursive: true });
  const manifest: Record<string, unknown> = { name: opts.name ?? path.basename(dir) };
  if (opts.manifestMcp !== undefined) manifest.mcpServers = opts.manifestMcp;
  await fs.writeFile(path.join(dir, PLUGIN_MANIFEST), JSON.stringify(manifest), "utf8");
  if (opts.mcpJson !== undefined) {
    await fs.writeFile(path.join(dir, PLUGIN_MCP_FILE), JSON.stringify(opts.mcpJson), "utf8");
  }
  for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) {
    await fs.writeFile(path.join(dir, rel), JSON.stringify(body), "utf8");
  }
  return dir;
}

describe("pluginMcpToolPattern: the derivation the allowlist depends on", () => {
  /**
   * THE assertion in this file. A plugin's servers are registered under
   * `` `plugin:${pluginName}:${serverName}` ``, and a server name is normalised
   * `[^a-zA-Z0-9_-] → _` before it becomes a tool prefix — so the allowlist entry
   * for the `docs` server of the `documents` plugin is
   * `mcp__plugin_documents_docs__*`, which is exactly the fully-qualified example
   * the Agent SDK's own types document (`mcp__plugin_documents_docs__doc_export`).
   * That coincidence is the evidence; it is not a guess about a convention.
   */
  it("matches the fully-qualified name the SDK documents", () => {
    expect(pluginMcpToolPattern("documents", "docs")).toBe("mcp__plugin_documents_docs__*");
  });

  it("normalises every character the tool namespace cannot hold", () => {
    // Applied to the joined `plugin:<a>:<b>` string, not to the parts, so the
    // separators and a dotted plugin name normalise the same way.
    expect(pluginMcpToolPattern("my.plugin", "some server")).toBe(
      "mcp__plugin_my_plugin_some_server__*",
    );
  });
});

describe("parseInstalledPlugins: the CLI's own registry, both formats", () => {
  it("reads a v2 entry's explicit installPath, one per install scope", () => {
    const plugins = parseInstalledPlugins(
      JSON.stringify({
        version: 2,
        plugins: {
          "slack@acme": [
            { scope: "user", installPath: "/home/ed/.claude/plugins/cache/acme/slack/1.2.0" },
            { scope: "project", projectPath: "/x", installPath: "/x/.claude/plugins/slack" },
          ],
        },
      }),
      "/home/ed/.claude/plugins",
    );
    expect(plugins).toEqual([
      { id: "slack@acme", installPath: "/home/ed/.claude/plugins/cache/acme/slack/1.2.0" },
      { id: "slack@acme", installPath: "/x/.claude/plugins/slack" },
    ]);
  });

  /**
   * v1 held no path at all; the CLI derived it as
   * `<root>/cache/<marketplace>/<name>/<version>` with each segment sanitised.
   * Reproduced rather than ignored because a host that has not run a recent
   * `claude` still has the old file, and enumerating nothing there would look
   * exactly like "you have no plugins".
   */
  it("derives a v1 entry's path the way the CLI does", () => {
    const plugins = parseInstalledPlugins(
      JSON.stringify({ plugins: { "slack@acme": { version: "1.2.0" } } }),
      "/root",
    );
    expect(plugins).toEqual([{ id: "slack@acme", installPath: "/root/cache/acme/slack/1.2.0" }]);
  });

  it("returns nothing rather than throwing on a file it cannot read", () => {
    // This is a file paddock does not own and must never turn into a boot
    // failure — the same posture `parseHostMcpConfig` takes with `.claude.json`.
    expect(parseInstalledPlugins("{not json", "/root")).toEqual([]);
    expect(parseInstalledPlugins(JSON.stringify({ plugins: "nope" }), "/root")).toEqual([]);
    const noPath = JSON.stringify({ plugins: { "a@b": [{}] } });
    expect(parseInstalledPlugins(noPath, "/root")).toEqual([]);
  });
});

describe("readPluginServerNames: the two places a plugin declares servers", () => {
  it("reads `.mcp.json`, in both the wrapped and the bare shape", async () => {
    const wrapped = await plantPlugin(path.join(tmp, "a"), {
      mcpJson: { mcpServers: { docs: { command: "docs-mcp" } } },
    });
    const bare = await plantPlugin(path.join(tmp, "b"), {
      mcpJson: { docs: { command: "docs-mcp" } },
    });
    expect((await readPluginServerNames(wrapped)).servers).toEqual(["docs"]);
    expect((await readPluginServerNames(bare)).servers).toEqual(["docs"]);
  });

  it("unions an inline manifest `mcpServers` with `.mcp.json`", async () => {
    const dir = await plantPlugin(path.join(tmp, "p"), {
      name: "slack",
      mcpJson: { mcpServers: { docs: { command: "x" } } },
      manifestMcp: { chat: { url: "https://x/mcp" } },
    });
    const read = await readPluginServerNames(dir);
    expect(read.pluginName).toBe("slack");
    expect(read.servers.sort()).toEqual(["chat", "docs"]);
    expect(read.unresolved).toEqual([]);
  });

  it("follows a manifest pointer that stays inside the plugin directory", async () => {
    const dir = await plantPlugin(path.join(tmp, "p"), {
      manifestMcp: "./servers.json",
      extraFiles: { "servers.json": { mcpServers: { chat: { command: "x" } } } },
    });
    const read = await readPluginServerNames(dir);
    expect(read.servers).toEqual(["chat"]);
    expect(read.unresolved).toEqual([]);
  });

  /**
   * The honest gap, and the reason it is reported rather than guessed at: a
   * manifest may point `mcpServers` at an MCPB bundle the CLI downloads, or at a
   * path outside the plugin. Paddock will not fetch anything to build an
   * allowlist, so it records the pointer — which is what turns the silent
   * auto-deny into a boot warning naming the plugin.
   */
  it("records a pointer it will not resolve rather than inventing a name", async () => {
    const outside = await plantPlugin(path.join(tmp, "p"), { manifestMcp: "../elsewhere.json" });
    expect(await readPluginServerNames(outside)).toMatchObject({
      servers: [],
      unresolved: ["../elsewhere.json"],
    });
    const bundle = await plantPlugin(path.join(tmp, "q"), { manifestMcp: "server.mcpb" });
    expect((await readPluginServerNames(bundle)).unresolved).toEqual(["server.mcpb"]);
  });

  it("falls back to the directory name when the manifest names nothing", async () => {
    const dir = path.join(tmp, "unnamed");
    await fs.mkdir(path.join(dir, path.dirname(PLUGIN_MANIFEST)), { recursive: true });
    await fs.writeFile(path.join(dir, PLUGIN_MANIFEST), JSON.stringify({}), "utf8");
    expect((await readPluginServerNames(dir)).pluginName).toBe("unnamed");
  });
});

describe("enumerateHostPlugins: what reaches agent.plugins", () => {
  /** A registry naming one planted plugin that declares one MCP server. */
  async function fixture(id = "slack@acme"): Promise<{ root: string; installed: string }> {
    const root = path.join(tmp, "plugins");
    const dir = path.join(root, "cache", "acme", "slack", "1.0.0");
    await plantPlugin(dir, { name: "slack", mcpJson: { mcpServers: { chat: { command: "x" } } } });
    return {
      root,
      installed: JSON.stringify({
        version: 2,
        plugins: { [id]: [{ scope: "user", installPath: dir }] },
      }),
    };
  }

  /**
   * THE test for the lever split. A plugin is instructions AND (maybe) MCP
   * servers, and `skipMcpDiscovery` is the SDK's own flag for loading the first
   * half without the second — so `mcpServers: own` still gets the plugin's
   * commands/skills/agents and gets NO tool patterns, while `host` gets both.
   */
  it("passes the plugin whole with MCP on, and skipMcpDiscovery with it off", async () => {
    const { root, installed } = await fixture();
    const withMcp = await enumerateHostPlugins({ root, installed, settings: {}, mcp: true });
    const without = await enumerateHostPlugins({ root, installed, settings: {}, mcp: false });

    expect(withMcp.plugins).toEqual([
      { type: "local", path: path.join(root, "cache", "acme", "slack", "1.0.0") },
    ]);
    expect(withMcp.toolPatterns).toEqual(["mcp__plugin_slack_chat__*"]);

    expect(without.plugins).toEqual([
      {
        type: "local",
        path: path.join(root, "cache", "acme", "slack", "1.0.0"),
        skipMcpDiscovery: true,
      },
    ]);
    // No pattern, because no server is attached to need one. Widening the
    // allowlist here would grant a namespace nothing occupies.
    expect(without.toolPatterns).toEqual([]);
  });

  /**
   * A `--plugin-dir` plugin is enabled BY DEFAULT — its enablement is
   * `enabledPlugins["<name>@inline"] ?? manifest.defaultEnabled !== false`, and
   * the host's key is `<name>@<marketplace>`, which never matches. So honouring
   * an explicit `false` here is the only thing that can respect a host's
   * `/plugin disable`, and it is the only thing this reads `settings.json` for.
   */
  it("honours an explicit `enabledPlugins: false` and nothing else about it", async () => {
    const { root, installed } = await fixture();
    const off = await enumerateHostPlugins({
      root,
      installed,
      settings: { enabledPlugins: { "slack@acme": false } },
      mcp: true,
    });
    expect(off.plugins).toEqual([]);

    // An extended entry (a version constraint) is not a disable, and neither is
    // an absent one — an installed plugin is passed unless it is turned off.
    for (const enabledPlugins of [{ "slack@acme": { version: "^1" } }, {}]) {
      const on = await enumerateHostPlugins({
        root,
        installed,
        settings: { enabledPlugins },
        mcp: true,
      });
      expect(on.plugins).toHaveLength(1);
    }
  });

  it("reports a registry entry whose directory is gone instead of passing it", async () => {
    const root = path.join(tmp, "plugins");
    const installed = JSON.stringify({
      version: 2,
      plugins: { "ghost@acme": [{ scope: "user", installPath: path.join(root, "gone") }] },
    });
    const src = await enumerateHostPlugins({ root, installed, settings: {}, mcp: true });
    expect(src.plugins).toEqual([]);
    expect(src.caveats).toEqual([
      {
        name: "ghost@acme",
        kind: "dropped",
        reason: `its recorded install directory (${path.join(root, "gone")}) is missing`,
      },
    ]);
  });

  it("attaches a plugin it cannot name servers for, and says what is missing", async () => {
    const root = path.join(tmp, "plugins");
    const dir = path.join(root, "cache", "acme", "bundled", "1.0.0");
    await plantPlugin(dir, { name: "bundled", manifestMcp: "server.mcpb" });
    const src = await enumerateHostPlugins({
      root,
      installed: JSON.stringify({
        version: 2,
        plugins: { "bundled@acme": [{ scope: "user", installPath: dir }] },
      }),
      settings: {},
      mcp: true,
    });
    // Attached — refusing it would lose its commands and skills too, and the
    // plugin may well provide no MCP tools the keeper needs.
    expect(src.plugins).toHaveLength(1);
    expect(src.toolPatterns).toEqual([]);
    expect(src.caveats[0].kind).toBe("degraded");
    // The warning has to be actionable: it names the prefix an operator would
    // have to add, because the failure it prevents is a silent auto-deny.
    expect(src.caveats[0].reason).toContain("mcp__plugin_bundled_<server>__*");
  });
});

describe("loadHostPlugins: the boot read, and the levers that gate it", () => {
  const cfgFor = (instructions: "own" | "host", mcpServers: "own" | "host") =>
    ({
      legacyClaudeHome: path.join(tmp, ".claude"),
      claude: { instructions, mcpServers },
    }) as Parameters<typeof loadHostPlugins>[0];

  /**
   * The divergence from #700 worth pinning, because it is a judgement call and not
   * a detail: #700 scopes plugin enumeration to `claude.mcpServers: host`, but
   * `plugins/` is bridged by `claude.instructions` and most of a plugin IS
   * instructions. Under `instructions: own` paddock already prints "your ~/.claude
   * plugins are NOT loaded"; loading them because a different key says `host`
   * would contradict its own boot log. So it reads nothing, and says which key to
   * flip instead of leaving an empty `plugins` to be discovered.
   */
  it("reads nothing under `instructions: own`, and names the key that turns it on", async () => {
    const report = await loadHostPlugins(cfgFor("own", "host"));
    expect(report.source).toBe(EMPTY_HOST_PLUGINS);
    expect(report.notices[0].message).toContain("claude.instructions: host");
  });

  it("says nothing at all when neither lever is on", async () => {
    const report = await loadHostPlugins(cfgFor("own", "own"));
    expect(report.source).toBe(EMPTY_HOST_PLUGINS);
    expect(report.notices).toEqual([]);
  });

  it("stays quiet when the host has never installed a plugin", async () => {
    // `installed_plugins.json` does not exist until the first `claude plugin
    // install`, which is the overwhelmingly common case and not worth a warning.
    await fs.mkdir(path.join(tmp, ".claude"), { recursive: true });
    const report = await loadHostPlugins(cfgFor("host", "host"));
    expect(report.source.plugins).toEqual([]);
    expect(report.notices).toEqual([]);
  });

  it("enumerates from the registry and names the patterns it widened by", async () => {
    const root = hostPluginRoot(path.join(tmp, ".claude"));
    const dir = path.join(root, "cache", "acme", "slack", "1.0.0");
    await plantPlugin(dir, { name: "slack", mcpJson: { mcpServers: { chat: { command: "x" } } } });
    await fs.writeFile(
      path.join(root, INSTALLED_PLUGINS_FILE),
      JSON.stringify({
        version: 2,
        plugins: { "slack@acme": [{ scope: "user", installPath: dir }] },
      }),
      "utf8",
    );
    const report = await loadHostPlugins(cfgFor("host", "host"));
    expect(report.source.plugins).toEqual([{ type: "local", path: dir }]);
    expect(report.notices[0].message).toContain("mcp__plugin_slack_chat__*");
  });
});
