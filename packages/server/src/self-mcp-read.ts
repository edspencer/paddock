/**
 * Read-only handler factories for the Paddock self-management MCP (issue #214).
 *
 * The three always-on tools — list_projects / list_chats / read_chat — bound to a
 * per-turn {@link SelfMcpContext}. Each factory returns an async handler that
 * validates/normalizes args, delegates to the context callbacks, and shapes the
 * plain-JSON tool result. read_chat applies the tail/limit + per-message
 * truncation here (the context returns the FULL message list) so that logic stays
 * unit-testable without the fleet.
 */
import type { McpToolCallResult } from "@herdctl/core";
import type { SelfMcpContext } from "./self-mcp-types.js";
import { ok, fail, errText, clampLimit, coerceBoolean, truncateText } from "./self-mcp-util.js";

export function listProjectsHandler(context: SelfMcpContext) {
  return async (): Promise<McpToolCallResult> => {
    try {
      const projects = await context.listProjects();
      return ok({ count: projects.length, projects });
    } catch (error) {
      return fail(`Error listing projects: ${errText(error)}`);
    }
  };
}

export function listChatsHandler(context: SelfMcpContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const project = typeof args.project === "string" ? args.project.trim() : undefined;
      const includeArchived = coerceBoolean(args.include_archived, false);
      const all = await context.listChats(project && project.length > 0 ? project : undefined);
      // #489: archived chats are hidden by default so the tool agrees with the web
      // UI (which files them into a collapsed section). Filtering HERE rather than
      // in the op keeps the blast radius off `SelfMcpContext`, the policy wrapper
      // and both test fakes. The omitted count is reported rather than dropped
      // silently: `list_chats` is the ONLY source of session ids, so a silent
      // filter would make an archived chat unaddressable — no read_chat, no
      // unarchive_chat — with nothing in the response to hint at why.
      const chats = includeArchived ? all : all.filter((c) => !c.archived);
      return ok({
        count: chats.length,
        omittedArchived: all.length - chats.length,
        project: project ?? null,
        chats,
      });
    } catch (error) {
      return fail(`Error listing chats: ${errText(error)}`);
    }
  };
}

export function readChatHandler(context: SelfMcpContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const project = typeof args.project === "string" ? args.project.trim() : "";
      const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
      if (!project) return fail("Error: `project` (a project slug) is required.");
      if (!sessionId) return fail("Error: `session_id` is required (get it from list_chats).");
      const limit = clampLimit(args.limit);

      const all = await context.readChat(project, sessionId);
      const tail = all.slice(-limit).map((m) => ({
        role: m.role,
        text: truncateText(m.text),
        timestamp: m.timestamp,
      }));
      return ok({
        project,
        sessionId,
        total: all.length,
        returned: tail.length,
        messages: tail,
      });
    } catch (error) {
      return fail(`Error reading chat: ${errText(error)}`);
    }
  };
}
