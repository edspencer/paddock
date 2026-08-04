/**
 * Provider-agnostic user authentication.
 *
 * Paddock has no login of its own — it is meant to sit behind a reverse proxy
 * that has already authenticated the user against an OIDC IdP (Authentik,
 * oauth2-proxy, Authelia, Cloudflare Access, Keycloak, …). This plugin turns
 * that upstream identity into a `req.user` that the rest of the app can read,
 * WITHOUT hardcoding any single provider. Behaviour is driven entirely by the
 * `PADDOCK_AUTH_*` env vars resolved into `cfg.auth` (see config.ts + AUTH.md).
 *
 * Three modes:
 *   - `none`            — no-op; every request is anonymous. Fully open (default).
 *   - `trusted-header`  — read identity from proxy-set header(s). 401 if absent.
 *                         Trust is network-level: only safe when the proxy is the
 *                         sole path to paddock (it can forge headers otherwise).
 *   - `jwt`             — verify a signed JWT (from a configured header) against a
 *                         remote JWKS using `jose`. Zero-trust / spoof-proof:
 *                         paddock holds no key material, only the JWKS URL, and
 *                         rejects missing/invalid/expired tokens with 401.
 *
 * Paddock's health route (`/api/health`) is always exempt so the proxy and
 * monitoring can poll a server that is otherwise locked down. Only registered
 * routes may be exempted — see HEALTH_PATHS below for why (issue #569).
 *
 * Registered in app.ts BEFORE the routes so the `onRequest` hook guards every
 * REST + WS request. The decorator + hook are added directly to the root app
 * instance (no fastify-plugin wrapper needed) so they apply app-wide. The hook
 * never throws past Fastify — auth failures are sent as a clean 401 JSON body
 * and logged via `req.log`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { AuthConfig } from "./config.js";

/** The authenticated (or anonymous) principal attached to every request. */
export interface AuthUser {
  /** Stable identifier for the user (username / sub / email, per config). */
  username: string;
  /** Email, when the provider supplies one. */
  email?: string;
  /** Group / role memberships, when supplied. */
  groups?: string[];
  /** True for the synthetic principal used in `none` mode (no real identity). */
  anonymous?: boolean;
}

// Augment Fastify's request with the resolved user. Importing this module (which
// app.ts does, via registerAuth) brings the declaration into scope app-wide.
declare module "fastify" {
  interface FastifyRequest {
    /**
     * The authenticated principal. Always present once the auth plugin has run:
     * a real user in trusted-header/jwt modes, or an anonymous principal in
     * `none` mode.
     */
    user: AuthUser;
  }
}

/**
 * Paths that must never require auth (proxy / monitoring health probes).
 *
 * **Every member must be a REGISTERED route** (see `routes/meta.ts`). Exempting a
 * path that no route serves does not make it 404 — it makes the SPA not-found
 * handler (`app.ts`) reachable *without a credential*, so the probe receives the
 * HTML app shell with a 200 and reads a locked-down or half-broken instance as
 * healthy. In the authenticated modes that inverts the truthful answer: an
 * unregistered path 401s honestly, but an exempted unregistered one reports 200.
 *
 * This set previously carried five conventional aliases (`/healthz`, `/-/health`,
 * `/health`, `/readyz`, `/livez`) that were never registered — issue #569.
 * `test/integration/auth-health-paths.test.ts` now asserts every member resolves
 * to a real route returning JSON, so the set cannot drift from the router again.
 */
export const HEALTH_PATHS: ReadonlySet<string> = new Set<string>([
  "/api/health", // paddock's own health route (routes/meta.ts)
]);

/**
 * Strip the query string and trailing slash so exemption matching is robust.
 *
 * Note the trailing-slash half only affects the AUTH decision, not routing: Fastify
 * is not configured with `ignoreTrailingSlash`, so `/api/health/` is exempt here yet
 * still matches no route and answers a JSON 404. That is deliberate — an honest loud
 * failure for a probe on the slashed form, never a false 200 (see #569).
 */
function normalizePath(url: string): string {
  const q = url.indexOf("?");
  let p = q === -1 ? url : url.slice(0, q);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

// Immutable front-end static assets (issue #223). These are the compiled web
// bundle — content-hashed JS/CSS/fonts under /assets, the /icons and /fonts sets,
// the service worker, and the PWA manifest. They carry no secrets and no per-user
// data. Serving them WITHOUT the JWT gate means a transient auth lapse (e.g. an
// Authentik session-refresh window, or the outpost briefly not injecting the
// header) no longer turns a chunk/asset fetch into a 401 → "Load failed" /
// "module script failed". The app shell (index.html / client routes) and every
// data route (/api, /ws) stay authenticated, so this exposes only the compiled,
// non-sensitive front-end — nothing an authenticated user's browser doesn't
// already download.
const STATIC_ASSET_PREFIXES = ["/assets/", "/icons/", "/fonts/"];
const STATIC_ASSET_FILES = new Set(["/sw.js", "/manifest.webmanifest", "/favicon.ico"]);

function isStaticAsset(pathname: string): boolean {
  if (STATIC_ASSET_FILES.has(pathname)) return true;
  return STATIC_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * The Management API surface (issue #312). Exempt from THIS hook because it
 * authenticates itself — see management-auth.ts — and because the browser modes
 * are actively wrong for it:
 *
 *  - `jwt` mode reads `Authorization`, which COLLIDES head-on with an MCP
 *    client's `Authorization: Bearer <management token>`;
 *  - an SSO proxy in front answers with an HTML login redirect, which no MCP
 *    client can follow and which breaks OAuth discovery (M2).
 *
 * This exemption is safe ONLY because `/mcp` runs its own authenticator and
 * fails closed (404 when unconfigured, 401 otherwise) — it is never open, not
 * even at `auth.mode: none`. Prefix-matched so M2's sub-paths inherit it.
 */
const MANAGEMENT_API_PREFIX = "/mcp";

/**
 * RFC 9728 protected-resource metadata (M2 discovery). Exempt for the same
 * reason: an MCP client fetches this BEFORE it holds any credential, so gating
 * it would make discovery impossible. The document is public by design — it
 * names the authorization server and supported scopes, never a secret.
 *
 * Matched as a PREFIX because the path-inserted form is what clients actually
 * request: for a resource at `/mcp` the metadata lives at
 * `/.well-known/oauth-protected-resource/mcp`, not at the bare root.
 */
const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

function isManagementApiPath(pathname: string): boolean {
  return (
    pathname === MANAGEMENT_API_PREFIX ||
    pathname.startsWith(`${MANAGEMENT_API_PREFIX}/`) ||
    pathname === PROTECTED_RESOURCE_METADATA_PREFIX ||
    pathname.startsWith(`${PROTECTED_RESOURCE_METADATA_PREFIX}/`)
  );
}

function isExempt(url: string): boolean {
  const p = normalizePath(url);
  return HEALTH_PATHS.has(p) || isStaticAsset(p) || isManagementApiPath(p);
}

const ANONYMOUS: AuthUser = Object.freeze({ username: "anonymous", anonymous: true });

/** First non-empty value for a header (Fastify gives string | string[] | undefined). */
function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  const raw = Array.isArray(v) ? v[0] : v;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Split a comma/space-delimited group header into a clean string[]. */
function splitGroups(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Resolve a username from JWT claims using the configured/fallback claim chain. */
function usernameFromClaims(payload: JWTPayload, cfg: AuthConfig): string | undefined {
  const pick = (key: string): string | undefined => {
    const v = payload[key];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  };
  if (cfg.usernameClaim) return pick(cfg.usernameClaim);
  return pick("preferred_username") ?? pick("email") ?? pick("sub");
}

/** Extract groups from a JWT claim — accepts string[] or a delimited string. */
function groupsFromClaims(payload: JWTPayload, cfg: AuthConfig): string[] | undefined {
  const v = payload[cfg.groupsClaim];
  if (Array.isArray(v)) {
    const arr = v.filter((g): g is string => typeof g === "string" && g.trim().length > 0);
    return arr.length ? arr.map((s) => s.trim()) : undefined;
  }
  if (typeof v === "string") return splitGroups(v);
  return undefined;
}

/** Read the token from the configured header, stripping `Bearer ` for Authorization. */
function tokenFromRequest(req: FastifyRequest, cfg: AuthConfig): string | undefined {
  const raw = header(req, cfg.jwtHeader);
  if (!raw) return undefined;
  if (cfg.jwtHeader.toLowerCase() === "authorization") {
    const m = /^Bearer\s+(.+)$/i.exec(raw);
    return m ? m[1].trim() : raw;
  }
  return raw;
}

/**
 * Register the auth layer on `app`. Adds a `user` request decorator and an
 * `onRequest` hook that populates `req.user` (or replies 401). The decorator +
 * hook are attached to the root app instance directly, so they guard every
 * REST + WS request app-wide.
 *
 * In `jwt` mode the remote JWKS is created once and reused —
 * `createRemoteJWKSet` fetches+caches keys and handles rotation, so we hold only
 * the URL, never key material.
 *
 * Throws at registration time on a fatal misconfiguration (jwt mode without a
 * JWKS URL) so the operator gets a clear startup failure instead of a server
 * that rejects every request — failing closed but loudly.
 */
export function registerAuth(app: FastifyInstance, auth: AuthConfig): void {
  const cfg = auth;

  if (cfg.mode === "none") {
    app.decorateRequest("user", null);
    // This branch refuses nothing, so the management-API exemption changes no
    // OUTCOME here — `/mcp` is reachable either way, and its own authenticator
    // is what gates it (management-auth.ts). It is called out rather than
    // applied because the rule that matters is "the browser hook never decides
    // anything about /mcp", and in this mode the hook decides nothing at all.
    app.addHook("onRequest", async (req) => {
      req.user = ANONYMOUS;
    });
    app.log.info("auth: mode=none (open access — every request is anonymous)");
    return;
  }

  // Decorate so the property exists on every request object up front (Fastify
  // perf best-practice); the hook assigns the real value per request.
  app.decorateRequest("user", null);

  if (cfg.mode === "trusted-header") {
    app.log.info(
      { userHeader: cfg.userHeader },
      "auth: mode=trusted-header (identity trusted from proxy header)",
    );
    app.addHook("onRequest", async (req, reply) => {
      if (isExempt(req.url)) {
        req.user = ANONYMOUS;
        return;
      }
      const username = header(req, cfg.userHeader);
      if (!username) {
        req.log.warn({ url: req.url, header: cfg.userHeader }, "auth: missing user header");
        return reply.code(401).send({ error: "unauthorized", code: "auth_required" });
      }
      const user: AuthUser = { username };
      if (cfg.emailHeader) {
        const email = header(req, cfg.emailHeader);
        if (email) user.email = email;
      }
      if (cfg.groupsHeader) {
        const groups = splitGroups(header(req, cfg.groupsHeader));
        if (groups) user.groups = groups;
      }
      req.user = user;
    });
    return;
  }

  // mode === "jwt"
  if (!cfg.jwksUrl) {
    throw new Error(
      "auth: PADDOCK_AUTH_MODE=jwt requires PADDOCK_AUTH_JWKS_URL (the IdP's JWKS endpoint)",
    );
  }
  let jwks: JWTVerifyGetKey;
  try {
    jwks = createRemoteJWKSet(new URL(cfg.jwksUrl));
  } catch (err) {
    throw new Error(
      `auth: invalid PADDOCK_AUTH_JWKS_URL (${cfg.jwksUrl}): ${(err as Error).message}`,
    );
  }
  app.log.info(
    { jwksUrl: cfg.jwksUrl, jwtHeader: cfg.jwtHeader, issuer: cfg.jwtIssuer, audience: cfg.jwtAudience },
    "auth: mode=jwt (verifying signed tokens against remote JWKS)",
  );

  app.addHook("onRequest", async (req, reply) => {
    if (isExempt(req.url)) {
      req.user = ANONYMOUS;
      return;
    }
    const token = tokenFromRequest(req, cfg);
    if (!token) {
      req.log.warn({ url: req.url, header: cfg.jwtHeader }, "auth: missing JWT");
      return reply.code(401).send({ error: "unauthorized", code: "auth_required" });
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        ...(cfg.jwtIssuer ? { issuer: cfg.jwtIssuer } : {}),
        ...(cfg.jwtAudience ? { audience: cfg.jwtAudience } : {}),
      }));
    } catch (err) {
      // Invalid signature, expired, wrong issuer/audience, malformed, etc.
      req.log.warn({ url: req.url, err: (err as Error).message }, "auth: JWT verification failed");
      return reply.code(401).send({ error: "invalid token", code: "auth_invalid" });
    }
    const username = usernameFromClaims(payload, cfg);
    if (!username) {
      req.log.warn(
        { url: req.url, claim: cfg.usernameClaim },
        "auth: JWT verified but no username claim present",
      );
      return reply.code(401).send({ error: "invalid token", code: "auth_no_subject" });
    }
    const user: AuthUser = { username };
    const email = payload.email;
    if (typeof email === "string" && email.trim().length > 0) user.email = email.trim();
    // Groups: prefer the JWT claim; allow a header override only if explicitly set.
    const groups = cfg.groupsHeader
      ? splitGroups(header(req, cfg.groupsHeader)) ?? groupsFromClaims(payload, cfg)
      : groupsFromClaims(payload, cfg);
    if (groups) user.groups = groups;
    req.user = user;
  });
}
