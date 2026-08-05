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
 * ## What cannot be carried, honestly
 *
 * herdctl's `McpServerSchema` is `{command?, args?, env?, url?}` and it is a
 * plain `z.object`, so anything else is silently STRIPPED at `addAgent`. Two
 * consequences that matter and that #691 does not mention:
 *
 * - **`headers` is dropped.** A remote MCP server authenticated with a bearer
 *   header therefore arrives unauthenticated.
 * - **`type` is dropped**, and `transformMcpServer` maps any `url` to
 *   `type: "http"`. An `sse` server is silently downgraded to HTTP.
 *
 * And those two strippings are worse than they look, because of where MCP OAuth
 * tokens turn out to live. #691 listed that as an open question; it is now
 * answered, from the bundled CLI binary rather than by inference:
 *
 * - Tokens are stored under a top-level **`mcpOAuth`** key in the SAME credential
 *   store as `claudeAiOauth` — `<securestorage-dir>/.credentials.json` on Linux,
 *   the one `Claude Code-credentials` keychain item on darwin. There is no
 *   MCP-specific service name and no `mcp-oauth/` directory. The store is
 *   resolved by `CLAUDE_SECURESTORAGE_CONFIG_DIR ?? CLAUDE_CONFIG_DIR ?? ~/.claude`,
 *   which is exactly the variable `claude.credentials` drives. **So
 *   `credentials: host` DOES carry MCP OAuth tokens** — they are not separable
 *   from the Anthropic login, in either direction.
 * - But the per-server key is `` `${serverName}|${sha256({type,url,headers}).slice(0,16)}` ``.
 *   A dropped `headers`, or an `sse` coerced to `http`, changes that hash and the
 *   stored token is simply not found. So the combination that works today is
 *   `credentials: host` + `mcpServers: host` for an OAuth server declared with no
 *   headers and no `type` disagreement; a header-authenticated or `sse` server
 *   arrives looking unauthenticated even though its token is right there.
 *
 * Neither is paddock's to fix here (both need a herdctl schema change). What
 * paddock CAN do is refuse to be silent about it: {@link parseHostMcpConfig}
 * records every key it had to drop and every `sse` it had to coerce, and the
 * boot notice names the server. The server is still passed — this is a
 * capability lever, not a security one, and a user who declared a server should
 * get it plus a warning rather than nothing plus a warning. The one case that IS
 * dropped is a server with neither `command` nor `url`, which cannot be started
 * at all.
 *
 * ## Scope: keepers only
 *
 * The sweeper is tool-less by design and the trigger agents declare their own
 * narrow `allowed_tools` per trigger, so neither would be able to call a host
 * server even if it were attached. Attaching one anyway would spawn a stdio
 * process per fire for nothing. Keepers are what a user means by "my MCP servers
 * in paddock".
 *
 * ## Built so step 6 is an addition, not a rewrite
 *
 * #691 step 6 is an instance-level `mcpServers:` block in `paddock.config.yaml`
 * for servers a user declares themselves. Everything below the parse — the
 * {@link HostMcpSource} shape, {@link mcpServersFor}, the allowlist widening in
 * `buildAgentConfig` — is source-agnostic. Step 6 adds a second contributor to
 * `HostMcpSource.user` and changes nothing else.
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
 * far side of `transformMcpServer`, and pinning the narrower agent-config shape
 * here is what makes the lossiness above visible at the type level rather than
 * at runtime.
 */
export interface HostMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** A set of MCP servers, keyed by the name their tools are namespaced under. */
export type HostMcpServers = Record<string, HostMcpServer>;

/** Something about a declared server that could not be carried through. */
export interface HostMcpCaveat {
  /** The server's name in `.claude.json`. */
  name: string;
  /** `dropped` = not passed at all; `degraded` = passed, but not faithfully. */
  kind: "dropped" | "degraded";
  /** Human-readable, and specific enough to act on. */
  reason: string;
}

/**
 * The user's declared servers, parsed once and looked up per working directory.
 *
 * Two scopes, because `.claude.json` has two: a top-level `mcpServers` that
 * applies everywhere, and a `projects[<absolute dir>].mcpServers` that applies
 * only in that directory. The per-directory one is keyed by the LITERAL absolute
 * path — not the `-`-encoded form the transcript folders use — and it is the
 * scope a `--here` workspace hits, because `claude mcp add` without `--scope
 * user` writes there.
 */
export interface HostMcpSource {
  /** Top-level `mcpServers`: every keeper gets these. */
  user: HostMcpServers;
  /** `projects[<dir>].mcpServers`, keyed by the literal absolute directory. */
  byDir: Record<string, HostMcpServers>;
  /** Everything that could not be carried faithfully, for the boot notice. */
  caveats: HostMcpCaveat[];
}

/** `mcpServers: own`, an unreadable file, and the value tests start from. */
export const EMPTY_HOST_MCP: HostMcpSource = Object.freeze({
  user: {},
  byDir: {},
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
): HostMcpServer | undefined {
  if (!isRecord(raw)) {
    caveats.push({ name, kind: "dropped", reason: "its declaration is not a JSON object" });
    return undefined;
  }
  const server: HostMcpServer = {};
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

  if (server.command === undefined && server.url === undefined) {
    caveats.push({
      name,
      kind: "dropped",
      reason: "it declares neither a `command` nor a `url`, so there is nothing to start",
    });
    return undefined;
  }
  // The lossy bits. `type` and `headers` are real keys of Claude Code's own MCP
  // config that herdctl's schema has no field for and therefore strips; saying so
  // is the difference between "my Notion server does not work" and "my Notion
  // server's bearer header was dropped, here is the issue to file".
  if (isRecord(raw.headers) && Object.keys(raw.headers).length > 0) {
    caveats.push({
      name,
      kind: "degraded",
      reason:
        `its \`headers\` (${Object.keys(raw.headers).join(", ")}) cannot be carried — ` +
        `herdctl's MCP schema has no field for them, so the server is passed WITHOUT them, ` +
        `any auth they held is gone, and its stored OAuth token (keyed on a hash that ` +
        `includes the headers) will not be found either`,
    });
  }
  if (raw.type === "sse") {
    caveats.push({
      name,
      kind: "degraded",
      reason:
        'it is an `sse` server, and herdctl maps every `url` to `type: "http"` — it will ' +
        "be connected to as HTTP, and any OAuth token stored against the `sse` shape " +
        "will not be found",
    });
  }
  return server;
}

function serversOf(raw: unknown, caveats: HostMcpCaveat[]): HostMcpServers {
  if (!isRecord(raw)) return {};
  const out: HostMcpServers = {};
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
export function parseHostMcpConfig(raw: string): HostMcpSource {
  const caveats: HostMcpCaveat[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { user: {}, byDir: {}, caveats };
  }
  if (!isRecord(parsed)) return { user: {}, byDir: {}, caveats };

  const user = serversOf(parsed.mcpServers, caveats);
  const byDir: Record<string, HostMcpServers> = {};
  if (isRecord(parsed.projects)) {
    for (const [dir, entry] of Object.entries(parsed.projects)) {
      if (!isRecord(entry)) continue;
      const servers = serversOf(entry.mcpServers, caveats);
      if (Object.keys(servers).length > 0) byDir[dir] = servers;
    }
  }
  return { user, byDir, caveats };
}

/**
 * The servers that apply to one agent's working directory.
 *
 * Per-directory wins on a name collision: it is the more specific declaration,
 * and it is the one `claude mcp add` writes by default, so a user who re-declared
 * a server inside a project meant that one.
 *
 * The lookup is exact rather than a prefix walk. `.claude.json`'s `projects` keys
 * are the literal cwd Claude Code was started in, and Claude Code does not
 * inherit a parent directory's entry either — matching that keeps paddock's
 * answer the same as the terminal's, which is the whole point of `host`.
 */
export function mcpServersFor(source: HostMcpSource, workingDir: string): HostMcpServers {
  return { ...source.user, ...(source.byDir[workingDir] ?? {}) };
}

/** Every directory-scoped key, for the boot notice. */
export function hostMcpScopedDirs(source: HostMcpSource): string[] {
  return Object.keys(source.byDir);
}

/** A line for the boot log, at a level (mirrors `ClaudeHomeReport.notices`). */
export interface HostMcpNotice {
  level: "info" | "warn";
  message: string;
}

/** What {@link loadHostMcpSource} found. */
export interface HostMcpReport {
  source: HostMcpSource;
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
  if (cfg.claude.mcpServers !== "host") return { source: EMPTY_HOST_MCP, notices: [] };
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
    return { source: EMPTY_HOST_MCP, notices };
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
