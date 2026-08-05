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
 * credential, and nothing in this module ever prints a value. Every diagnostic
 * names keys, variable names and server names only; a `url` is reported with its
 * query string and userinfo stripped, because that is where an API key rides.
 * {@link describeServer} is the single place a server is rendered for a human,
 * so there is one function to audit rather than a scattering of template strings.
 *
 * The resolved values do land in the frozen `PaddockConfig` (as management tokens
 * already do). They must never reach an API response: `instance-config.ts`
 * publishes only the fields in its own `FIELDS` table, and this block is
 * deliberately absent from it.
 *
 * ## Validation is strict, and drops rather than degrades
 *
 * Step 5 passes a host server it cannot carry faithfully, with a warning, on the
 * grounds that a user who declared a server elsewhere should get it plus a
 * warning rather than nothing plus a warning. That reasoning inverts here,
 * because the user typed this file: an unusable declaration is a mistake they can
 * fix, and a `headers:` block that is silently dropped is an authentication
 * failure that looks like a broken server. So anything that cannot be carried is
 * an ERROR and that server is not attached — including an unknown key, which is
 * how a typo (`arg:` for `args:`) otherwise becomes a server that starts wrong.
 *
 * Never a boot failure, though: one bad server drops itself and the rest attach,
 * matching `resolveManagementApiConfig`. A typo in a capability must not take an
 * instance down.
 */
import type { McpServerDefs, McpServerDef } from "./claude-mcp.js";

/** On-disk shape of one entry of the `mcpServers:` block. Every field optional. */
export interface McpServerConfigFile {
  /** Executable for a stdio server. Mutually exclusive with {@link url}. */
  command?: string;
  /** Arguments for {@link command}. */
  args?: string[];
  /** Environment for the server process. Values may be `env:VAR_NAME`. */
  env?: Record<string, string>;
  /** Endpoint for a streamable-HTTP server. Mutually exclusive with {@link command}. */
  url?: string;
  /** Accepted only as `stdio`/`http`, and only when it agrees with the above. */
  type?: string;
  /** Present only in a MISCONFIGURED file: the engine cannot carry headers. */
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
  if (def.url) parts.push(`http: ${redactUrl(def.url)}`);
  if (def.args?.length) parts.push(`${def.args.length} args`);
  const envCount = Object.keys(def.env ?? {}).length;
  if (envCount > 0) parts.push(`${envCount} env ${envCount === 1 ? "entry" : "entries"}`);
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
 * The rejections are the interesting part, and each is a thing step 5 discovered
 * the engine strips silently:
 *
 * - **`headers`** — there is no field for them, so a bearer-authenticated server
 *   would arrive unauthenticated AND miss its stored OAuth token, which is keyed
 *   on a hash that includes the headers. Step 5 passes such a host server with a
 *   warning; a hand-written declaration gets an error instead, because the user
 *   typed the header and can act on being told it does nothing.
 * - **`type: sse`** — every `url` is mapped to `type: "http"` downstream, so an
 *   sse server is silently downgraded, with the same OAuth-key consequence.
 * - **an unknown key** — the only defence against `arg:`/`envs:`/`commands:`,
 *   which would otherwise yield a server that starts with the wrong argv.
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
      `${where}: unrecognised key(s) ${unknown.join(", ")} (supported: command, args, env, url) ` +
        `— a mistyped key would otherwise be dropped without a trace`,
    );
  }
  if (raw.headers !== undefined) {
    const keys = isRecord(raw.headers) ? Object.keys(raw.headers) : [];
    return fail(
      `${where}: \`headers\`${keys.length > 0 ? ` (${keys.join(", ")})` : ""} cannot be ` +
        `carried — the engine's MCP schema has no field for them, so the server would arrive ` +
        `unauthenticated and its stored OAuth token (keyed on a hash that includes the headers) ` +
        `would not be found either`,
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

  if (raw.type !== undefined) {
    const type = String(raw.type).trim().toLowerCase();
    if (type === "sse") {
      return fail(
        `${where}: \`type: sse\` cannot be carried — every \`url\` server is connected to as ` +
          `streamable HTTP downstream, so an sse server would be silently downgraded (and its ` +
          `stored OAuth token, keyed on a hash that includes the type, not found). Declare it ` +
          `as \`http\` if the server supports it`,
      );
    }
    const expected = hasUrl ? "http" : "stdio";
    if (type !== expected) {
      return fail(
        `${where}: \`type: ${type}\` disagrees with the declaration (expected ${expected})`,
      );
    }
  }

  const server: McpServerDef = {};

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
