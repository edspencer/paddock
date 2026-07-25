/**
 * The MCP server for external Management API callers (issue #312 M2).
 *
 * Adapts the SAME tool definitions the in-process keeper gets — an
 * {@link InjectedMcpServerDef} produced by `selfMcpServerDefForOps` — onto the
 * official MCP SDK, so an external client sees exactly the toolset a keeper
 * sees, minus whatever its scope hides. Nothing is redefined here: if a tool is
 * added to the self-MCP, it appears over `/mcp` with no further work, which is
 * the "upgrade the server, every client's toolset upgrades" property the epic
 * calls out.
 *
 * ── Why the LOW-LEVEL `Server`, not `McpServer` ────────────────────────────
 * The high-level `McpServer.registerTool` wants Zod schemas and converts them to
 * JSON Schema for the wire. Our tools already carry hand-written JSON Schema
 * (shared with herdctl's injected-MCP bridge), so going through Zod would mean
 * translating JSON Schema → Zod → JSON Schema and hoping the round trip is
 * faithful. Implementing `tools/list` + `tools/call` directly passes our schemas
 * through verbatim and keeps ONE source of truth for the tool surface.
 */
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { InjectedMcpServerDef } from "@herdctl/core";
import { ManagementDeniedError, type ManagementPrincipal } from "./management-policy.js";

/** Server identity advertised in the MCP `initialize` handshake. */
export const MANAGEMENT_MCP_SERVER_NAME = "paddock";

/**
 * Package version, advertised to the client so it can report which Paddock it
 * is talking to. Resolved at runtime (dist/management-mcp-server.js →
 * ../package.json), the same way app.ts resolves it for the OpenAPI document,
 * so it tracks releases without a build step.
 */
export const MANAGEMENT_MCP_SERVER_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Build an MCP server exposing `def`'s tools to `principal`.
 *
 * One server instance per request (the transport is stateless), so nothing here
 * is shared across callers and a principal's tool visibility can never leak into
 * another's session.
 */
export function buildManagementMcpServer(
  def: InjectedMcpServerDef,
  principal: ManagementPrincipal,
): Server {
  const server = new Server(
    { name: MANAGEMENT_MCP_SERVER_NAME, version: MANAGEMENT_MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const byName = new Map(def.tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: def.tools.map((t) => ({
      name: t.name,
      description: t.description,
      // Passed through verbatim — see the module header.
      inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    // A tool hidden by scope is simply absent from the map, so an external caller
    // guessing a name it wasn't offered gets the same answer as for a typo.
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
      return result as CallToolResult;
    } catch (error) {
      // A policy denial is a normal, expected outcome for a scoped caller — it
      // must reach the model as a readable tool error rather than blowing up the
      // JSON-RPC layer. (The HTTP 403 + `insufficient_scope` challenge is the
      // right shape for a REQUEST-level refusal; a denial DURING a tool call is
      // already past that point, so it is reported in-band.)
      if (error instanceof ManagementDeniedError) {
        return {
          content: [
            {
              type: "text",
              text: `${error.message} (client "${principal.clientId}"; operation "${error.operation}")`,
            },
          ],
          isError: true,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}
