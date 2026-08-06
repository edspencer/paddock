/**
 * The top-level `mcpServers:` block of `paddock.config.yaml` (#691 step 6):
 * MCP servers a user declares **to paddock itself**.
 *
 * ## Why this is not another `claude:` key
 *
 * The five `claude:` levers all answer one question — *whose X does this instance
 * use?* — and every one of them has a `host` side that borrows something the
 * machine already has. `claude.mcpServers: host` therefore only helps a user who
 * has already run `claude mcp add` on this box. Someone standing up paddock in a
 * container, who wants Notion inside it, has nothing to borrow; the question they
 * are asking is *"this instance should have this server"*, which is a declaration
 * rather than an inheritance. So it is a sibling of `claude:`, not a member.
 *
 * ## Everything below the parse is shared with step 5
 *
 * `claude-mcp.ts` already built the hard half: the shape herdctl can carry, the
 * per-working-directory merge, and — the trap — widening the keeper's
 * `allowed_tools` by one `mcp__<name>__*` pattern per server, without which an
 * attached server has every call auto-denied with no prompt and no log line. A
 * declared server needs all of it identically, so this module produces
 * {@link McpServerDefs} and hands them to {@link McpSources.declared}. The only
 * thing that is genuinely new here is validation and secrets.
 *
 * ## Precedence
 *
 * `host` < declared < paddock's own. A name declared here beats the same name
 * inherited from `~/.claude.json`, because this file is a statement about THIS
 * instance and the other is ambient machine state. Paddock's own servers
 * (`send_file`, the self-management tools, the browser server) still win, for the
 * reason they already won over `host`: their configuration is box-specific and
 * they are wired up by a different mechanism entirely. A collision with the
 * browser server is warned about by name at boot rather than being silent; a
 * collision with an INJECTED server is refused outright, because those are
 * materialised as an HTTP bridge under the same `mcp__<name>__*` namespace and
 * two servers claiming one namespace has no defined winner.
 *
 * ## Secrets, which is the real work here
 *
 * This is the first place in #691 where a user types a credential into paddock's
 * own config file, and that file is git-tracked (and readable through the
 * Settings screen's config path). So this module borrows the rule
 * `management-config.ts` already sets for management tokens: **`env:VAR_NAME` is
 * a reference, resolved from the environment at boot.** Here it is accepted
 * anywhere a string is (`command`, each `args` entry, each `env` value, `url`),
 * so there is one rule to learn rather than a list of blessed fields.
 *
 * Unlike a management token, an MCP `env` entry is not necessarily secret
 * (`NOTION_VERSION: "2022-06-28"` is not), so an inline value is a WARNING and
 * not an error — but the warning is emitted for any key that looks like a
 * credential, and nothing in this module ever prints a value. `headers` follows
 * the same rule and for a stronger reason: `Authorization` is the usual reason a
 * header is declared at all. Every diagnostic names keys, variable names and
 * server names only; a `url` is reported with its query string and userinfo
 * stripped, because that is where an API key rides. {@link describeServer} is the
 * single place a server is rendered for a human, so there is one function to
 * audit rather than a scattering of template strings.
 *
 * The resolved values do land in the frozen `PaddockConfig` (as management tokens
 * already do). They must never reach an API response: `instance-config.ts`
 * publishes only the fields in its own `FIELDS` table, and this block is
 * deliberately absent from it.
 *
 * One exposure the `env:` indirection does NOT close, and that carrying `headers`
 * widens: under `driveMode: batch` herdctl's CLI runtime serialises the whole
 * `mcp_servers` record into one `--mcp-config` argv element, so a resolved value
 * — an `env` entry, and now an `Authorization` header — is readable from
 * `/proc/<pid>/cmdline` by any process of the same user. See `claude-mcp.ts`; it
 * is upstream, and it is still better than the header being dropped.
 *
 * ## Validation is strict, and drops rather than degrades
 *
 * Step 5 passes a host server it cannot carry faithfully, with a warning, on the
 * grounds that a user who declared a server elsewhere should get it plus a
 * warning rather than nothing plus a warning. That reasoning inverts here,
 * because the user typed this file: an unusable declaration is a mistake they can
 * fix. So anything that cannot be carried is an ERROR and that server is not
 * attached — including an unknown key, which is how a typo (`arg:` for `args:`)
 * otherwise becomes a server that starts wrong.
 *
 * `headers:` and `type: sse` USED to be in that category, because herdctl's
 * schema had no field for either. herdctl 5.32.0 (#446) carries both verbatim,
 * so refusing them would now reject a declaration that works — they are accepted,
 * and `headers` is a first-class secret-bearing field with the same `env:VAR`
 * resolution and the same never-print rule as `env`.
 *
 * Never a boot failure, though: one bad server drops itself and the rest attach,
 * matching `resolveManagementApiConfig`. A typo in a capability must not take an
 * instance down.
 */
import type { McpServerDefs, McpServerDef } from "./claude-mcp.js";
import type { DriveMode } from "./models.js";

/** On-disk shape of one entry of the `mcpServers:` block. Every field optional. */
export interface McpServerConfigFile {
  /** Executable for a stdio server. Mutually exclusive with {@link url}. */
  command?: string;
  /** Arguments for {@link command}. */
  args?: string[];
  /** Environment for the server process. Values may be `env:VAR_NAME`. */
  env?: Record<string, string>;
  /** Endpoint for a remote server. Mutually exclusive with {@link command}. */
  url?: string;
  /** `stdio` for a {@link command}; `http` or `sse` for a {@link url}. */
  type?: string;
  /** Headers for a remote server. Values may be `env:VAR_NAME`. */
  headers?: Record<string, string>;
}

/** On-disk shape of the whole block: a map of server name → declaration. */
export type McpServersConfigFile = Record<string, McpServerConfigFile | null | undefined>;

/** Outcome of resolving the block, with everything worth telling the operator. */
export interface DeclaredMcpResolution {
  /** The servers that will be attached to every keeper. */
  servers: McpServerDefs;
  /** Declarations that could not be carried (logged at error level, server dropped). */
  errors: string[];
  /** Advice and fail-closed drops (logged at warn level). */
  warnings: string[];
}

/**
 * The prefix that makes a string an environment reference rather than a literal.
 * Same spelling as `managementApi.clients.<id>.auth.ref`, deliberately: an
 * operator should have to learn it once.
 */
export const ENV_REF_PREFIX = "env:";

/**
 * Server names paddock materialises itself, which a declaration may not take.
 *
 * Kept as literals rather than imported from `send-file-mcp.ts`/`self-mcp.ts` so
 * config resolution stays free of the runtime modules — `mcp-servers-reserved`
 * in the unit tests asserts the two spellings still agree.
 */
export const RESERVED_MCP_SERVER_NAMES: readonly string[] = ["paddock", "paddock_manage"];

/**
 * `mcp__<server>__<tool>` is the tool name both runtimes match against, and the
 * allowlist pattern is built from it by string concatenation, so a name with a
 * separator or whitespace in it produces a pattern that matches nothing. Claude
 * Code uses the same character class for a server name.
 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Keys of a declaration this module understands. Anything else is a typo. */
const KNOWN_KEYS = new Set(["command", "args", "env", "url", "type", "headers"]);

/**
 * Env keys whose INLINE value is probably a credential. Deliberately a name
 * heuristic and never a value one: matching on the value would mean reading it
 * closely enough to describe it, and this module's whole posture is that it
 * never looks at a value it is not about to hand to a server process.
 */
const SECRET_ISH_KEY_RE = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|PAT|COOKIE)/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A URL with everything credential-shaped removed — no query string, no
 * fragment, no `user:pass@`. Used for every log line that mentions a `url`,
 * because a remote MCP endpoint's API key is conventionally a query parameter.
 * An unparseable URL is reported as its scheme only rather than echoed.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const auth = u.username || u.password ? "<redacted>@" : "";
    return `${u.protocol}//${auth}${u.host}${u.pathname}${u.search ? "?<redacted>" : ""}`;
  } catch {
    return "<unparseable url>";
  }
}

/**
 * A server rendered for a human, carrying no secret. THE chokepoint: every
 * notice, warning and error about a declared server goes through here, so
 * auditing "can a token reach a log line?" is auditing one function.
 *
 * Args and env values are counted, never printed — an API key is as likely to be
 * `--token=…` in `args` as it is to be an `env` value. The command is reduced to
 * its basename for the same reason, which the leak test in
 * `test/unit/mcp-servers.test.ts` is what forced: a full path is more useful in a
 * log, but the rule "nothing from the block is echoed" is only worth having if it
 * has no exceptions to remember. The server's own name is printed alongside and
 * is what actually identifies it.
 */
export function describeServer(name: string, def: McpServerDef): string {
  const parts: string[] = [];
  if (def.command) parts.push(`stdio: ${def.command.split(/[\\/]/).pop()}`);
  if (def.url) parts.push(`${def.type ?? "http"}: ${redactUrl(def.url)}`);
  if (def.args?.length) parts.push(`${def.args.length} args`);
  const envCount = Object.keys(def.env ?? {}).length;
  if (envCount > 0) parts.push(`${envCount} env ${envCount === 1 ? "entry" : "entries"}`);
  const headerCount = Object.keys(def.headers ?? {}).length;
  if (headerCount > 0) parts.push(`${headerCount} ${headerCount === 1 ? "header" : "headers"}`);
  return `${name} (${parts.join(", ")})`;
}

/** One string leaf, resolved through the `env:` indirection. */
type LeafResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Resolve a string leaf: `env:VAR_NAME` reads `VAR_NAME`, anything else is a
 * literal.
 *
 * An unset or blank variable FAILS the leaf, which drops the whole server. That
 * is the fail-closed direction here for the same reason it is in
 * `management-config.ts`: a server started without the credential it was
 * declared with either fails every call confusingly or — worse for something
 * that talks to a third party — connects unauthenticated.
 */
function resolveLeaf(
  raw: string,
  env: Record<string, string | undefined>,
  where: string,
): LeafResult {
  if (!raw.startsWith(ENV_REF_PREFIX)) return { ok: true, value: raw };
  const varName = raw.slice(ENV_REF_PREFIX.length).trim();
  if (varName.length === 0) return { ok: false, error: `${where}: \`env:\` names no variable` };
  const value = env[varName];
  if (value === undefined || value.trim().length === 0) {
    return {
      ok: false,
      error: `${where}: environment variable ${varName} is unset or empty`,
    };
  }
  return { ok: true, value };
}

/** Everything one declaration produced: a server, or the reason there isn't one. */
interface NarrowResult {
  server?: McpServerDef;
  errors: string[];
  warnings: string[];
}

/**
 * Validate + resolve one declaration into the shape herdctl's `McpServerSchema`
 * carries, or explain why it cannot be.
 *
 * The one rejection left that is about the engine rather than about the file is
 * **an unknown key** — the only defence against `arg:`/`envs:`/`commands:`, which
 * would otherwise yield a server that starts with the wrong argv.
 *
 * `headers` and `type: sse` were rejections too until herdctl 5.32.0, because
 * the schema had no field for either: a bearer-authenticated server arrived
 * unauthenticated and missed its stored OAuth token (keyed on a hash that
 * includes the headers and the type), and an `sse` url was silently connected to
 * as HTTP. Both are now carried verbatim, so both are accepted — `headers`
 * through the same `env:VAR` resolution as `env`, and `type` checked only for
 * agreeing with the declaration (`stdio` for a `command`, `http`/`sse` for a
 * `url`).
 */
function narrowDeclaration(
  name: string,
  raw: unknown,
  env: Record<string, string | undefined>,
): NarrowResult {
  const where = `mcpServers.${name}`;
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (msg: string): NarrowResult => ({
    errors: [...errors, `${msg} — not attached`],
    warnings,
  });

  if (!NAME_RE.test(name)) {
    return fail(
      `${where}: a server name may contain only letters, digits, \`_\` and \`-\` (its tools are ` +
        `named mcp__${name}__<tool>, and the allowlist pattern is built from that)`,
    );
  }
  if (RESERVED_MCP_SERVER_NAMES.includes(name)) {
    return fail(
      `${where}: "${name}" is reserved for a server paddock injects itself, and two servers ` +
        `cannot share the mcp__${name}__* namespace`,
    );
  }
  if (!isRecord(raw)) return fail(`${where}: is not a mapping`);

  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    return fail(
      `${where}: unrecognised key(s) ${unknown.join(", ")} ` +
        `(supported: command, args, env, url, type, headers) ` +
        `— a mistyped key would otherwise be dropped without a trace`,
    );
  }
  const hasCommand = typeof raw.command === "string" && raw.command.trim().length > 0;
  const hasUrl = typeof raw.url === "string" && raw.url.trim().length > 0;
  if (hasCommand && hasUrl) {
    return fail(
      `${where}: declares both a \`command\` and a \`url\`; a server is one or the other`,
    );
  }
  if (!hasCommand && !hasUrl) {
    return fail(
      `${where}: declares neither a \`command\` nor a \`url\`, so there is nothing to start`,
    );
  }

  const server: McpServerDef = {};

  if (raw.type !== undefined) {
    const type = String(raw.type).trim().toLowerCase();
    // `sse` joined `http` here in herdctl 5.32.0; an explicit type now wins over
    // the bare-`url` ⇒ `http` inference rather than being stripped on the way
    // down. It still has to agree with the rest of the declaration, because a
    // `type` that disagrees is a typo and starting the wrong transport is a
    // confusing failure rather than a loud one.
    const expected = hasUrl ? ["http", "sse"] : ["stdio"];
    if (!expected.includes(type)) {
      return fail(
        `${where}: \`type: ${type}\` disagrees with the declaration ` +
          `(expected ${expected.join(" or ")})`,
      );
    }
    server.type = type as McpServerDef["type"];
  }

  if (hasCommand) {
    const res = resolveLeaf((raw.command as string).trim(), env, `${where}.command`);
    if (!res.ok) return { errors, warnings: [...warnings, `${res.error} — server not attached`] };
    server.command = res.value;
  }
  if (hasUrl) {
    const res = resolveLeaf((raw.url as string).trim(), env, `${where}.url`);
    if (!res.ok) return { errors, warnings: [...warnings, `${res.error} — server not attached`] };
    server.url = res.value;
    // A key in the query string is the usual way a remote MCP endpoint is
    // authenticated now that `headers` cannot be carried, and this file is
    // git-tracked. Say so once; never echo the query itself.
    if (!(raw.url as string).startsWith(ENV_REF_PREFIX)) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(server.url);
      } catch {
        /* an unparseable url is the engine's problem, not a secrets one */
      }
      if (parsed && (parsed.search || parsed.username || parsed.password)) {
        warnings.push(
          `${where}.url: carries a query string or userinfo, which is where an API key usually ` +
            `rides. This file is git-tracked — prefer \`url: ${ENV_REF_PREFIX}VAR_NAME\` and ` +
            `keep the value in the environment`,
        );
      }
    }
  }

  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) {
      return fail(`${where}.args: must be a list of strings`);
    }
    const args: string[] = [];
    for (const [i, arg] of (raw.args as string[]).entries()) {
      const res = resolveLeaf(arg, env, `${where}.args[${i}]`);
      if (!res.ok) return { errors, warnings: [...warnings, `${res.error} — server not attached`] };
      args.push(res.value);
    }
    if (args.length > 0) server.args = args;
  }

  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) return fail(`${where}.env: must be a mapping of NAME to value`);
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== "string") {
        return fail(
          `${where}.env.${key}: must be a string (values are passed to a process verbatim)`,
        );
      }
      const res = resolveLeaf(value, env, `${where}.env.${key}`);
      if (!res.ok) return { errors, warnings: [...warnings, `${res.error} — server not attached`] };
      resolved[key] = res.value;
      if (!value.startsWith(ENV_REF_PREFIX) && SECRET_ISH_KEY_RE.test(key)) {
        warnings.push(
          `${where}.env.${key}: looks like a credential and is written into the config file ` +
            `itself, which is git-tracked — prefer \`${key}: ${ENV_REF_PREFIX}VAR_NAME\` and set ` +
            `the value in the environment`,
        );
      }
    }
    if (Object.keys(resolved).length > 0) server.env = resolved;
  }

  if (raw.headers !== undefined) {
    if (!hasUrl) {
      return fail(`${where}.headers: only a \`url\` server can carry headers`);
    }
    if (!isRecord(raw.headers)) {
      return fail(`${where}.headers: must be a mapping of header name to value`);
    }
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value !== "string") {
        return fail(`${where}.headers.${key}: must be a string`);
      }
      const res = resolveLeaf(value, env, `${where}.headers.${key}`);
      if (!res.ok) return { errors, warnings: [...warnings, `${res.error} — server not attached`] };
      resolved[key] = res.value;
      // Same heuristic as `env`, one rule to learn — and `Authorization` is the
      // usual reason a header is declared at all, so this fires on the common
      // case rather than the exotic one.
      if (!value.startsWith(ENV_REF_PREFIX) && SECRET_ISH_KEY_RE.test(key)) {
        warnings.push(
          `${where}.headers.${key}: looks like a credential and is written into the config file ` +
            `itself, which is git-tracked — prefer \`${key}: ${ENV_REF_PREFIX}VAR_NAME\` and set ` +
            `the value in the environment`,
        );
      }
    }
    if (Object.keys(resolved).length > 0) server.headers = resolved;
  }

  return { server, errors, warnings };
}

/**
 * Resolve the whole `mcpServers:` block against `env`.
 *
 * Never throws. A declaration paddock cannot carry is reported and dropped so one
 * typo cannot take an instance down — the same posture as
 * `resolveManagementApiConfig`, and for the same reason: this is a capability,
 * and losing a capability is better than losing the instance.
 */
export function resolveDeclaredMcpServers(
  file: McpServersConfigFile | undefined,
  env: Record<string, string | undefined>,
): DeclaredMcpResolution {
  const servers: McpServerDefs = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  if (file === undefined || file === null) return { servers, errors, warnings };
  if (!isRecord(file)) {
    errors.push("mcpServers: must be a mapping of server name to declaration — ignored");
    return { servers, errors, warnings };
  }

  for (const [rawName, decl] of Object.entries(file)) {
    const name = rawName.trim();
    if (name.length === 0) {
      errors.push("mcpServers: a server name is empty — not attached");
      continue;
    }
    const res = narrowDeclaration(name, decl, env);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
    if (res.server) servers[name] = res.server;
  }
  return { servers, errors, warnings };
}

/**
 * The one way a declared credential leaves paddock, said out loud.
 *
 * Everything else in this module is about keeping a resolved value out of the
 * places paddock controls — the log, an error, the Settings API. It does that
 * completely, and it is still not the whole story, because of what herdctl does
 * with the record afterwards:
 *
 * ```js
 * // @herdctl/core, runner/runtime/cli-runtime.js
 * const mcpServers = transformMcpServers(options.agent.mcp_servers);
 * const mcpConfig = JSON.stringify({ mcpServers });
 * args.push("--mcp-config", mcpConfig);      // ← env values and all
 * ```
 *
 * A process ARGUMENT is not private on Linux: `/proc/<pid>/cmdline` is
 * world-readable by default (no `hidepid`), and `ps` prints it. So on the CLI
 * runtime every declared server's `env` — the API token included — is legible to
 * any local user for the lifetime of each `claude` invocation. Observed, not
 * inferred: `test/integration/declared-mcp-argv.test.ts` drives a real turn and
 * reads the token back out of the spawned process's argv.
 *
 * The SDK runtime does NOT do this. It hands the same record to the SDK
 * in-process, and the stdio server it spawns receives the value in its
 * environment, where `/proc/<pid>/environ` is owner-only — which is exactly what
 * Claude Code itself does, so it is not a regression to fix here.
 *
 * Which runtime runs is `driveMode`: `session` (the default) is the SDK,
 * `batch` is the CLI. Hence a WARNING on an instance that is on `batch`, and an
 * informational note otherwise — because a single project can pin `driveMode:
 * batch` for itself and bring the exposure back with it.
 *
 * Paddock cannot close this from here: the fix is upstream (the Claude CLI's
 * `--mcp-config` also accepts a file path, which is not readable from another
 * process's argv). Refusing to attach the server instead would break the feature
 * for the deployments most likely to need it, so what this does is refuse to be
 * silent — the same posture step 5 takes towards the fields the engine's schema
 * cannot carry.
 */
function argvExposure(names: readonly string[], driveMode: DriveMode): DeclaredMcpNotice {
  const batch = driveMode === "batch";
  return {
    level: batch ? "warn" : "info",
    message:
      `${names.join(", ")} ${names.length === 1 ? "declares" : "declare"} \`env\` values, and ` +
      `under \`driveMode: batch\` the engine passes the whole server definition to \`claude\` ` +
      `as a \`--mcp-config\` COMMAND-LINE argument — where any local process can read it via ` +
      `/proc/<pid>/cmdline. ` +
      (batch
        ? `This instance is on \`driveMode: batch\`, so that applies to every turn. Prefer ` +
          `\`driveMode: session\` (the default) for a server that holds a credential.`
        : `This instance is on \`driveMode: session\`, which passes them in-process instead — ` +
          `but a project that pins \`driveMode: batch\` brings the exposure back.`),
  };
}

/** A line for the boot log, at a level (mirrors `HostMcpNotice`). */
export interface DeclaredMcpNotice {
  level: "info" | "warn";
  message: string;
}

/**
 * What to say at boot about the declared servers — the answer to "what does this
 * instance actually have?", which should be readable off the log rather than
 * inferred from a YAML file plus an environment.
 *
 * Takes the already-resolved servers, so it cannot see a raw declaration and
 * therefore cannot leak one; every line it produces goes through
 * {@link describeServer}.
 */
export function declaredMcpNotices(opts: {
  servers: McpServerDefs;
  /** Names inherited from `~/.claude.json`, for the shadowing notice. */
  hostNames?: readonly string[];
  /** Whether paddock's own browser server is attached (it wins a name clash). */
  browserMcp?: boolean;
  /**
   * The instance's drive mode, which decides whether a declared `env` value ends
   * up on a command line. Omitted ⇒ say nothing (the several callers that only
   * want the inventory line).
   */
  driveMode?: DriveMode;
}): DeclaredMcpNotice[] {
  const names = Object.keys(opts.servers);
  if (names.length === 0) return [];
  const notices: DeclaredMcpNotice[] = [
    {
      level: "info",
      message:
        `MCP servers declared by this instance (\`mcpServers:\`): ` +
        `${names.map((n) => describeServer(n, opts.servers[n])).join("; ")}. ` +
        `Every project's keeper gets all of them.`,
    },
  ];
  const shadowed = names.filter((n) => opts.hostNames?.includes(n));
  if (shadowed.length > 0) {
    notices.push({
      level: "info",
      message:
        `${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} also declared in your ` +
        `~/.claude.json (\`claude.mcpServers: host\`); this instance's own declaration wins.`,
    });
  }
  const exposed = names.filter((n) => Object.keys(opts.servers[n].env ?? {}).length > 0);
  if (exposed.length > 0 && opts.driveMode !== undefined) {
    // The one place a declared credential escapes paddock, and it escapes
    // downstream of every rule this module enforces — see {@link argvExposure}.
    notices.push(argvExposure(exposed, opts.driveMode));
  }
  if (opts.browserMcp && names.includes("playwright")) {
    notices.push({
      level: "warn",
      message:
        `mcpServers.playwright collides with paddock's own browser server, which WINS — your ` +
        `declaration is not attached. Set \`browserMcp: false\` to use yours instead.`,
    });
  }
  return notices;
}
