/**
 * Unit tests for the provider-agnostic auth layer (auth.ts).
 *
 * Drives a real (minimal) Fastify instance through `app.inject` for each mode:
 *   - none           — anonymous, fully open; no 401s
 *   - trusted-header — reads username/email/groups headers; 401 when absent
 *   - jwt            — verifies a signed JWT against a JWKS, maps claims, 401 on
 *                      missing/invalid/expired/wrong-issuer/wrong-audience
 *   - health paths   — always exempt
 *   - static assets  — /assets, /icons, /fonts, /sw.js, manifest, favicon exempt (#223)
 *
 * For jwt mode we generate a real RSA keypair with `jose` and serve its public
 * JWK from a stubbed `createRemoteJWKSet` (no network). Tokens are signed with
 * the private key, so `jwtVerify` exercises the genuine verification path.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
  type KeyLike,
} from "jose";
import type { AuthConfig } from "../../src/config.js";

// Stub createRemoteJWKSet so jwt-mode tests hit a LOCAL key set (no network).
// The fake holds the public JWK we publish per-test via `setPublicJwk`.
let publicJwk: JWK | null = null;
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => {
      const local = actual.createLocalJWKSet({ keys: publicJwk ? [publicJwk] : [] });
      return (protectedHeader: unknown, token: unknown) =>
        local(protectedHeader as never, token as never);
    },
  };
});

// Imported AFTER the mock so registerAuth picks up the stubbed createRemoteJWKSet.
const { registerAuth } = await import("../../src/auth.js");

/** Build the full AuthConfig from a partial, applying the same defaults as config.ts. */
function authConfig(over: Partial<AuthConfig>): AuthConfig {
  return {
    mode: "none",
    userHeader: "X-Forwarded-User",
    jwtHeader: "Authorization",
    groupsClaim: "groups",
    ...over,
  };
}

/** A Fastify app with auth registered + an echo route returning req.user. */
function buildApp(auth: AuthConfig): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAuth(app, auth);
  app.get("/api/whoami", async (req) => ({ user: req.user }));
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

describe("auth: mode=none", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("treats every request as anonymous (no 401)", async () => {
    app = buildApp(authConfig({ mode: "none" }));
    const res = await app.inject({ method: "GET", url: "/api/whoami" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ username: "anonymous", anonymous: true });
  });
});

describe("auth: mode=trusted-header", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("401s when the user header is absent", async () => {
    app = buildApp(authConfig({ mode: "trusted-header", userHeader: "X-Forwarded-User" }));
    const res = await app.inject({ method: "GET", url: "/api/whoami" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("auth_required");
  });

  it("populates username from the configured header", async () => {
    app = buildApp(authConfig({ mode: "trusted-header", userHeader: "X-authentik-username" }));
    const res = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { "x-authentik-username": "ed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ username: "ed" });
  });

  it("adds email + groups when those headers are configured + present", async () => {
    app = buildApp(
      authConfig({
        mode: "trusted-header",
        userHeader: "Remote-User",
        emailHeader: "Remote-Email",
        groupsHeader: "Remote-Groups",
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: {
        "remote-user": "ed",
        "remote-email": "ed@edspencer.net",
        "remote-groups": "admins, editors viewers",
      },
    });
    expect(res.json().user).toEqual({
      username: "ed",
      email: "ed@edspencer.net",
      groups: ["admins", "editors", "viewers"],
    });
  });

  it("exempts health paths (no header required)", async () => {
    app = buildApp(authConfig({ mode: "trusted-header" }));
    for (const url of ["/api/health", "/healthz"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

describe("auth: mode=jwt", () => {
  let app: FastifyInstance;
  let privateKey: KeyLike;
  const ISSUER = "https://sso.valfenda.net/application/o/paddock/";
  const AUDIENCE = "paddock";

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
    privateKey = priv;
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    publicJwk = jwk;
    // sanity: the local set resolves our published key
    expect(typeof createLocalJWKSet).toBe("function");
  });

  afterEach(async () => app?.close());

  async function sign(
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ): Promise<string> {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? "5m");
    if (opts.issuer) jwt = jwt.setIssuer(opts.issuer);
    if (opts.audience) jwt = jwt.setAudience(opts.audience);
    return jwt.sign(privateKey);
  }

  it("401s when the token header is absent", async () => {
    app = buildApp(authConfig({ mode: "jwt", jwksUrl: "https://idp/jwks" }));
    const res = await app.inject({ method: "GET", url: "/api/whoami" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("auth_required");
  });

  it("verifies a valid token and maps preferred_username", async () => {
    app = buildApp(
      authConfig({ mode: "jwt", jwtHeader: "X-authentik-jwt", jwksUrl: "https://idp/jwks" }),
    );
    const token = await sign({
      preferred_username: "ed",
      email: "ed@edspencer.net",
      groups: ["paddock-admins"],
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { "x-authentik-jwt": token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({
      username: "ed",
      email: "ed@edspencer.net",
      groups: ["paddock-admins"],
    });
  });

  it("strips `Bearer ` when the header is Authorization", async () => {
    app = buildApp(authConfig({ mode: "jwt", jwtHeader: "Authorization", jwksUrl: "https://idp/jwks" }));
    const token = await sign({ sub: "user-123" });
    const res = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe("user-123"); // falls back to sub
  });

  it("honours a custom username + groups claim", async () => {
    app = buildApp(
      authConfig({
        mode: "jwt",
        jwksUrl: "https://idp/jwks",
        usernameClaim: "uid",
        groupsClaim: "roles",
      }),
    );
    const token = await sign({ uid: "edspencer", roles: ["a", "b"], preferred_username: "ignored" });
    const res = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().user).toEqual({ username: "edspencer", groups: ["a", "b"] });
  });

  it("rejects an expired token", async () => {
    app = buildApp(authConfig({ mode: "jwt", jwksUrl: "https://idp/jwks" }));
    const token = await sign({ sub: "ed" }, { expiresIn: "-1m" });
    const res = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("auth_invalid");
  });

  it("validates issuer + audience when configured", async () => {
    app = buildApp(
      authConfig({
        mode: "jwt",
        jwksUrl: "https://idp/jwks",
        jwtIssuer: ISSUER,
        jwtAudience: AUDIENCE,
      }),
    );
    // wrong issuer → reject
    const bad = await sign({ sub: "ed" }, { issuer: "https://evil/", audience: AUDIENCE });
    const r1 = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${bad}` },
    });
    expect(r1.statusCode).toBe(401);
    // correct issuer + audience → accept
    const good = await sign({ sub: "ed" }, { issuer: ISSUER, audience: AUDIENCE });
    const r2 = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${good}` },
    });
    expect(r2.statusCode).toBe(200);
  });

  it("rejects a garbage token", async () => {
    app = buildApp(authConfig({ mode: "jwt", jwksUrl: "https://idp/jwks" }));
    const res = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("exempts health paths without a token", async () => {
    app = buildApp(authConfig({ mode: "jwt", jwksUrl: "https://idp/jwks" }));
    for (const url of ["/api/health", "/healthz"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("exempts immutable static assets without a token, but not the shell/API (issue #223)", async () => {
    app = buildApp(authConfig({ mode: "jwt", jwtHeader: "X-authentik-jwt", jwksUrl: "https://idp/jwks" }));
    // Probe routes at representative static paths so an exempt request resolves to
    // 200 (a bare 404 could also mean "passed auth but no route").
    const staticPaths = [
      "/assets/index-ABC.js",
      "/icons/icon-192.png",
      "/fonts/inter-latin.woff2",
      "/sw.js",
      "/manifest.webmanifest",
      "/favicon.ico",
    ];
    for (const p of staticPaths) app.get(p, async () => ({ ok: true }));

    for (const url of [...staticPaths, "/assets/index-ABC.js?v=cachebust"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200); // no token, still served
    }

    // The app shell and every data route still require a valid token.
    for (const url of ["/api/whoami", "/api/anything"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().code).toBe("auth_required");
    }
    // A path that only *contains* an asset-looking segment (but is under /api) is
    // NOT exempt — the prefix must be at the path root.
    const nested = await app.inject({ method: "GET", url: "/api/assets/thing.js" });
    expect(nested.statusCode).toBe(401);
  });

  it("throws at registration when jwt mode lacks a JWKS URL", () => {
    const app2 = Fastify({ logger: false });
    expect(() => registerAuth(app2, authConfig({ mode: "jwt" }))).toThrow(/JWKS_URL/);
  });
});
