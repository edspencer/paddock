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
 * Health/readiness probes are always exempt so the proxy and monitoring can poll
 * a server that is otherwise locked down.
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

/** Paths that must never require auth (proxy / monitoring health probes). */
const HEALTH_PATHS = new Set<string>([
  "/api/health", // paddock's own health route (routes.ts)
  "/healthz",
  "/-/health",
  "/health",
  "/readyz",
  "/livez",
]);

/** Strip the query string and trailing slash so exemption matching is robust. */
function normalizePath(url: string): string {
  const q = url.indexOf("?");
  let p = q === -1 ? url : url.slice(0, q);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function isExempt(url: string): boolean {
  return HEALTH_PATHS.has(normalizePath(url));
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
