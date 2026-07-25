/**
 * Management API authentication (issue #312 M1) — the config-token authenticator.
 *
 * Turns a presented credential into a {@link ManagementPrincipal}, or refuses.
 * Transport-agnostic: it takes a header value and returns a verdict, so the
 * `/mcp` route, a future REST surface (#465), and tests all share one path.
 *
 * ── This is INDEPENDENT of `PADDOCK_AUTH_MODE` and of any reverse proxy ─────
 * The non-negotiable invariant on the ticket: Paddock authenticates the
 * management surface ITSELF. It must be possible to run with no proxy at all —
 * even `auth.mode: none` — and still have a correctly authenticated `/mcp`. A
 * proxy is an operator's choice, never a prerequisite. Consequently `/mcp` is
 * exempted from the browser auth hook (auth.ts) and gated by THIS instead; the
 * exemption is safe only because this runs in its place.
 *
 * ── Why 401 + WWW-Authenticate, never a 302 ────────────────────────────────
 * An SSO proxy answers an unauthenticated request with an HTML login redirect.
 * That breaks MCP clients outright: they cannot follow it, and OAuth discovery
 * (M2) depends on reading a real `401` + `WWW-Authenticate` challenge. So this
 * module owns the challenge header and always fails with a status an MCP client
 * can act on.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { ManagementApiConfig, ManagementClient } from "./management-config.js";
import { tokenInstanceId } from "./management-config.js";
// `ManagementDeniedError` is referenced only as a TYPE here (denialResponse
// annotates its parameter and reads fields off it); the class is constructed by
// the ops layer, so a type-only import is enough and keeps this module's runtime
// dependencies to none.
import type { ManagementPrincipal, ManagementDeniedError } from "./management-policy.js";

/** Why a credential was refused. Shapes the challenge; never leaks the secret. */
export type ManagementAuthFailure =
  /** No credential presented at all. */
  | "missing"
  /** An `Authorization` header we could not parse as a bearer token. */
  | "malformed"
  /** Parsed fine, but matched no configured client (or failed instance binding). */
  | "invalid";

export type ManagementAuthResult =
  | { ok: true; principal: ManagementPrincipal }
  | { ok: false; failure: ManagementAuthFailure };

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * `timingSafeEqual` requires equal-length buffers and throws otherwise — which
 * would itself leak length. Hashing both sides to a fixed-width digest first
 * makes the comparison length-independent as well as time-independent.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Extract a bearer token from an `Authorization` header value.
 * Returns undefined when absent, and null when present but not a bearer token
 * (so the caller can distinguish "missing" from "malformed").
 */
export function bearerToken(headerValue: string | string[] | undefined): string | null | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const m = /^Bearer[ \t]+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Match a presented token against the configured clients.
 *
 * Scans EVERY client without early-exit so total work does not depend on which
 * client matched (or on how far down the list a match sits). Instance binding is
 * checked first: a token carrying an instance id that isn't ours is refused even
 * if its secret would otherwise match, which is what makes a credential minted
 * for another Paddock useless here.
 */
export function resolveTokenPrincipal(
  token: string,
  cfg: ManagementApiConfig,
): ManagementPrincipal | null {
  const embedded = tokenInstanceId(token);
  // A prefixed token names its instance; enforce it when we know our own.
  if (embedded !== undefined && cfg.instanceId !== undefined && embedded !== cfg.instanceId) {
    return null;
  }
  let matched: ManagementClient | null = null;
  for (const client of cfg.clients) {
    if (constantTimeEqual(token, client.token)) matched = client;
  }
  if (!matched) return null;
  return { clientId: matched.clientId, kind: "token", scope: matched.scope };
}

/**
 * Authenticate a request's `Authorization` header against the configured
 * clients. The caller decides the HTTP shape (see {@link challengeHeader}).
 */
export function authenticateManagementRequest(
  authorization: string | string[] | undefined,
  cfg: ManagementApiConfig,
): ManagementAuthResult {
  const token = bearerToken(authorization);
  if (token === undefined) return { ok: false, failure: "missing" };
  if (token === null) return { ok: false, failure: "malformed" };
  const principal = resolveTokenPrincipal(token, cfg);
  if (!principal) return { ok: false, failure: "invalid" };
  return { ok: true, principal };
}

/**
 * Build the `WWW-Authenticate` challenge for a refusal (RFC 6750 §3).
 *
 * `resourceMetadataUrl` is the RFC 9728 protected-resource-metadata location.
 * M2 supplies it so an MCP client can discover how to obtain a token; M1 omits
 * it (there is no OAuth path yet) and the header still forms a valid challenge.
 */
export function challengeHeader(
  failure: ManagementAuthFailure,
  resourceMetadataUrl?: string,
): string {
  const params: string[] = ['realm="paddock"'];
  if (failure !== "missing") {
    params.push('error="invalid_token"');
    params.push(
      `error_description="${failure === "malformed" ? "malformed Authorization header" : "the access token is invalid"}"`,
    );
  }
  if (resourceMetadataUrl) params.push(`resource_metadata="${resourceMetadataUrl}"`);
  return `Bearer ${params.join(", ")}`;
}

/**
 * The challenge for an authenticated caller whose SCOPE doesn't cover what it
 * asked for (MCP spec revision 2025-11-25 / RFC 6750 §3.1).
 *
 * Deliberately distinct from the 401 above: the credential was valid, so
 * re-authenticating changes nothing — the caller needs a WIDER GRANT. The
 * transport pairs this with **403**, and the `scope` parameter names what was
 * required, which is what lets a client ask for incremental consent instead of
 * failing opaquely.
 */
export function insufficientScopeChallenge(
  requiredScope: string,
  resourceMetadataUrl?: string,
): string {
  const params = [
    'realm="paddock"',
    'error="insufficient_scope"',
    `error_description="the authenticated client's scope does not permit this operation"`,
    `scope="${requiredScope}"`,
  ];
  if (resourceMetadataUrl) params.push(`resource_metadata="${resourceMetadataUrl}"`);
  return `Bearer ${params.join(", ")}`;
}

/**
 * The HTTP shape for a policy denial raised by the ops layer.
 *
 * Kept HERE, next to the other challenge builders, so that every transport maps
 * a `ManagementDeniedError` the same way instead of inventing its own status.
 * Both denial codes are scope problems, hence 403 rather than 401.
 */
export function denialResponse(
  error: ManagementDeniedError,
  resourceMetadataUrl?: string,
): { status: 403; challenge: string; body: { error: string; code: string; message: string } } {
  return {
    status: 403,
    challenge: insufficientScopeChallenge(
      error.code === "project_denied" ? `project:${error.projectSlug}` : error.operation,
      resourceMetadataUrl,
    ),
    body: { error: "forbidden", code: error.code, message: error.message },
  };
}

/**
 * The RFC 9728 protected-resource metadata URL for this instance's `/mcp`.
 *
 * The PATH-INSERTED form (`/.well-known/oauth-protected-resource/mcp`) — which
 * is what MCP clients actually request for a resource that has a path. Built
 * from the configured `publicUrl` rather than from request headers, because the
 * value must byte-match what the client used and `Host` is not trustworthy.
 */
export function resourceMetadataUrl(cfg: ManagementApiConfig): string | undefined {
  if (!cfg.publicUrl) return undefined;
  return `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * Whether the external management API is configured at all (drives the 404).
 *
 * Requires BOTH a client and a canonical public URL: without the latter, M2's
 * discovery document could not be served correctly, so the surface stays off
 * rather than half-working. `resolveManagementApiConfig` already empties the
 * client list when `publicUrl` is missing or bad; this is the belt to that
 * braces.
 */
export function isManagementApiEnabled(cfg: ManagementApiConfig | undefined): boolean {
  return (cfg?.clients.length ?? 0) > 0 && Boolean(cfg?.publicUrl);
}
