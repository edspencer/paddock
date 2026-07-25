/**
 * The `/mcp` Management API endpoint (issue #312).
 *
 * M1 shipped the gate (authentication, principal resolution, fail-closed
 * behaviour); M2 mounts the streamable-HTTP MCP transport behind it and the RFC
 * 9728 discovery document beside it.
 *
 * ── The response matrix ────────────────────────────────────────────────────
 *   404  — no `managementApi.clients` (or no `publicUrl`). The endpoint DOES
 *          NOT EXIST until an operator deliberately turns it on. This is the
 *          backstop for the deploy-ordering hazard: exempting `/mcp` at an edge
 *          proxy removes the only other gate in front of it.
 *   401  — credential missing or bad. Always `401` + `WWW-Authenticate`, NEVER
 *          a 302 to a login page: an MCP client cannot follow a redirect, and
 *          OAuth discovery reads this exact challenge.
 *   403  — authenticated but out of scope (`insufficient_scope`), or plaintext
 *          from a non-loopback client.
 *   405  — GET/DELETE. In stateless mode the transport answers a GET with an SSE
 *          stream that never emits anything, so a client would hang forever on a
 *          socket with no headers.
 *
 * Authentication runs in `onRequest` — BEFORE body parsing — so a malformed or
 * oversized body can never preempt the auth decision.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RouteCtx } from "../route-context.js";
import {
  authenticateManagementRequest,
  challengeHeader,
  isManagementApiEnabled,
  resourceMetadataUrl,
} from "../management-auth.js";
import {
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PREFIX,
  MCP_RESOURCE_PATH,
} from "../management-metadata.js";
import { buildManagementOps, enforceManagementPolicy } from "../management-ops.js";
import { selfMcpServerDefForOps } from "../ws-self-mcp.js";
import { buildManagementMcpServer } from "../management-mcp-server.js";
import { HUMAN_ROOT } from "../run-provenance.js";
import type { ManagementPrincipal } from "../management-policy.js";

/** The URL path the management surface is mounted at. */
export const MCP_PATH = MCP_RESOURCE_PATH;

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The authenticated Management API caller, set by the `/mcp` guard. Absent
     * on every other route — this is NOT the browser user (`req.user`), which is
     * a separate, independent identity (see management-auth.ts).
     */
    managementPrincipal?: ManagementPrincipal;
  }
}

/**
 * Whether the request reached us over a secure channel.
 *
 * Accepts three cases: real TLS at this process, a TLS-terminating proxy that
 * set `X-Forwarded-Proto: https` (the common home-lab shape), or a loopback
 * client (nothing left the host, so there is no wire to sniff). Everything else
 * is plaintext over a real network, where a bearer token would be readable in
 * transit — refused, mirroring the spirit of the bind-safety guard (#435).
 */
export function isSecureRequest(req: FastifyRequest): boolean {
  if (req.protocol === "https") return true;
  const fwd = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function registerMcpRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { cfg, managementOpsContext } = ctx;

  // ── Discovery (unauthenticated by design) ────────────────────────────────
  // A client fetches this BEFORE it holds any credential, so gating it would
  // make discovery impossible. The document names the authorization server and
  // supported scopes — never a secret.
  //
  // Served at BOTH the path-inserted URL (what clients actually request for a
  // resource with a path) and the bare root (harmless, and other clients may
  // use it). Still 404s when the surface is off, so a disabled instance doesn't
  // advertise a management API.
  const metadataHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!isManagementApiEnabled(cfg.managementApi)) {
      return reply.code(404).send({ error: "not found" });
    }
    const doc = buildProtectedResourceMetadata(cfg.managementApi);
    if (!doc) return reply.code(404).send({ error: "not found" });
    return reply
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .type("application/json; charset=utf-8")
      .send(doc);
  };
  for (const url of [
    `${PROTECTED_RESOURCE_METADATA_PREFIX}${MCP_RESOURCE_PATH}`,
    PROTECTED_RESOURCE_METADATA_PREFIX,
  ]) {
    app.get(url, { schema: { hide: true } }, metadataHandler);
  }

  // ── The gate ─────────────────────────────────────────────────────────────
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isManagementApiEnabled(cfg.managementApi)) {
      return reply.code(404).send({ error: "not found" });
    }

    if (!isSecureRequest(req)) {
      req.log.warn(
        { url: req.url },
        "management API: refusing a plaintext non-loopback request (a bearer token would be readable in transit)",
      );
      return reply.code(403).send({
        error: "https required",
        code: "insecure_transport",
        message:
          "The management API refuses plaintext requests from non-loopback clients. " +
          "Terminate TLS in front of Paddock (and forward X-Forwarded-Proto), or connect over loopback.",
      });
    }

    const result = authenticateManagementRequest(req.headers.authorization, cfg.managementApi);
    if (!result.ok) {
      // Log the failure and the caller, never the presented credential.
      req.log.warn(
        { url: req.url, failure: result.failure, ip: req.socket.remoteAddress },
        "management API: authentication failed",
      );
      return reply
        .code(401)
        .header(
          "WWW-Authenticate",
          challengeHeader(result.failure, resourceMetadataUrl(cfg.managementApi)),
        )
        .send({ error: "unauthorized", code: "auth_required" });
    }

    req.managementPrincipal = result.principal;
  };

  // ── GET / DELETE → 405 ───────────────────────────────────────────────────
  // Stateless transport: a GET would open an SSE stream that never emits, so the
  // client waits forever on a header-less socket. Refuse explicitly instead.
  app.route({
    method: ["GET", "DELETE"],
    url: MCP_PATH,
    schema: { hide: true },
    onRequest: guard,
    handler: async (_req, reply) =>
      reply.code(405).header("allow", "POST").send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST for the MCP endpoint." },
        id: null,
      }),
  });

  // ── POST → the MCP transport ─────────────────────────────────────────────
  app.route({
    method: ["POST"],
    url: MCP_PATH,
    // Kept out of the OpenAPI document (#466): this is a JSON-RPC MCP endpoint,
    // not a REST resource, and a body schema here would become an active
    // request validator over MCP payloads.
    schema: { hide: true },
    onRequest: guard,
    handler: async (req, reply) => {
      const principal = req.managementPrincipal;
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      if (!managementOpsContext) {
        // Wiring error rather than a client error — the surface is configured
        // but the server didn't hand the route its ops context.
        req.log.error("management API: ops context unavailable; /mcp cannot serve requests");
        return reply.code(503).send({ error: "unavailable", code: "ops_unavailable" });
      }

      // Ops are built PER REQUEST, bound to this principal, then policed. An
      // external caller has no "current chat", so it addresses everything
      // explicitly and its spawns are rooted like a human's.
      const ops = buildManagementOps(managementOpsContext, {
        currentProjectSlug: "",
        currentSessionId: () => null,
        parentProvenance: HUMAN_ROOT,
        // All three capability gates are opened here and NARROWED by scope
        // immediately below. That is the right split for an external caller:
        // these per-project/per-instance gates exist to bound what a KEEPER may
        // reach, whereas an external client is bounded by its credential. So a
        // client gets `create_project` only by naming it in `allow` — the
        // read-only default excludes it, as it does every other mutation.
        includeWrite: true,
        includeTriggers: true,
        includeProjects: true,
        spawnDepthCap: principal.scope.maxSpawnDepth,
      });
      const policed = enforceManagementPolicy(ops, principal);
      const def = selfMcpServerDefForOps(policed, principal);
      const server = buildManagementMcpServer(def, principal);

      // Stateless: a fresh server+transport per request. No session store, no
      // cross-request state, restart-safe — and a principal's tool visibility
      // can never leak into another caller's session.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) headers.append(k, String(one));
      }

      const base = cfg.managementApi.publicUrl ?? "http://localhost";
      const response = await transport.handleRequest(
        new Request(new URL(req.url, base), { method: "POST", headers }),
        {
          // MANDATORY: Fastify has already drained the socket, so without this
          // the transport calls .json() on an empty body and reports
          // "Parse error: Invalid JSON" for perfectly valid input.
          parsedBody: req.body,
        },
      );

      // Flush response headers BEFORE the body. Node buffers writeHead() until
      // the first body byte, so a slow tool call (every turn-spawning op is one)
      // would stall the response headers for its whole duration — measured at
      // 3011ms vs 28ms — which reads as a hang to a proxy with a header timeout.
      // `forEach` rather than `entries()`: the server tsconfig's lib doesn't
      // include the DOM iterable declarations, so `Headers` has no iterator here.
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      reply.raw.writeHead(response.status, outHeaders);
      reply.raw.flushHeaders();

      if (!response.body) {
        reply.raw.end();
        void server.close();
        return reply.hijack();
      }
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      body.pipe(reply.raw);
      reply.raw.on("close", () => {
        body.destroy();
        void server.close();
      });
      // Hijack tells Fastify we own the socket — the SDK has already written it.
      return reply.hijack();
    },
  });
}
