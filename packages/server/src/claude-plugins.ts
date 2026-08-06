/**
 * Host Claude Code **plugins**, handed to each keeper as `agent.plugins` (#700).
 *
 * The half of MCP inheritance that `claude-mcp.ts` structurally could not reach.
 * A plugin bundles commands, agents, skills, hooks and — the reported symptom —
 * MCP servers, and none of it is declared in `~/.claude.json`, so reading that
 * file finds nothing however carefully it is read.
 *
 * ## Why the symlink was not enough
 *
 * `plugins/` IS bridged into paddock's home (under `claude.instructions: host`,
 * see `claude-home.ts`) and the SDK really does auto-discover plugins under
 * `join(CLAUDE_CONFIG_DIR, "plugins")` — two facts that together made this look
 * fixed for months. It is not, because discovery of an *installed* plugin is
 * driven by the `enabledPlugins` key, and `enabledPlugins` lives in the **user**
 * settings source, which herdctl does not load: every agent with a working
 * directory is invoked with `setting_sources: ["project"]`. So the plugin is
 * found and then never enabled, silently.
 *
 * herdctl 5.32.0 (herdctl#446, closing herdctl#444) adds the channel this needs:
 * an optional `plugins` array on the agent config, translated to the SDK's own
 * `plugins` option and to `--plugin-dir` on the CLI runtime. A plugin passed that
 * way is a *session* plugin, and — read out of the CLI bundle rather than
 * assumed — a session plugin's enablement is
 * `enabledPlugins[`${name}@inline`] ?? manifest.defaultEnabled !== false`, i.e.
 * **enabled by default**, with no settings-source grant required. That is why the
 * passthrough works where the symlink did not, and why herdctl#446 was right to
 * refuse to widen `setting_sources` instead.
 *
 * ## Which lever gates this, which is NOT the one #700 assumes
 *
 * #700 (and the brief written from it) scope plugin enumeration to
 * `claude.mcpServers: host`. That is half right, and shipping it that way would
 * have punched a hole through a different lever:
 *
 * - `plugins/` is bridged by **`claude.instructions`**, alongside `CLAUDE.md`,
 *   `agents/` and `commands/` — because most of a plugin IS instructions. Under
 *   `instructions: own` paddock withdraws that symlink and prints a notice saying
 *   the host's plugins are not loaded. Passing them anyway because a *different*
 *   key says `host` would contradict a notice paddock itself emits.
 * - the MCP servers inside a plugin are what `claude.mcpServers` is about.
 *
 * So both levers apply, to the two halves of a plugin, and the SDK has exactly
 * the flag needed to split them: `skipMcpDiscovery` loads a plugin's
 * skills/hooks/agents/commands but does NOT read its `.mcp.json` or manifest
 * `mcpServers`. Hence {@link enumerateHostPlugins}:
 *
 * | `instructions` | `mcpServers` | result |
 * |---|---|---|
 * | `host` | `host` | plugins passed whole |
 * | `host` | `own`  | plugins passed with `skipMcpDiscovery: true` |
 * | `own`  | *any*  | no plugins, and a notice saying which key turns them on |
 *
 * ## The allowlist, which is where this gets uncomfortable
 *
 * Both runtimes auto-deny any tool missing from an explicit `allowed_tools`, with
 * no prompt and nothing in the logs — the trap `claude-mcp.ts` documents at
 * length. A plugin-provided MCP server needs the same widening, so paddock has to
 * know its tool prefix *before* the plugin has ever run.
 *
 * It is knowable, from the CLI bundle: a plugin's servers are registered under
 * `` `plugin:${pluginName}:${serverName}` ``, and a server name is normalised
 * with `[^a-zA-Z0-9_-] → _` before it becomes a tool prefix. So the pattern is
 * `mcp__plugin_<plugin>_<server>__*` — matching the SDK's own documented example,
 * `mcp__plugin_documents_docs__doc_export`. {@link pluginMcpToolPattern} is that
 * one line, and {@link readPluginServerNames} recovers `<server>` by reading the
 * two places a plugin declares servers statically: `<dir>/.mcp.json` and an
 * inline `mcpServers` object in `<dir>/.claude-plugin/plugin.json`.
 *
 * What it CANNOT recover is a manifest whose `mcpServers` is a string or an array
 * of strings — a pointer to another file, or to an MCPB source the CLI downloads.
 * Resolving a same-directory JSON pointer is easy and is done; anything else is
 * recorded as a caveat and warned about at boot, naming the plugin, because the
 * failure it produces otherwise is the silent one: the plugin loads, its server
 * connects, and every tool call is denied with no log line. Better a warning that
 * says "add `mcp__plugin_x_y__*` yourself" than a mystery.
 *
 * ## What is read, and what is not verified
 *
 * Enumeration is from `<pluginRoot>/installed_plugins.json`, the CLI's own
 * registry of installs (v2: `{plugins: {"<name>@<marketplace>": [{installPath,
 * scope, …}]}}`; v1 keyed the same ids to a single record, whose path was derived
 * as `<pluginRoot>/cache/<marketplace>/<name>/<version>`). Both are read. The
 * host's `settings.json` `enabledPlugins` is consulted only to VETO — an id set
 * to `false` is skipped — because a session plugin's own default is "enabled",
 * so honouring the veto is the only thing that can respect a host's `/plugin
 * disable`.
 *
 * None of this was validated against a machine with plugins installed: this box
 * is Linux with an empty plugin root, and no test here proves a plugin *loads*.
 * Every path, file name and naming rule above comes from reading the bundled CLI
 * (`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`), and the tests
 * assert what config paddock produces from a planted directory tree, which is a
 * strictly weaker claim. A `marketplace`-installed plugin loading via
 * `type: "local"` remains unverified end-to-end and needs a real host.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServersMode } from "./claude-mcp.js";
import type { InstructionsMode } from "./claude-instructions.js";

/**
 * One plugin to load, in herdctl's `PluginSchema` object form.
 *
 * The schema also accepts a bare path string and normalises it to this, but
 * paddock always needs the object because {@link HostPlugin.skipMcpDiscovery} is
 * how the two levers are kept apart.
 */
export interface HostPlugin {
  type: "local";
  path: string;
  skipMcpDiscovery?: boolean;
}

/** Something about a host plugin worth telling the operator at boot. */
export interface HostPluginCaveat {
  /** The plugin's id (`<name>@<marketplace>`) or its directory name. */
  name: string;
  /** `dropped` = not passed at all; `degraded` = passed, but incompletely. */
  kind: "dropped" | "degraded";
  reason: string;
}

/** What {@link enumerateHostPlugins} found. */
export interface HostPluginSource {
  /** Ready for `agent.plugins`, in registry order. */
  plugins: HostPlugin[];
  /**
   * `mcp__<server>__*` patterns for every plugin-provided server paddock could
   * name statically. Empty whenever MCP discovery is off.
   */
  toolPatterns: string[];
  caveats: HostPluginCaveat[];
}

/** Nothing inherited: `instructions: own`, and where tests start. */
export const EMPTY_HOST_PLUGINS: HostPluginSource = Object.freeze({
  plugins: [],
  toolPatterns: [],
  caveats: [],
});

/** The plugin root, `join(CLAUDE_CONFIG_DIR, "plugins")` in the CLI's terms. */
export function hostPluginRoot(legacyClaudeHome: string): string {
  return path.join(legacyClaudeHome, "plugins");
}

/** The CLI's own registry of what is installed, under {@link hostPluginRoot}. */
export const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

/** A plugin's manifest, relative to its directory. */
export const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");

/** A plugin's out-of-manifest MCP declaration, relative to its directory. */
export const PLUGIN_MCP_FILE = ".mcp.json";

/**
 * The CLI's server-name normalisation: `[^a-zA-Z0-9_-] → _`, applied to the whole
 * `plugin:<plugin>:<server>` name before it becomes a `mcp__…__` prefix. Applied
 * to the joined string, not to the parts, so a `.` in a plugin name normalises
 * the same way the separators do.
 */
function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The allowlist pattern for one server of one plugin.
 *
 * Deliberately not `mcpToolPattern` from `claude-mcp.ts`: the name a plugin's
 * server is registered under is not the name it is declared under, and that
 * derivation is the whole content of this function.
 */
export function pluginMcpToolPattern(pluginName: string, serverName: string): string {
  return `mcp__${normalizeServerName(`plugin:${pluginName}:${serverName}`)}__*`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The server names one `.mcp.json`-shaped document declares.
 *
 * Claude Code accepts both `{mcpServers: {…}}` and a bare map at the top level,
 * so both are read — the CLI does `parsed.mcpServers || parsed`.
 */
function serverNamesOf(doc: unknown): string[] {
  if (!isRecord(doc)) return [];
  const servers = isRecord(doc.mcpServers) ? doc.mcpServers : doc;
  return Object.keys(servers).filter((k) => isRecord(servers[k]));
}

/** One plugin's name and the MCP servers it declares, as far as they are static. */
export interface PluginServerNames {
  /** `manifest.name`, else the directory name — the CLI's own fallback order. */
  pluginName: string;
  /** Server names as declared, BEFORE the `plugin:<plugin>:` prefixing. */
  servers: string[];
  /**
   * A `mcpServers` the manifest points at rather than spells out, and that could
   * not be resolved to a file inside the plugin directory. Non-empty means the
   * allowlist for this plugin is incomplete.
   */
  unresolved: string[];
}

/**
 * Read one plugin directory's declared MCP server names.
 *
 * Mirrors the CLI's own discovery order — `<dir>/.mcp.json` first, then whatever
 * `manifest.mcpServers` adds — with the one deliberate gap described in the
 * module doc: a manifest that points at an MCPB source (or at any path outside
 * its own directory) is recorded in {@link PluginServerNames.unresolved} rather
 * than fetched. Paddock does not download anything to build an allowlist.
 */
export async function readPluginServerNames(dir: string): Promise<PluginServerNames> {
  const manifest = await readJson(path.join(dir, PLUGIN_MANIFEST));
  const pluginName =
    isRecord(manifest) && typeof manifest.name === "string" && manifest.name.trim() !== ""
      ? manifest.name.trim()
      : path.basename(dir);
  const servers = new Set(serverNamesOf(await readJson(path.join(dir, PLUGIN_MCP_FILE))));
  const unresolved: string[] = [];

  const declared = isRecord(manifest) ? manifest.mcpServers : undefined;
  // A string entry is a path relative to the plugin directory (or an MCPB
  // source, which looks the same and is not resolvable without downloading it).
  // Resolve it only when it stays inside the directory and parses as JSON;
  // anything else is a gap paddock reports rather than guesses at.
  const resolveRef = async (ref: string): Promise<void> => {
    const target = path.resolve(dir, ref);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      unresolved.push(ref);
      return;
    }
    const names = serverNamesOf(await readJson(target));
    if (names.length === 0) unresolved.push(ref);
    else for (const n of names) servers.add(n);
  };

  if (typeof declared === "string") await resolveRef(declared);
  else if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (typeof entry === "string") await resolveRef(entry);
      else for (const n of serverNamesOf(entry)) servers.add(n);
    }
  } else if (isRecord(declared)) {
    for (const n of serverNamesOf(declared)) servers.add(n);
  }

  return { pluginName, servers: [...servers], unresolved };
}

/** One installed plugin: its id, and where it landed on disk. */
interface InstalledPlugin {
  id: string;
  installPath: string;
}

/**
 * Parse `installed_plugins.json`, v1 or v2. Pure, so the whole selection is
 * testable from a string.
 *
 * v2 keys each `<name>@<marketplace>` id to an ARRAY of installations (one per
 * scope), each carrying an explicit `installPath`. v1 keyed it to a single record
 * with no path, which the CLI derives as
 * `<root>/cache/<marketplace>/<name>/<version>` with each segment sanitised
 * `[^a-zA-Z0-9\-_] → -` (and the version segment additionally allowing `.`).
 *
 * Fails soft in every direction: this is a file paddock does not own and must
 * never turn into a boot failure.
 */
export function parseInstalledPlugins(raw: string, root: string): InstalledPlugin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) return [];
  const out: InstalledPlugin[] = [];
  for (const [id, entry] of Object.entries(parsed.plugins)) {
    if (Array.isArray(entry)) {
      for (const install of entry) {
        if (isRecord(install) && typeof install.installPath === "string" && install.installPath) {
          out.push({ id, installPath: install.installPath });
        }
      }
    } else if (isRecord(entry)) {
      const derived = legacyInstallPath(root, id, entry.version);
      if (derived) out.push({ id, installPath: derived });
    }
  }
  return out;
}

/** The v1 path derivation, kept beside its only caller. */
function legacyInstallPath(root: string, id: string, version: unknown): string | undefined {
  if (typeof version !== "string" || version === "") return undefined;
  const at = id.lastIndexOf("@");
  const name = at > 0 ? id.slice(0, at) : id;
  const marketplace = at > 0 ? id.slice(at + 1) : "unknown";
  const seg = (s: string) => s.replace(/[^a-zA-Z0-9\-_]/g, "-");
  let ver = version.replace(/[^a-zA-Z0-9\-_.]/g, "-");
  if (ver === "." || ver === "..") ver = "-";
  return path.join(root, "cache", seg(marketplace || "unknown"), seg(name), ver);
}

/** Ids the host has explicitly turned off, from its `settings.json`. */
function disabledIds(settings: unknown): Set<string> {
  const out = new Set<string>();
  if (!isRecord(settings) || !isRecord(settings.enabledPlugins)) return out;
  for (const [id, value] of Object.entries(settings.enabledPlugins)) {
    // Anything that is not an explicit `false` counts as enabled: the key also
    // takes an extended object form carrying a version constraint, and a version
    // constraint is not a disable.
    if (value === false) out.add(id.toLowerCase());
  }
  return out;
}

/** A line for the boot log, at a level (mirrors `HostMcpNotice`). */
export interface HostPluginNotice {
  level: "info" | "warn";
  message: string;
}

/** What {@link loadHostPlugins} found, ready for the agent config and the log. */
export interface HostPluginReport {
  source: HostPluginSource;
  notices: HostPluginNotice[];
}

/**
 * Enumerate the host's installed plugin directories. Pure apart from reading the
 * plugin tree, and takes the two files' contents rather than paths so the whole
 * selection is testable without a home directory.
 */
export async function enumerateHostPlugins(opts: {
  root: string;
  installed: string | undefined;
  settings: unknown;
  /** Whether the plugins' own MCP servers come too. */
  mcp: boolean;
}): Promise<HostPluginSource> {
  const caveats: HostPluginCaveat[] = [];
  if (opts.installed === undefined) return { plugins: [], toolPatterns: [], caveats };
  const disabled = disabledIds(opts.settings);
  const plugins: HostPlugin[] = [];
  const toolPatterns = new Set<string>();

  for (const install of parseInstalledPlugins(opts.installed, opts.root)) {
    if (disabled.has(install.id.toLowerCase())) continue;
    // A registry entry whose directory is gone is the normal aftermath of a
    // hand-deleted plugin. The SDK would log "Plugin path does not exist" and
    // carry on, but saying it here is what makes an empty `plugins` explicable.
    try {
      if (!(await fs.stat(install.installPath)).isDirectory()) throw new Error("not a directory");
    } catch {
      caveats.push({
        name: install.id,
        kind: "dropped",
        reason: `its recorded install directory (${install.installPath}) is missing`,
      });
      continue;
    }
    plugins.push(
      opts.mcp
        ? { type: "local", path: install.installPath }
        : { type: "local", path: install.installPath, skipMcpDiscovery: true },
    );
    if (!opts.mcp) continue;

    const { pluginName, servers, unresolved } = await readPluginServerNames(install.installPath);
    for (const server of servers) toolPatterns.add(pluginMcpToolPattern(pluginName, server));
    if (unresolved.length > 0) {
      caveats.push({
        name: install.id,
        kind: "degraded",
        reason:
          `its manifest points \`mcpServers\` at ${unresolved.join(", ")} rather than declaring ` +
          `them inline, so paddock cannot name its servers — the plugin is attached, but any ` +
          `tool it provides will be auto-denied with no prompt until you add the matching ` +
          `\`mcp__plugin_${normalizeServerName(pluginName)}_<server>__*\` to the keeper's ` +
          `allowed tools`,
      });
    }
  }
  return { plugins, toolPatterns: [...toolPatterns], caveats };
}

/**
 * Read the host's plugin registry — once, at boot — and say what came of it.
 *
 * Under `instructions: own` nothing is opened at all, for the same reason
 * `loadHostMcpSource` does not open `.claude.json` under `mcpServers: own`: "own
 * everywhere means nothing outside the data dir is read" is a guarantee that has
 * to be true in the place someone would check it.
 */
export async function loadHostPlugins(cfg: {
  legacyClaudeHome: string;
  claude: { instructions: InstructionsMode; mcpServers: McpServersMode };
}): Promise<HostPluginReport> {
  const notices: HostPluginNotice[] = [];
  const mcp = cfg.claude.mcpServers === "host";
  if (cfg.claude.instructions !== "host") {
    if (mcp) {
      // The one combination that silently does less than a user asked for, so it
      // is the one that gets a line naming the other key.
      notices.push({
        level: "info",
        message:
          "`claude.mcpServers: host` does not reach MCP servers provided by a Claude Code " +
          "plugin: a plugin is mostly commands, agents and skills, so loading one is a " +
          "`claude.instructions` decision. Set `claude.instructions: host` (or " +
          "PADDOCK_CLAUDE_INSTRUCTIONS=host) as well to inherit your plugins.",
      });
    }
    return { source: EMPTY_HOST_PLUGINS, notices };
  }

  const root = hostPluginRoot(cfg.legacyClaudeHome);
  const file = path.join(root, INSTALLED_PLUGINS_FILE);
  let installed: string | undefined;
  try {
    installed = await fs.readFile(file, "utf8");
  } catch {
    // Not a warning: no plugins installed is the overwhelmingly common case, and
    // this file does not exist until the first `claude plugin install`.
    return { source: EMPTY_HOST_PLUGINS, notices };
  }
  const settings = await readJson(path.join(cfg.legacyClaudeHome, "settings.json"));
  const source = await enumerateHostPlugins({ root, installed, settings, mcp });

  if (source.plugins.length > 0) {
    notices.push({
      level: "info",
      message:
        `Claude plugins: host (\`claude.instructions: host\`) — ${source.plugins.length} ` +
        `installed plugin${source.plugins.length === 1 ? "" : "s"} attached to every keeper` +
        (mcp
          ? source.toolPatterns.length > 0
            ? `, including their MCP servers (${source.toolPatterns.join(", ")})`
            : ", including their MCP servers (none declared)"
          : ". Their MCP servers are NOT attached (`claude.mcpServers: own`)") +
        ".",
    });
  }
  for (const caveat of source.caveats) {
    notices.push({
      level: "warn",
      message:
        caveat.kind === "dropped"
          ? `Claude plugin "${caveat.name}" was NOT attached: ${caveat.reason}.`
          : `Claude plugin "${caveat.name}" is attached but incomplete: ${caveat.reason}.`,
    });
  }
  return { source, notices };
}
