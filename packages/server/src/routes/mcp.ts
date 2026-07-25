/**
 * The `/mcp` Management API endpoint guard (issue #312 M1).
 *
 * M1 ships the GATE, not the transport: authentication, policy principal
 * resolution, and the fail-closed behaviour are complete and testable here,
 * while the streamable-HTTP MCP transport that will answer behind it lands in
 * M2 (which replaces the 501 below with the real handler).
 *
 * ── The three responses, and why each is what it is ────────────────────────
 *   404  — no `managementApi.clients` configured. The endpoint DOES NOT EXIST
 *          until an operator deliberately turns it on. This is the backstop for
 *          the deploy-ordering hazard on the ticket: exempting `/mcp` at an edge
 *          proxy removes the only other gate in front of it, so a Paddock that
 *          hasn't been configured for external access must not answer at all.
 *   401  — a credential was missing or bad. Always `401` + `WWW-Authenticate`,
 *          NEVER a 302 to a login page: an MCP client cannot follow a redirect,
 *          and OAuth discovery (M2) reads this exact challenge.
 *   501  — authenticated and in scope, but the MCP transport isn't mounted yet.
 *          Replaced in M2.
 *
 * Authentication runs in `onRequest` — BEFORE body parsing — so a malformed or
 * oversized body can never preempt the auth decision.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RouteCtx } from "../route-context.js";
import {
  authenticateManagementRequest,
  challengeHeader,
  isManagementApiEnabled,
} from "../management-auth.js";
import type { ManagementPrincipal } from "../management-policy.js";

/** The URL path the management surface is mounted at. */
export const MCP_PATH = "/mcp";

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
  const { cfg } = ctx;

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Fail closed: unconfigured ⇒ the endpoint does not exist. Deliberately the
    // same body shape as any other 404 so an unconfigured instance is
    // indistinguishable from one that never had the route.
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
        .header("WWW-Authenticate", challengeHeader(result.failure))
        .send({ error: "unauthorized", code: "auth_required" });
    }

    req.managementPrincipal = result.principal;
  };

  app.route({
    // The streamable-HTTP MCP transport uses POST for calls, GET for the SSE
    // stream, and DELETE to end a session — all three gate identically.
    method: ["GET", "POST", "DELETE"],
    url: MCP_PATH,
    // Kept out of the OpenAPI document (#466): this is a JSON-RPC MCP endpoint,
    // not a REST resource, and a body schema here would become an active
    // request validator over MCP payloads.
    schema: { hide: true },
    onRequest: guard,
    handler: async (req, reply) => {
      const principal = req.managementPrincipal;
      req.log.info(
        { clientId: principal?.clientId, kind: principal?.kind },
        "management API: authenticated request (transport not yet mounted)",
      );
      return reply.code(501).send({
        error: "not implemented",
        code: "mcp_transport_not_mounted",
        message:
          "Authentication and policy are active, but the MCP transport is not mounted in this build.",
        clientId: principal?.clientId,
      });
    },
  });
}
