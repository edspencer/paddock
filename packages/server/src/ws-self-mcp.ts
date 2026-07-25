/**
 * Self-management MCP server-def assembly (extracted from ws.ts in #403; the ops
 * construction moved out to management-ops.ts in #312 M1).
 *
 * What remains here is exactly the MCP-TRANSPORT concern: take a caller's built
 * {@link ManagementOps} and turn them into an {@link InjectedMcpServerDef}. The
 * operations themselves — and the policy that guards them — now live in
 * management-ops.ts, so a non-MCP caller (the `/mcp` transport now, REST parity
 * in #465) reaches the same ops without going through this module.
 *
 * `forkKickoffPrompt` is re-exported for its existing importers (ws.ts re-exports
 * it in turn, and its unit test resolves it via ws.js).
 */
import type { InjectedMcpServerDef } from "@herdctl/core";
import type { ChatHandlerContext } from "./ws-context.js";
import { selfMcpServerDef } from "./self-mcp.js";
import type { RunProvenance } from "./run-provenance.js";
import {
  buildManagementOps,
  enforceManagementPolicy,
  managementToolFilter,
  type ManagementOps,
} from "./management-ops.js";
import { INTERNAL_PRINCIPAL, type ManagementPrincipal } from "./management-policy.js";

export { forkKickoffPrompt } from "./management-ops.js";

/**
 * Assemble an MCP server def from already-built, already-policed ops. This is
 * the seam the `/mcp` transport uses: authenticate → build ops for the principal
 * → hand them here.
 */
export function selfMcpServerDefForOps(
  ops: ManagementOps,
  principal: ManagementPrincipal,
): InjectedMcpServerDef {
  return selfMcpServerDef(ops.read, ops.write, { toolFilter: managementToolFilter(principal) });
}

/**
 * Build the self-management MCP server def (issue #214) bound to one turn's
 * context — the IN-PROCESS keeper path.
 *
 * Runs under {@link INTERNAL_PRINCIPAL}: a keeper is bounded by depth
 * (`maxSpawnDepth`, #278), not by auth+scope, so policy short-circuits to allow
 * and this path behaves exactly as it did before #312.
 *
 * `parentProvenance` is the provenance of the chat these tools run IN — so any
 * child they spawn is `childOf(parentProvenance)` (origin `spawned`, depth+1).
 */
export function buildSelfMcpServerDef(
  ctx: ChatHandlerContext,
  params: {
    currentProjectSlug: string;
    currentSessionId: () => string | null;
    parentProvenance: RunProvenance;
    includeWrite: boolean;
    /**
     * Whether to additionally append the Epic T / T3 unified trigger-management
     * tools. Resolved per-project by the caller from the REUSED hooks-MCP gate.
     */
    includeTriggers: boolean;
    /**
     * Whether to expose `create_project` (#467) — its own instance-level gate,
     * separate from the other write tools.
     */
    includeProjects: boolean;
  },
): InjectedMcpServerDef {
  const ops = buildManagementOps(ctx, params);
  const policed = enforceManagementPolicy(ops, INTERNAL_PRINCIPAL);
  return selfMcpServerDefForOps(policed, INTERNAL_PRINCIPAL);
}
