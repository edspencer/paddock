/**
 * The `claude.mcpServers` lever (#691): whose MCP servers this instance's agents
 * get.
 *
 * The last of the five levers, and the only one that is not about a file inside
 * `~/.claude`. Everything else in the `claude:` block is a bridge decision about
 * an entry of the home directory; MCP servers are declared in **`~/.claude.json`**,
 * which is a SIBLING of that directory rather than a member of it. Claude Code
 * resolves it as `join(CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json")` — read
 * out of the SDK bundle, where the two paths sit one expression apart and do not
 * agree:
 *
 * ```js
 * let d = n?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR,
 *     f = d ?? Dr(sO(), ".claude");     // .credentials.json lives under here
 * … await eV(Dr(f, ".credentials.json"), "utf-8")
 * … await KMe(Dr(d ?? sO(), ".claude.json"), …)   // ← homedir, NOT ~/.claude
 * ```
 *
 * So the moment paddock owns its own home (#620/#691) the user's `.claude.json`
 * stops being on the path, and NO symlink bridge inside the home structurally
 * can reach it. That is why MCP inheritance broke silently, separately from
 * everything else, and why this lever is a read rather than a link.
 *
 * ## Why not just symlink `.claude.json`
 *
 * Because Claude Code WRITES to it — per-project trust, `enabledMcpjsonServers`,
 * onboarding/migration flags, cached tips. Bridging it means paddock's instance
 * mutating the user's real config, which is the exact thing #691 exists to stop.
 * Read it, take the two keys that declare servers, hand those to the runtime.
 *
 * ## The seam, which is not the one #691 names
 *
 * #691 says to pass the servers through herdctl's runner option
 * (`SDKQueryOptions.mcpServers`, merged at `sdk-runtime.js`) and that **"paddock
 * sets none today"**. Both halves are wrong in a way that makes the work
 * smaller, not larger:
 *
 * 1. `SDKQueryOptions` is built BY herdctl (`toSDKOptions`), not by paddock.
 *    Paddock never constructs one. The field is populated from
 *    `transformMcpServers(agent.mcp_servers)` — i.e. from the AGENT CONFIG.
 * 2. Paddock already sets `mcp_servers`: the headless-Chromium server from
 *    `browserMcpServers` (#269) is an external stdio MCP server passed exactly
 *    this way, on every keeper and every trigger, whenever `PADDOCK_BROWSER_MCP`
 *    is on.
 *
 * `agent.mcp_servers` is also the seam that covers BOTH runtimes for free: the
 * SDK runtime transforms it into `sdkOptions.mcpServers`, and the CLI runtime
 * serialises the same record into `--mcp-config '{"mcpServers":…}'`
 * (`cli-runtime.js`). Passing it as a per-run option would have covered one.
 *
 * `injectedMcpServers` is, as #691 says, the wrong hook — `InjectedMcpServerDef`
 * is `{name, version, tools}` with in-process JS handlers (`send_file`), and both
 * runtimes materialise it as an HTTP bridge. It cannot express a stdio command.
 *
 * ## The allowlist, without which this lever is a no-op
 *
 * Paddock's fleet defaults carry an explicit `allowed_tools` array, and **both
 * runtimes auto-deny any tool not on it, with no prompt** (the lesson `Skill`
 * taught, recorded in `ensureConfigFile`). Tools from an MCP server are named
 * `mcp__<server>__<tool>`, so a host server that is passed but not allowlisted
 * connects and then has every one of its tools denied — an instance that looks
 * configured and does nothing.
 *
 * herdctl handles this for INJECTED servers only ("Auto-add injected MCP tool
 * patterns to allowedTools… only needed when the agent has an explicit
 * allowlist", `cli-runtime.js`); config `mcp_servers` get no such treatment,
 * which is why `mcp__playwright__*` is hard-coded into the defaults today. So
 * this module also produces {@link mcpToolPattern} for each host server, and
 * `buildAgentConfig` widens the keeper's allowlist by exactly those entries —
 * only when there are some, so an instance with no host servers stays
 * byte-identical to before.
 *
 * ## What could not be carried, and now can (herdctl 5.32.0)
 *
 * Until `@herdctl/core@5.32.0`, `McpServerSchema` was `{command?, args?, env?,
 * url?}`, so `headers` and `type` were silently STRIPPED at `addAgent` and
 * `transformMcpServer` rewrote every `url` to `type: "http"`. A
 * header-authenticated server arrived unauthenticated and an `sse` server was
 * downgraded to HTTP, so #699 shipped a boot warning naming every server that
 * lost a field.
 *
 * herdctl#446 (in 5.32.0) widened the schema to mirror the SDK's own
 * `McpServerConfig` — `type`, `headers`, `timeout` and `alwaysLoad` — and an
 * explicit `type` now wins over the bare-`url` inference. Verified against the
 * installed 5.32.0 rather than assumed: `addAgent` → `getAgents()` →
 * `toSDKOptions()` returns `{type: "sse", url, headers}` unchanged for a server
 * declared that way, and still infers `type: "http"` for a bare `url`. So the
 * two `degraded` caveats are gone and {@link McpServerDef} carries both fields.
 *
 * Why that mattered more than it looked, and why it is worth not regressing:
 * MCP OAuth tokens are stored under a top-level **`mcpOAuth`** key in the SAME
 * credential store as `claudeAiOauth` — `<securestorage-dir>/.credentials.json`
 * on Linux, the one `Claude Code-credentials` keychain item on darwin. There is
 * no MCP-specific service name and no `mcp-oauth/` directory. The store is
 * resolved by `CLAUDE_SECURESTORAGE_CONFIG_DIR ?? CLAUDE_CONFIG_DIR ?? ~/.claude`,
 * which is exactly the variable `claude.credentials` drives — **so
 * `credentials: host` DOES carry MCP OAuth tokens**, in either direction. But
 * the per-server key is `` `${serverName}|${sha256({type,url,headers}).slice(0,16)}` ``,
 * so a dropped header or a coerced `type` changed the hash and the stored token
 * was simply not found. Carrying both fields verbatim is what makes
 * `credentials: host` + `mcpServers: host` work for an OAuth server at all.
 *
 * `z.object` still strips what it has no field for (`tools`, and anything Claude
 * Code grows next), so this narrowing is still a narrowing — it is just no longer
 * one that breaks authentication. The one case that is still DROPPED is a server
 * with neither `command` nor `url`, which cannot be started at all.
 *
 * ## The cost of carrying `headers`, which is real and is upstream
 *
 * herdctl's **CLI runtime** serialises the whole `mcp_servers` record into a
 * single `--mcp-config '{"mcpServers":…}'` argv element, so everything in it is
 * readable from `/proc/<pid>/cmdline` by any process of the same user. That was
 * already true of an `env` value; it is now true of an `Authorization` header as
 * well, which is the more likely place a bearer token lives. The SDK runtime
 * passes the record in-process and is unaffected.
 *
 * Paddock's chats default to the SDK runtime (`driveMode: session`), but the
 * sweeper and triggers are always one-shot CLI runs and a `driveMode: batch`
 * project's turns are too — and neither the sweeper nor a trigger is given these
 * servers, so the exposure is `driveMode: batch` only. Not paddock's to fix (the
 * argv shape is herdctl's) and not a reason to go back to dropping the header:
 * a stripped header is an authentication failure for everyone, while this is a
 * same-user disclosure on one non-default drive mode. Worth knowing before
 * putting a long-lived token in a `headers` block on a shared box.
 *
 * ## Plugins are the other half of this lever
 *
 * A Claude Code **plugin** can provide MCP servers too, and they are invisible to
 * everything above: they are declared inside the plugin, not in `.claude.json`
 * (#700). `claude-plugins.ts` is that half — it enumerates the host's installed
 * plugin directories for `agent.plugins`, the second thing 5.32.0 added.
 *
 * ## Scope: keepers only
 *
 * The sweeper is tool-less by design and the trigger agents declare their own
 * narrow `allowed_tools` per trigger, so neither would be able to call a host
 * server even if it were attached. Attaching one anyway would spawn a stdio
 * process per fire for nothing. Keepers are what a user means by "my MCP servers
 * in paddock".
 *
 * ## Step 6 landed here, as an addition
 *
 * #691 step 6 — an instance-level `mcpServers:` block in `paddock.config.yaml`
 * for servers a user declares themselves — is `mcp-servers.ts`. It contributes
 * {@link McpSources.declared} and nothing else: the shape, {@link mcpServersFor},
 * and the allowlist widening in `buildAgentConfig` were already source-agnostic
 * and did not change. What it does NOT share is validation posture — a host
 * server paddock cannot carry faithfully is passed with a warning (the user
 * declared it elsewhere, for something else), while a declared one is refused
 * with an error (they typed it here, at us, and can fix it).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Whose MCP servers this instance's agents get — the `claude.mcpServers` key.
 *
 * `own` (default) = only the servers paddock itself attaches (`send_file`, the
 * optional self-management tools, the optional browser server). `host` = the
 * servers declared in the user's `~/.claude.json` as well, both the user-scope
 * ones and the ones scoped to a project's own directory.
 */
export type McpServersMode = "own" | "host";

/** Isolation is the default, as everywhere except `credentials`. */
export const DEFAULT_MCP_SERVERS_MODE: McpServersMode = "own";

/** Type guard, so an unknown config value falls back instead of failing a boot. */
export function isKnownMcpServersMode(value: string): value is McpServersMode {
  return value === "own" || value === "host";
}

/**
 * The file MCP servers are declared in — a SIBLING of the Claude home, not an
 * entry inside it. See the module doc for the SDK expression that settles this.
 */
export const HOST_MCP_CONFIG_FILE = ".claude.json";

/**
 * Where the user's own `.claude.json` is.
 *
 * Derived from `cfg.legacyClaudeHome` (always `~/.claude`) rather than read from
 * `os.homedir()` again, so it moves with the one value the rest of the bridge
 * already treats as "the host's Claude Code" — and so a test can point the whole
 * lever at a temp dir by setting that one field.
 */
export function hostMcpConfigPath(legacyClaudeHome: string): string {
  return path.join(path.dirname(legacyClaudeHome), HOST_MCP_CONFIG_FILE);
}

/**
 * One MCP server, in the only shape herdctl's `McpServerSchema` can carry.
 *
 * Deliberately NOT `SDKMcpServerConfig`: that is what herdctl produces on the
 * far side of `transformMcpServer`, and pinning the agent-config shape here is
 * what keeps any remaining lossiness visible at the type level rather than at
 * runtime. As of herdctl 5.32.0 the two differ only in what the SDK has that
 * herdctl still has no field for (`tools`).
 */
export interface McpServerDef {
  /** Explicit transport. Wins over the bare-`url` ⇒ `http` inference (5.32.0). */
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Carried verbatim since 5.32.0 — and part of the OAuth token's key. */
  headers?: Record<string, string>;
}

/** A set of MCP servers, keyed by the name their tools are namespaced under. */
export type McpServerDefs = Record<string, McpServerDef>;

/** Something about a declared server that could not be carried through. */
export interface HostMcpCaveat {
  /** The server's name in `.claude.json`. */
  name: string;
  /**
   * `dropped` = not passed at all; `degraded` = passed, but not faithfully.
   *
   * Nothing produces `degraded` since herdctl 5.32.0 carries `headers` and
   * `type` verbatim (#700) — the variant and its notice branch are kept because
   * the class of defect ("the engine has no field for this") is the one #699 was
   * filed about and is one schema narrowing away from coming back.
   */
  kind: "dropped" | "degraded";
  /** Human-readable, and specific enough to act on. */
  reason: string;
}

/**
 * Every MCP server this instance will attach, from every source, plus what could
 * not be carried.
 *
 * The host's `~/.claude.json` supplies two scopes, because that file has two: a
 * top-level `mcpServers` that applies everywhere, and a
 * `projects[<absolute dir>].mcpServers` that applies only in that directory. The
 * per-directory one is keyed by the LITERAL absolute path — not the `-`-encoded
 * form the transcript folders use — and it is the scope a `--here` workspace
 * hits, because `claude mcp add` without `--scope user` writes there.
 *
 * {@link declared} is the third contributor and the one that is not the host's at
 * all: paddock's own top-level `mcpServers:` config block (#691 step 6), resolved
 * by `mcp-servers.ts`. It is carried here rather than threaded separately so that
 * everything downstream of this type — {@link mcpServersFor}, the allowlist
 * widening in `buildAgentConfig` — stays source-agnostic and had to change not at
 * all when it was added.
 */
export interface McpSources {
  /** Host `~/.claude.json` top-level `mcpServers`: every keeper gets these. */
  user: McpServerDefs;
  /** Host `projects[<dir>].mcpServers`, keyed by the literal absolute directory. */
  byDir: Record<string, McpServerDefs>;
  /** Declared by this instance in `paddock.config.yaml`; every keeper gets these. */
  declared: McpServerDefs;
  /** Everything the host file could not carry faithfully, for the boot notice. */
  caveats: HostMcpCaveat[];
}

/** No servers from anywhere: `mcpServers: own` + an empty block, and where tests start. */
export const EMPTY_MCP_SOURCES: McpSources = Object.freeze({
  user: {},
  byDir: {},
  declared: {},
  caveats: [],
});

/** The allowlist entry that lets a server's tools actually be called. */
export function mcpToolPattern(name: string): string {
  return `mcp__${name}__*`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Narrow one declared server to what herdctl can carry, recording what was lost.
 *
 * Returns `undefined` for a server that cannot be started at all — no `command`
 * and no `url` — which is the only case where dropping beats degrading.
 */
function narrowServer(
  name: string,
  raw: unknown,
  caveats: HostMcpCaveat[],
): McpServerDef | undefined {
  if (!isRecord(raw)) {
    caveats.push({ name, kind: "dropped", reason: "its declaration is not a JSON object" });
    return undefined;
  }
  const server: McpServerDef = {};
  if (typeof raw.command === "string" && raw.command !== "") server.command = raw.command;
  if (Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string")) {
    if (raw.args.length > 0) server.args = [...(raw.args as string[])];
  }
  if (isRecord(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === "string") env[k] = v;
    if (Object.keys(env).length > 0) server.env = env;
  }
  if (typeof raw.url === "string" && raw.url !== "") server.url = raw.url;
  // Both carried verbatim since herdctl 5.32.0 (#700). Before that they were
  // stripped at `addAgent` and this function pushed a `degraded` caveat naming
  // the server; the fields reaching `toSDKOptions()` intact is what retired that
  // warning. A `type` we do not recognise is left off rather than passed on —
  // herdctl's enum would strip it anyway, and the bare-`url` inference is the
  // better fallback than nothing.
  if (raw.type === "stdio" || raw.type === "sse" || raw.type === "http") server.type = raw.type;
  if (isRecord(raw.headers)) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === "string") headers[k] = v;
    if (Object.keys(headers).length > 0) server.headers = headers;
  }

  if (server.command === undefined && server.url === undefined) {
    caveats.push({
      name,
      kind: "dropped",
      reason: "it declares neither a `command` nor a `url`, so there is nothing to start",
    });
    return undefined;
  }
  return server;
}

function serversOf(raw: unknown, caveats: HostMcpCaveat[]): McpServerDefs {
  if (!isRecord(raw)) return {};
  const out: McpServerDefs = {};
  for (const [name, decl] of Object.entries(raw)) {
    const server = narrowServer(name, decl, caveats);
    if (server) out[name] = server;
  }
  return out;
}

/**
 * Parse a `.claude.json` into the two server scopes. Pure, so the whole
 * selection is testable from a string with no filesystem and no real home.
 *
 * Fails soft in both directions on purpose. Unparseable JSON, a non-object top
 * level, a `projects` value that is not a map — none of them throw, because the
 * user's `.claude.json` is a file paddock does not own, cannot validate and must
 * never turn into a boot failure. What it does instead is return nothing and let
 * the caller say so.
 */
export function parseHostMcpConfig(raw: string): McpSources {
  const caveats: HostMcpCaveat[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { user: {}, byDir: {}, declared: {}, caveats };
  }
  if (!isRecord(parsed)) return { user: {}, byDir: {}, declared: {}, caveats };

  const user = serversOf(parsed.mcpServers, caveats);
  const byDir: Record<string, McpServerDefs> = {};
  if (isRecord(parsed.projects)) {
    for (const [dir, entry] of Object.entries(parsed.projects)) {
      if (!isRecord(entry)) continue;
      const servers = serversOf(entry.mcpServers, caveats);
      if (Object.keys(servers).length > 0) byDir[dir] = servers;
    }
  }
  return { user, byDir, declared: {}, caveats };
}

/**
 * The servers that apply to one agent's working directory.
 *
 * Precedence, weakest first: host user scope, host directory scope, then this
 * instance's own `mcpServers:` block.
 *
 * Host per-directory wins over host user scope because it is the more specific
 * declaration, and it is the one `claude mcp add` writes by default, so a user
 * who re-declared a server inside a project meant that one. {@link
 * McpSources.declared} wins over both because it is a statement about THIS
 * instance while `~/.claude.json` is ambient machine state — a user who wrote a
 * server into paddock's own config was answering "what should paddock have?",
 * which is a narrower question than "what does this machine have?".
 *
 * The host lookup is exact rather than a prefix walk. `.claude.json`'s `projects`
 * keys are the literal cwd Claude Code was started in, and Claude Code does not
 * inherit a parent directory's entry either — matching that keeps paddock's
 * answer the same as the terminal's, which is the whole point of `host`.
 */
export function mcpServersFor(source: McpSources, workingDir: string): McpServerDefs {
  return { ...source.user, ...(source.byDir[workingDir] ?? {}), ...source.declared };
}

/** Every directory-scoped key, for the boot notice. */
export function hostMcpScopedDirs(source: McpSources): string[] {
  return Object.keys(source.byDir);
}

/** A line for the boot log, at a level (mirrors `ClaudeHomeReport.notices`). */
export interface HostMcpNotice {
  level: "info" | "warn";
  message: string;
}

/** What {@link loadHostMcpSource} found. */
export interface HostMcpReport {
  source: McpSources;
  notices: HostMcpNotice[];
}

/**
 * Read the host's `.claude.json` — once, at boot — and say what came of it.
 *
 * Under `own` the file is not opened at all. That is not an optimisation: "own
 * everywhere means nothing outside the data dir is read" is the guarantee #691
 * exists to make sayable, and a lever that read the file and then discarded it
 * would make the guarantee false in the only place anyone could check.
 *
 * Read once rather than per turn, for the same reason `claude.hooks` materialises
 * its `settings.json` once: a `.claude.json` that grows a server mid-run is picked
 * up at the next restart, and the boot notice is where a user looks to confirm
 * what this instance actually has.
 */
export async function loadHostMcpSource(cfg: {
  legacyClaudeHome: string;
  claude: { mcpServers: McpServersMode };
}): Promise<HostMcpReport> {
  if (cfg.claude.mcpServers !== "host") return { source: EMPTY_MCP_SOURCES, notices: [] };
  const file = hostMcpConfigPath(cfg.legacyClaudeHome);
  const notices: HostMcpNotice[] = [];
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    notices.push({
      level: "info",
      message:
        `\`claude.mcpServers: host\` is set but ${file} could not be read (${String(err)}) — ` +
        `no host MCP servers are attached. That file is where \`claude mcp add\` writes; ` +
        `it does not exist until you have added one.`,
    });
    return { source: EMPTY_MCP_SOURCES, notices };
  }
  const source = parseHostMcpConfig(raw);
  const userNames = Object.keys(source.user);
  const scoped = hostMcpScopedDirs(source);
  const total =
    userNames.length + scoped.reduce((n, d) => n + Object.keys(source.byDir[d]).length, 0);
  if (total === 0) {
    notices.push({
      level: "info",
      message:
        `\`claude.mcpServers: host\`: no MCP servers are declared in ${file} ` +
        `(neither at the top level nor under any \`projects\` entry).`,
    });
  } else {
    notices.push({
      level: "info",
      message:
        `Claude MCP servers: host (\`claude.mcpServers: host\`) — ` +
        (userNames.length > 0 ? `user scope: ${userNames.join(", ")}` : "no user-scope servers") +
        (scoped.length > 0
          ? `; directory scope: ${scoped
              .map((d) => `${d} (${Object.keys(source.byDir[d]).join(", ")})`)
              .join(", ")}`
          : "") +
        `. A project's keeper gets the user-scope servers plus any scoped to its own ` +
        `working directory.`,
    });
  }
  for (const caveat of source.caveats) {
    notices.push({
      level: "warn",
      message:
        caveat.kind === "dropped"
          ? `MCP server "${caveat.name}" in ${file} was NOT attached: ${caveat.reason}.`
          : `MCP server "${caveat.name}" from ${file} is attached but degraded: ${caveat.reason}.`,
    });
  }
  return { source, notices };
}
