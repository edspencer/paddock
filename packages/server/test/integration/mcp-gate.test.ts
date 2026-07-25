/**
 * Integration tests for the `/mcp` Management API gate (#312 M1).
 *
 * These boot the REAL app so they prove the properties that only hold once
 * everything is wired — in particular that `/mcp` is NOT swallowed by the
 * browser auth hook, and that an unconfigured instance really 404s rather than
 * falling through to some other handler.
 *
 * The invariants under test are the non-negotiable ones from the ticket:
 *   1. fail closed — unconfigured ⇒ 404, the endpoint does not exist;
 *   2. gated even at `auth.mode: none` — a self-hoster running Paddock open on
 *      a trusted LAN must not thereby acquire an unauthenticated, turn-spawning
 *      endpoint;
 *   3. a refusal is 401 + `WWW-Authenticate`, never a redirect (a 302 to a login
 *      page breaks MCP discovery);
 *   4. the credential is per-client, so revoking one doesn't affect another.
 */
import { describe, it, expect, afterEach } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";

const TOKEN = "pdk_testinstance_0123456789abcdef0123456789";
const OTHER_TOKEN = "pdk_testinstance_ffffffffffffffffffffffffff";

let app: TestApp | undefined;

afterEach(async () => {
  await app?.teardown();
  app = undefined;
});

/** POST a JSON-RPC message with the Accept types the transport requires. */
async function mcpPost(a: TestApp, token: string, body: unknown) {
  return a.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: body as Record<string, unknown>,
  });
}

/** The single data frame out of an SSE-framed reply. */
function sseJson(body: string): Record<string, unknown> | undefined {
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice("data: ".length)) : undefined;
}

/** Boot an app with N configured management clients (or none). */
async function boot(opts: { clients?: Record<string, unknown>; instanceId?: string } = {}) {
  app = await startTestApp({
    configFile: opts.clients
      ? {
          managementApi: {
            publicUrl: "https://paddock.example.test",
            ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
            clients: opts.clients,
          },
        }
      : undefined,
    env: { MCP_TOKEN_A: TOKEN, MCP_TOKEN_B: OTHER_TOKEN },
  });
  return app;
}

describe("/mcp — fail closed when unconfigured", () => {
  it("404s with no managementApi block at all", async () => {
    const a = await boot();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await a.app.inject({ method, url: "/mcp" });
      expect(res.statusCode).toBe(404);
    }
  });

  // The endpoint must not be reachable just because a credential is presented —
  // there is nothing to authenticate against.
  it("404s even when a bearer token is presented", async () => {
    const a = await boot();
    const res = await a.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s when a configured client's credential does not resolve (dropped ⇒ none left)", async () => {
    const a = await boot({ clients: { laptop: { auth: { ref: "env:MCP_TOKEN_UNSET" } } } });
    const res = await a.app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(404);
  });
});

describe("/mcp — authentication", () => {
  const oneClient = { laptop: { auth: { ref: "env:MCP_TOKEN_A" } } };

  it("401s with a WWW-Authenticate challenge when no credential is given", async () => {
    const a = await boot({ clients: oneClient });
    const res = await a.app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    expect(res.headers["www-authenticate"]).toContain('realm="paddock"');
  });

  // The MCP-discovery-breaking failure mode we must never exhibit.
  it("never answers a refusal with a redirect", async () => {
    const a = await boot({ clients: oneClient });
    const res = await a.app.inject({ method: "GET", url: "/mcp" });
    // A refusal must be an actionable 401 — not any flavour of 3xx, and with no
    // Location header for a client to chase.
    expect(res.statusCode).toBe(401);
    const isRedirect = res.statusCode >= 300 && res.statusCode < 400;
    expect(isRedirect).toBe(false);
    expect(res.headers.location).toBeUndefined();
  });

  it("401s on a wrong token, and marks it invalid_token", async () => {
    const a = await boot({ clients: oneClient });
    const res = await a.app.inject({
      method: "GET",
      url: "/mcp",
      headers: { authorization: `Bearer ${"n".repeat(40)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("401s on a non-bearer Authorization header", async () => {
    const a = await boot({ clients: oneClient });
    const res = await a.app.inject({
      method: "GET",
      url: "/mcp",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("admits a valid token through to the transport", async () => {
    const a = await boot({ clients: oneClient });
    const res = await mcpPost(a, TOKEN, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    // Past the gate: the transport answered rather than the guard refusing.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(404);
    expect(res.body).toContain("tools");
  });

  // The transport requires BOTH content types in Accept; a request without them
  // is refused by the transport (406), which is still proof the gate let it by.
  it("rejects an authenticated POST that omits the SSE Accept type", async () => {
    const a = await boot({ clients: oneClient });
    const res = await a.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(406);
  });

  it("never echoes the presented credential back", async () => {
    const a = await boot({ clients: oneClient });
    const res = await mcpPost(a, TOKEN, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.body).not.toContain(TOKEN);
  });
});

describe("/mcp — per-client credentials", () => {
  it("distinguishes two clients by their own tokens", async () => {
    const a = await boot({
      clients: {
        laptop: { auth: { ref: "env:MCP_TOKEN_A" } },
        peer: { auth: { ref: "env:MCP_TOKEN_B" } },
      },
    });
    const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    // Both credentials authenticate independently — revoking one must not
    // affect the other, which is the point of per-client tokens.
    for (const token of [TOKEN, OTHER_TOKEN]) {
      const res = await mcpPost(a, token, LIST);
      expect(res.statusCode).not.toBe(401);
      expect(sseJson(res.body)).toBeDefined();
    }
    // A third, unconfigured credential is still refused.
    const bad = await mcpPost(a, "pdk_testinstance_" + "0".repeat(40), LIST);
    expect(bad.statusCode).toBe(401);
  });
});

describe("/mcp — instance binding", () => {
  it("rejects a token minted for a DIFFERENT instance", async () => {
    // The configured client's token is bound to `testinstance`, but this
    // instance calls itself `other` — so the credential is meaningless here.
    const a = await boot({
      clients: { laptop: { auth: { ref: "env:MCP_TOKEN_A" } } },
      instanceId: "other",
    });
    const res = await a.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the same token when the instance matches", async () => {
    const a = await boot({
      clients: { laptop: { auth: { ref: "env:MCP_TOKEN_A" } } },
      instanceId: "testinstance",
    });
    const res = await mcpPost(a, TOKEN, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.statusCode).not.toBe(401);
  });
});

describe("/mcp — publicUrl is mandatory", () => {
  // Fail closed rather than half-enable: without a canonical public URL, M2's
  // discovery document could not be served with a byte-matching `resource`.
  it("disables the API entirely when publicUrl is absent", async () => {
    app = await startTestApp({
      configFile: { managementApi: { clients: { laptop: { auth: { ref: "env:MCP_TOKEN_A" } } } } },
      env: { MCP_TOKEN_A: TOKEN },
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("/.well-known/ — not swallowed by the SPA catch-all", () => {
  // The SPA not-found handler serves the app shell for any extension-less GET.
  // `/.well-known/oauth-protected-resource` has no extension, so without an
  // explicit exclusion it returns 200 + HTML — which holes the fail-closed
  // guarantee and breaks MCP OAuth discovery (the client can't parse HTML and
  // silently falls back to treating Paddock as its own authorization server).
  //
  // This harness runs API-only (no web dist), so it exercises the route-level
  // behaviour; app-static.test.ts covers the shell-serving handler itself.
  it("404s the protected-resource metadata path while unimplemented", async () => {
    const a = await boot({ clients: { laptop: { auth: { ref: "env:MCP_TOKEN_A" } } } });
    for (const url of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await a.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"] ?? "").not.toContain("text/html");
    }
  });
});

describe("/mcp — independence from the browser auth mode", () => {
  // The headline invariant: `auth.mode: none` (the default this harness runs
  // under) leaves the browser surface open, but `/mcp` is STILL credential-gated.
  it("stays gated when browser auth is none", async () => {
    const a = await boot({ clients: { laptop: { auth: { ref: "env:MCP_TOKEN_A" } } } });
    expect(a.cfg.auth.mode).toBe("none");
    // An unauthenticated API route is open in this mode…
    expect((await a.app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    // …but /mcp is not.
    expect((await a.app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(401);
  });
});
