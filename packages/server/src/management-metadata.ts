/**
 * RFC 9728 protected-resource metadata (issue #312 M2).
 *
 * The document an MCP client fetches to learn HOW to authenticate against
 * `/mcp`. Paddock publishes this itself: it is the resource server's job, and
 * IdPs do not emit it.
 *
 * ── Two things here are easy to get wrong ──────────────────────────────────
 *
 * 1. **`resource` must byte-match the URL the client used** (RFC 9728 §3.3) —
 *    a mismatch means the client MUST discard the document. So it is built from
 *    the operator-configured `publicUrl`, never from `req.headers.host`: behind
 *    a TLS-terminating proxy the scheme would be wrong, and the header is
 *    attacker-controlled anyway.
 *
 * 2. **The URL is path-INSERTED, not path-appended.** For a resource at
 *    `https://host/mcp` the metadata lives at
 *    `https://host/.well-known/oauth-protected-resource/mcp` — the well-known
 *    segment goes between the host and the resource path. A verified trace of a
 *    real Claude Code session showed it requests ONLY that form and never the
 *    bare root, so serving the root alone leaves discovery silently broken. We
 *    serve both and rely on the path-inserted one.
 */
import type { ManagementApiConfig } from "./management-config.js";
import { OAUTH_SCOPES_SUPPORTED } from "./management-policy.js";

/** The well-known prefix, per RFC 9728. */
export const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

/** The MCP resource path this instance serves. */
export const MCP_RESOURCE_PATH = "/mcp";

/** The RFC 9728 document. `authorization_servers` is optional in the RFC but MANDATORY per MCP. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation?: string;
}

/** The canonical resource identifier — what a client must byte-match. */
export function resourceIdentifier(cfg: ManagementApiConfig): string | undefined {
  return cfg.publicUrl ? `${cfg.publicUrl}${MCP_RESOURCE_PATH}` : undefined;
}

/**
 * The absolute, path-inserted metadata URL (what clients actually request), or
 * undefined when no document will be served — pointing a client at a URL that
 * 404s is worse than omitting the pointer, since `resource_metadata` is a
 * promise that discovery will work.
 */
export function metadataUrl(cfg: ManagementApiConfig): string | undefined {
  if (!cfg.publicUrl) return undefined;
  if (!cfg.authorizationServers || cfg.authorizationServers.length === 0) return undefined;
  return `${cfg.publicUrl}${PROTECTED_RESOURCE_METADATA_PREFIX}${MCP_RESOURCE_PATH}`;
}

/**
 * Build the metadata document, or undefined when it cannot be built COMPLETELY.
 *
 * Requires an authorization server. RFC 9728 makes `authorization_servers`
 * optional, but the MCP spec makes it mandatory ("MUST include the
 * `authorization_servers` field containing at least one authorization server"),
 * and a token-only deployment has none — so rather than publish a document the
 * governing spec calls invalid, we publish nothing.
 *
 * This is not theoretical. A discovery trace of a real Claude Code session
 * against an earlier build that served the document WITHOUT
 * `authorization_servers` showed the client fetch it, find no authorization
 * server, and then go hunting: `/.well-known/oauth-authorization-server`, then
 * `/.well-known/openid-configuration`, both 404. Publishing nothing produces the
 * same end state (an OAuth-only client cannot connect without OAuth configured)
 * without the misleading intermediate step.
 *
 * Nothing is lost for the supported path: a client holding a static bearer token
 * never performs discovery at all.
 */
export function buildProtectedResourceMetadata(
  cfg: ManagementApiConfig,
): ProtectedResourceMetadata | undefined {
  const resource = resourceIdentifier(cfg);
  if (!resource) return undefined;
  if (!cfg.authorizationServers || cfg.authorizationServers.length === 0) return undefined;
  return {
    resource,
    authorization_servers: [...cfg.authorizationServers],
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    bearer_methods_supported: ["header"],
    resource_name: "Paddock Management API",
  };
}
