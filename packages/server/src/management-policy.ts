/**
 * Management API policy primitives (issue #312 M1).
 *
 * The `ManagementPrincipal` (WHO is calling) + `ManagementScope` (WHAT they may
 * reach) and the pure predicates that decide a single call. This module is
 * deliberately transport-free and dependency-free: it knows nothing about MCP,
 * HTTP, Fastify or the ops callbacks. Everything here is a pure function over
 * plain data, so the security-critical decisions are unit-testable without a
 * fleet, a socket, or a server.
 *
 * ── Why policy lives HERE and not in the MCP transport ──────────────────────
 * The ticket's central structural decision: enforcement happens at the OPS
 * layer, not in whichever transport happens to be calling. Paddock will grow a
 * REST surface for the same turn-spawning operations (#465); if policy lived in
 * the MCP handler, REST would have to reimplement it and the two would drift.
 * So the transports authenticate (producing a principal) and the ops layer
 * enforces (consuming one) — see management-ops.ts.
 *
 * ── The blast-radius framing that drives the defaults ───────────────────────
 * `create_chat` / `send_message` / `fork_chat*` / `run_trigger` START KEEPER
 * TURNS, and a keeper runs with Bash + Write. So **any write scope is
 * effectively remote code execution on the host.** Read-only is therefore the
 * default for a configured client, writes are opt-in per client, and the
 * grammar below is deny-biased at every ambiguity: deny beats allow, an unknown
 * operation is denied, and an empty allow-list grants nothing.
 */

/** How a principal proved its identity. Transports set this; policy ignores it. */
export type ManagementCredentialKind = "internal" | "token" | "oauth";

/**
 * What a principal may reach. Both dimensions are independently constrained:
 * WHICH operations (`allow`/`deny`) and WHICH projects (`projects`/
 * `denyProjects`). A call must satisfy both.
 */
export interface ManagementScope {
  /**
   * Project slugs this principal may touch. `["*"]` = every project. Matching
   * is exact-or-`*` (see {@link matchesPattern}); an empty list reaches nothing.
   */
  projects: string[];
  /**
   * Operation names this principal may invoke. Supports a trailing `*` wildcard
   * (`"list_*"`) and the bare `"*"`. Empty grants nothing.
   */
  allow: string[];
  /** Operation names explicitly refused. Deny ALWAYS beats allow. */
  deny: string[];
  /** Project slugs explicitly refused. Deny ALWAYS beats allow. */
  denyProjects?: string[];
  /**
   * Recursion bound applied to turns this principal spawns. Absent ⇒ the
   * instance/project default resolves as it does for an internal caller.
   */
  maxSpawnDepth?: number;
}

/** The authenticated caller of a management operation. */
export interface ManagementPrincipal {
  /**
   * Stable per-client identity — the `managementApi.clients` key for an external
   * caller, or `"internal"` for the in-process keeper path. This is what gets
   * LOGGED and stamped as provenance; the credential itself never is.
   */
  clientId: string;
  kind: ManagementCredentialKind;
  scope: ManagementScope;
}

// ── The operation catalogue ────────────────────────────────────────────────
// The canonical names policy is written against. These deliberately match the
// self-MCP tool names one-for-one, so an operator writing `allow: ["read_chat"]`
// names the same thing the agent sees as `mcp__paddock_manage__read_chat`, and
// so a future REST route can reuse the identifier unchanged.

/** Read-only operations: no state change, no turn started. */
export const READ_OPERATIONS = ["list_projects", "list_chats", "read_chat"] as const;

/** Chat write operations. The first four START TURNS (see the RCE note above). */
export const WRITE_OPERATIONS = [
  "create_project",
  "promote_project",
  "create_chat",
  "fork_chat",
  "send_message",
  "fork_chat_batch",
  "archive_chat",
  "unarchive_chat",
] as const;

/** Unified trigger operations (Epic T / T3). `list_triggers` is the read one. */
export const TRIGGER_OPERATIONS = [
  "list_triggers",
  "set_trigger",
  "remove_trigger",
  "run_trigger",
] as const;

/** Every operation the management surface knows about. */
export const ALL_OPERATIONS: readonly string[] = [
  ...READ_OPERATIONS,
  ...WRITE_OPERATIONS,
  ...TRIGGER_OPERATIONS,
];

/**
 * Operations that cause a keeper turn to run — directly (`create_chat`,
 * `send_message`, `fork_chat*`, `run_trigger`) or by arming something that will
 * (`set_trigger`). Granting ANY of these to a principal is granting code
 * execution on the host; kept as an explicit set so that fact stays greppable
 * and so docs/UI can warn on it.
 */
/**
 * Operations that grant code execution on the host, and so define the risk class
 * a write scope really is. A superset of {@link TURN_SPAWNING_OPERATIONS}:
 * `create_project`/`promote_project` start no turn, but they clone a
 * CALLER-SUPPLIED git URL and create (or restructure) instance-level state, which
 * belongs in the same warning.
 */
export const HIGH_RISK_OPERATIONS: readonly string[] = [
  "create_project",
  "promote_project",
  "create_chat",
  "fork_chat",
  "fork_chat_batch",
  "send_message",
  "run_trigger",
  "set_trigger",
];

export const TURN_SPAWNING_OPERATIONS: readonly string[] = [
  "create_chat",
  "fork_chat",
  "send_message",
  "fork_chat_batch",
  "run_trigger",
  "set_trigger",
];

/**
 * The DEFAULT scope for a configured client that specifies none — read-only
 * across all projects. Matches the shape written on issue #312 verbatim
 * (`allow: ["list_*", "read_chat"]`), which covers the three read tools plus
 * `list_triggers` while excluding every mutating verb.
 */
export const DEFAULT_READ_ONLY_SCOPE: ManagementScope = Object.freeze({
  projects: ["*"],
  allow: ["list_*", "read_chat"],
  deny: [],
}) as ManagementScope;

/** Unrestricted scope — used ONLY for the in-process keeper principal. */
export const FULL_SCOPE: ManagementScope = Object.freeze({
  projects: ["*"],
  allow: ["*"],
  deny: [],
}) as ManagementScope;

/**
 * The implicit full-trust principal for the in-process keeper path.
 *
 * The internal caller is bounded by DEPTH (`maxSpawnDepth`, shipped in #278),
 * not by auth+scope — it has no credential because it isn't a distinct identity.
 * Handing it a full scope keeps a single enforcement path (every op checks a
 * principal) while guaranteeing the keeper behaviour is byte-for-byte unchanged:
 * every check below short-circuits to allow.
 */
export const INTERNAL_PRINCIPAL: ManagementPrincipal = Object.freeze({
  clientId: "internal",
  kind: "internal",
  scope: FULL_SCOPE,
}) as ManagementPrincipal;

/** True for the implicit in-process principal (bounded by depth, not scope). */
export function isInternalPrincipal(principal: ManagementPrincipal): boolean {
  return principal.kind === "internal";
}

/**
 * Match one pattern against one value. Supports exactly two forms — a bare `"*"`
 * (everything) and a trailing-`*` prefix (`"list_*"`) — plus exact equality.
 *
 * Deliberately NOT a general glob: a security predicate should be trivially
 * auditable by the operator writing it, and the ticket calls for starting with
 * explicit lists and adding globs only as needed. Anything fancier (`?`, `[]`,
 * embedded `*`) is treated as a literal, so a typo'd pattern fails CLOSED
 * (matches nothing) rather than accidentally widening a grant.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*") && !pattern.slice(0, -1).includes("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

function matchesAny(patterns: readonly string[] | undefined, value: string): boolean {
  return (patterns ?? []).some((p) => matchesPattern(p, value));
}

/**
 * Whether `scope` permits invoking `operation`. Deny beats allow; an operation
 * outside {@link ALL_OPERATIONS} is refused regardless of the allow-list, so a
 * typo in config (or a tool added later that policy hasn't been taught about)
 * can never be reached through a stale `"*"` grant.
 */
export function isOperationAllowed(scope: ManagementScope, operation: string): boolean {
  if (!ALL_OPERATIONS.includes(operation)) return false;
  if (matchesAny(scope.deny, operation)) return false;
  return matchesAny(scope.allow, operation);
}

/** Whether `scope` permits touching `projectSlug`. Deny beats allow. */
export function isProjectAllowed(scope: ManagementScope, projectSlug: string): boolean {
  if (matchesAny(scope.denyProjects, projectSlug)) return false;
  return matchesAny(scope.projects, projectSlug);
}

/** The concrete operations `scope` grants, in catalogue order. */
export function allowedOperations(scope: ManagementScope): string[] {
  return ALL_OPERATIONS.filter((op) => isOperationAllowed(scope, op));
}

/** True when `scope` grants at least one operation that starts a keeper turn. */
export function grantsTurnSpawning(scope: ManagementScope): boolean {
  return TURN_SPAWNING_OPERATIONS.some((op) => isOperationAllowed(scope, op));
}

// ── OAuth scope vocabulary ─────────────────────────────────────────────────
// Two DIFFERENT granularities, deliberately:
//
//   - Internally, a scope is a list of OPERATION names. That is the right
//     granularity for an operator writing a config file, who wants to say
//     exactly which verbs a CI token may call.
//   - Over OAuth, scopes are coarse (`paddock:read` / `paddock:write`), because
//     they are shown to a HUMAN on a consent screen. "Grant this app
//     create_chat, fork_chat, fork_chat_batch, send_message…" is not a consent
//     prompt anyone reads; "grant write access" is.
//
// So the coarse names are a projection of the fine-grained truth, used only in
// the `scope` parameter of a challenge and in the discovery document. Authorization
// is always decided on the fine-grained list.

export const OAUTH_SCOPE_READ = "paddock:read";
export const OAUTH_SCOPE_WRITE = "paddock:write";

/** Every OAuth scope this resource server understands (for discovery). */
export const OAUTH_SCOPES_SUPPORTED: readonly string[] = [OAUTH_SCOPE_READ, OAUTH_SCOPE_WRITE];

/**
 * The coarse OAuth scope an operation needs. Anything that mutates state or
 * starts a turn is `write`; everything else is `read`.
 */
export function requiredOauthScope(operation: string): string {
  if (READ_OPERATIONS.includes(operation as (typeof READ_OPERATIONS)[number])) {
    return OAUTH_SCOPE_READ;
  }
  return operation === "list_triggers" ? OAUTH_SCOPE_READ : OAUTH_SCOPE_WRITE;
}

/** The coarse OAuth scopes a fine-grained scope amounts to. */
export function oauthScopesFor(scope: ManagementScope): string[] {
  const out: string[] = [];
  if (ALL_OPERATIONS.some((op) => isOperationAllowed(scope, op) && requiredOauthScope(op) === OAUTH_SCOPE_READ)) {
    out.push(OAUTH_SCOPE_READ);
  }
  if (ALL_OPERATIONS.some((op) => isOperationAllowed(scope, op) && requiredOauthScope(op) === OAUTH_SCOPE_WRITE)) {
    out.push(OAUTH_SCOPE_WRITE);
  }
  return out;
}

/** True when `scope` grants any operation that amounts to code execution. */
export function grantsCodeExecution(scope: ManagementScope): boolean {
  return HIGH_RISK_OPERATIONS.some((op) => isOperationAllowed(scope, op));
}

/**
 * Thrown when policy refuses a call. Carries the structured facts a transport
 * needs to render its own error (MCP `isError` text, or an HTTP 403) and that
 * the server log wants — `clientId` + `operation`, never the credential.
 */
export class ManagementDeniedError extends Error {
  readonly code: "operation_denied" | "project_denied";
  readonly clientId: string;
  readonly operation: string;
  readonly projectSlug?: string;

  constructor(args: {
    code: "operation_denied" | "project_denied";
    clientId: string;
    operation: string;
    projectSlug?: string;
  }) {
    super(
      args.code === "operation_denied"
        ? `not permitted: operation "${args.operation}" is outside this client's scope`
        : `not permitted: project "${args.projectSlug}" is outside this client's scope`,
    );
    this.name = "ManagementDeniedError";
    this.code = args.code;
    this.clientId = args.clientId;
    this.operation = args.operation;
    this.projectSlug = args.projectSlug;
  }
}

/** Throw unless `principal` may invoke `operation`. */
export function assertOperation(principal: ManagementPrincipal, operation: string): void {
  if (!isOperationAllowed(principal.scope, operation)) {
    throw new ManagementDeniedError({
      code: "operation_denied",
      clientId: principal.clientId,
      operation,
    });
  }
}

/**
 * Throw unless `principal` may reach `projectSlug` via `operation`. Callers that
 * ENUMERATE (list_projects/list_chats) must filter with {@link isProjectAllowed}
 * instead — a scoped client listing its two projects should see those two, not a
 * denial. This assert is for calls that name a target explicitly.
 */
export function assertProject(
  principal: ManagementPrincipal,
  operation: string,
  projectSlug: string,
): void {
  if (!isProjectAllowed(principal.scope, projectSlug)) {
    throw new ManagementDeniedError({
      code: "project_denied",
      clientId: principal.clientId,
      operation,
      projectSlug,
    });
  }
}
