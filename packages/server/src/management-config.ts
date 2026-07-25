/**
 * `managementApi.clients` config resolution (issue #312 M1).
 *
 * Turns the optional `managementApi` block of `paddock.config.yaml` into the
 * resolved list of external clients the token authenticator will accept, each
 * carrying its {@link ManagementScope}. Pure over an injected environment map so
 * the whole validation matrix is unit-testable without touching `process.env`.
 *
 * ── Why token material is REFERENCED, never inlined ─────────────────────────
 * `paddock.config.yaml` is git-tracked (and editable from the instance Settings
 * screen, #385). A secret written there leaks into history the moment it is
 * committed, and no later edit removes it. So a client's credential is given as
 * an env REFERENCE (`ref: env:PADDOCK_MCP_TOKEN_MY_LAPTOP`) and an inline value
 * is a hard config error — not a warning — because accepting one silently would
 * teach operators the unsafe habit.
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 * Two different kinds of problem, handled differently on purpose:
 *   - **Malformed config** (inline secret, unknown auth type, bad scope shape)
 *     is an ERROR. The operator wrote something meaningless; surface it.
 *   - **An unresolvable reference** (env var unset/blank/too short) DROPS THAT
 *     CLIENT with a loud warning, leaving other clients working. Dropping is the
 *     fail-closed direction: the credential simply doesn't exist, so nothing can
 *     authenticate as that client. If every client drops, `/mcp` reverts to its
 *     unconfigured 404 — the endpoint ceases to exist rather than opening up.
 */
import {
  DEFAULT_READ_ONLY_SCOPE,
  grantsCodeExecution,
  type ManagementScope,
} from "./management-policy.js";

/**
 * Recommended token prefix. A prefixed token additionally carries the INSTANCE
 * it was minted for (`pdk_<instanceId>_<secret>`), which is what makes a
 * credential for instance A meaningless at instance B — see
 * {@link tokenInstanceId}. Also gives secret scanners something to match on.
 */
export const TOKEN_PREFIX = "pdk_";

/**
 * Minimum accepted token length. Not a strength guarantee — just a floor that
 * rejects obvious placeholders ("changeme", "test") before they can ever
 * authenticate a turn-spawning client.
 */
export const MIN_TOKEN_LENGTH = 24;

/** One resolved external client: an identity, a credential, and a scope. */
export interface ManagementClient {
  /** The `managementApi.clients` map key — the stable, loggable identity. */
  clientId: string;
  /** The resolved secret. NEVER logged, never echoed in an API response. */
  token: string;
  scope: ManagementScope;
}

/** The resolved management-API config. */
export interface ManagementApiConfig {
  /**
   * Resolved external clients. EMPTY means the external management API is off
   * entirely and `/mcp` must 404 (fail closed) — see routes/mcp.ts.
   */
  clients: ManagementClient[];
  /**
   * This instance's identifier, used to bind prefixed tokens to it. Absent ⇒
   * binding is not enforced (an unprefixed-token deployment still works).
   */
  instanceId?: string;
  /**
   * The canonical PUBLIC origin clients reach this instance at, with no trailing
   * slash (e.g. `https://paddock.example.com`).
   *
   * Required whenever clients are configured, because RFC 9728 §3.3 makes the
   * `resource` value in the protected-resource metadata document a byte-for-byte
   * match against the URL the client used — a mismatch means the client MUST
   * discard the document. It cannot be derived from `Host`: behind a
   * TLS-terminating proxy the scheme is wrong, and the header is
   * attacker-controlled. So the operator states it once, here.
   */
  publicUrl?: string;
}

/** On-disk shape of the `managementApi` block. Every field optional. */
export interface ManagementApiConfigFile {
  instanceId?: string;
  publicUrl?: string;
  clients?: Record<string, ManagementClientConfigFile | null | undefined>;
}

/**
 * Validate the canonical public URL. Returns the normalised origin (no trailing
 * slash) or an error string.
 *
 * Rejects plaintext for anything but loopback: `/mcp` carries bearer tokens, so
 * advertising an `http://` origin to the world would publish a URL on which the
 * credential is readable in transit. This is the config-time half of the epic's
 * "refuse to serve `/mcp` over plaintext" rule (routes/mcp.ts enforces the
 * per-request half).
 */
export function validatePublicUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { error: `must be an absolute URL (got "${raw}")` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: `must be an http(s) URL (got "${parsed.protocol}")` };
  }
  const host = parsed.hostname;
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "http:" && !isLoopback) {
    return {
      error:
        `must be https for a non-loopback host (got "${raw}") — the management API carries ` +
        `bearer tokens, so a plaintext public URL would expose them in transit`,
    };
  }
  if (parsed.search || parsed.hash) return { error: "must not carry a query string or fragment" };
  // Normalise to an origin + optional path, dropping any trailing slash so the
  // RFC 9728 byte-comparison has one canonical form to work from.
  const path = parsed.pathname.replace(/\/+$/, "");
  return { url: `${parsed.origin}${path}` };
}

export interface ManagementClientConfigFile {
  auth?: {
    type?: string;
    /** `env:VAR_NAME` — the ONLY supported form. An inline value is an error. */
    ref?: string;
    /** Present only in a MISCONFIGURED file; its presence is a hard error. */
    token?: string;
    secret?: string;
  };
  scope?: {
    projects?: string[] | string;
    allow?: string[] | string;
    deny?: string[] | string;
    denyProjects?: string[] | string;
    maxSpawnDepth?: number | string;
  };
}

/** Outcome of resolving the block: the clients plus everything worth telling the operator. */
export interface ManagementConfigResolution {
  config: ManagementApiConfig;
  /** Fatal-to-that-client misconfigurations (logged at error level). */
  errors: string[];
  /** Non-fatal advice + dropped-client notices (logged at warn level). */
  warnings: string[];
}

/** Normalize a YAML list field that may be a real array or a delimited string. */
function toList(raw: string[] | string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  const s = String(raw).trim();
  if (s.length === 0) return [];
  return s
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function toOptionalInt(raw: number | string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * The instance id embedded in a prefixed token (`pdk_<instanceId>_<secret>`), or
 * undefined for a token that carries none.
 *
 * This is the audience-binding hook the ticket asks for on day one: the
 * authenticator refuses a prefixed token whose embedded instance doesn't match
 * this instance, so copying a credential to a second Paddock does not make it
 * work there — even though the secret bytes are identical.
 */
export function tokenInstanceId(token: string): string | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const rest = token.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

/**
 * Resolve one client's scope, defaulting to READ-ONLY when the operator gave
 * none. The default is the security posture of the whole feature: a client
 * added without thinking about scope gets the risk class that cannot execute
 * code (see the RCE framing in management-policy.ts).
 */
export function resolveClientScope(file: ManagementClientConfigFile["scope"]): ManagementScope {
  if (!file) return { ...DEFAULT_READ_ONLY_SCOPE };
  const projects = toList(file.projects) ?? [...DEFAULT_READ_ONLY_SCOPE.projects];
  const allow = toList(file.allow) ?? [...DEFAULT_READ_ONLY_SCOPE.allow];
  const deny = toList(file.deny) ?? [];
  const denyProjects = toList(file.denyProjects);
  const maxSpawnDepth = toOptionalInt(file.maxSpawnDepth);
  return {
    projects,
    allow,
    deny,
    ...(denyProjects && denyProjects.length > 0 ? { denyProjects } : {}),
    ...(maxSpawnDepth !== undefined ? { maxSpawnDepth } : {}),
  };
}

/**
 * Resolve the `managementApi` block against `env`.
 *
 * Never throws: a bad client is reported and dropped so one typo can't take the
 * whole instance down (the browser UI and keepers are unaffected by management-
 * API config). The caller logs `errors`/`warnings` at boot.
 */
export function resolveManagementApiConfig(
  file: ManagementApiConfigFile | undefined,
  env: Record<string, string | undefined>,
): ManagementConfigResolution {
  const errors: string[] = [];
  const warnings: string[] = [];
  const clients: ManagementClient[] = [];

  const instanceId = file?.instanceId?.trim() || undefined;
  const entries = Object.entries(file?.clients ?? {});

  // Resolve the canonical public URL up front: it gates the whole surface, so a
  // bad or missing value must fail the feature closed rather than half-enable it.
  let publicUrl: string | undefined;
  const rawPublicUrl = file?.publicUrl?.trim();
  if (rawPublicUrl) {
    const checked = validatePublicUrl(rawPublicUrl);
    if ("error" in checked) {
      errors.push(`managementApi.publicUrl: ${checked.error} — the management API is disabled`);
      return { config: { clients: [], ...(instanceId ? { instanceId } : {}) }, errors, warnings };
    }
    publicUrl = checked.url;
  } else if (entries.length > 0) {
    // Required whenever clients exist. Enforced in M1 (before any client can be
    // configured) so that turning on M2's discovery is a no-op for the operator
    // rather than a breaking config change.
    errors.push(
      "managementApi.publicUrl: required when managementApi.clients is set (the canonical " +
        "public origin clients reach this instance at, e.g. https://paddock.example.com) — " +
        "the management API is disabled",
    );
    return { config: { clients: [], ...(instanceId ? { instanceId } : {}) }, errors, warnings };
  }

  for (const [rawId, raw] of entries) {
    const clientId = rawId.trim();
    if (clientId.length === 0) {
      errors.push("managementApi.clients: a client key is empty — skipped");
      continue;
    }
    const where = `managementApi.clients.${clientId}`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${where}: not a mapping — skipped`);
      continue;
    }
    const auth = raw.auth ?? {};

    // Hard error: a secret written INTO the git-tracked config file.
    if (auth.token !== undefined || auth.secret !== undefined) {
      errors.push(
        `${where}.auth: inline token material is not allowed (the config file is ` +
          `git-tracked). Use \`ref: env:VAR_NAME\` and set the value in the environment — skipped`,
      );
      continue;
    }

    const type = (auth.type ?? "token").trim();
    if (type !== "token") {
      errors.push(`${where}.auth.type: unsupported type "${type}" (M1 supports "token") — skipped`);
      continue;
    }

    const ref = auth.ref?.trim();
    if (!ref) {
      errors.push(`${where}.auth.ref: required (e.g. \`env:PADDOCK_MCP_TOKEN_${clientId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}\`) — skipped`);
      continue;
    }
    if (!ref.startsWith("env:")) {
      errors.push(`${where}.auth.ref: must be an \`env:VAR_NAME\` reference (got "${ref}") — skipped`);
      continue;
    }
    const varName = ref.slice("env:".length).trim();
    if (varName.length === 0) {
      errors.push(`${where}.auth.ref: names no environment variable — skipped`);
      continue;
    }

    const token = env[varName]?.trim();
    if (!token) {
      // Fail-closed drop, not a boot failure: the credential doesn't exist, so
      // nothing can authenticate as this client.
      warnings.push(
        `${where}: environment variable ${varName} is unset or empty — client disabled`,
      );
      continue;
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      warnings.push(
        `${where}: token from ${varName} is shorter than ${MIN_TOKEN_LENGTH} characters — client disabled`,
      );
      continue;
    }

    // Instance binding advice (enforcement happens in the authenticator).
    const embedded = tokenInstanceId(token);
    if (embedded === undefined) {
      warnings.push(
        `${where}: token from ${varName} has no \`${TOKEN_PREFIX}<instanceId>_\` prefix, so it is ` +
          `NOT bound to this instance — the same value would authenticate at any Paddock that ` +
          `configures it. Prefer a prefixed token.`,
      );
    } else if (instanceId && embedded !== instanceId) {
      warnings.push(
        `${where}: token from ${varName} is bound to instance "${embedded}" but this instance is ` +
          `"${instanceId}" — it will be REJECTED at authentication. Check which instance minted it.`,
      );
    } else if (!instanceId) {
      warnings.push(
        `${where}: token from ${varName} is bound to instance "${embedded}" but ` +
          `managementApi.instanceId is not set, so the binding cannot be enforced.`,
      );
    }

    const scope = resolveClientScope(raw.scope);
    if (grantsCodeExecution(scope)) {
      // Deliberately loud: this grant is code execution on the host.
      warnings.push(
        `${where}: scope grants code-execution operations — this client can run code on this host ` +
          `(a spawned keeper has a shell; create_project clones a caller-supplied URL). Ensure its ` +
          `token is treated as a production secret.`,
      );
    }

    clients.push({ clientId, token, scope });
  }

  return {
    config: {
      clients,
      ...(instanceId ? { instanceId } : {}),
      ...(publicUrl ? { publicUrl } : {}),
    },
    errors,
    warnings,
  };
}
