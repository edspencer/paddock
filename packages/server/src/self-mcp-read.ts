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
import { isRootKey } from "./project-paths.js";
import { ok, fail, errText, clampLimit, coerceBoolean, truncateText } from "./self-mcp-util.js";

/**
 * The workspace key an arg names, or `undefined` when the arg is ABSENT (#560).
 *
 * Load-bearing distinction: the ROOT workspace's key is the empty string, so a
 * truthiness test on this value silently collapses "the root" into "unspecified".
 * Callers must therefore branch on `=== undefined`, never on falsiness. A
 * whitespace-only value trims to `""` and so addresses the root, which is the
 * same normalisation a slug already gets.
 */
function workspaceArg(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export function listProjectsHandler(context: SelfMcpContext) {
  return async (): Promise<McpToolCallResult> => {
    try {
      const all = await context.listProjects();
      // #560: the root workspace is NOT a project and is deliberately absent from
      // `ProjectStore.list()` (enumeration walks children only) — but a caller
      // that can't learn it exists can't reach its chats either. So it rides
      // along as its OWN field, exactly the shape `GET /api/projects` settled on
      // (`{ projects, root }`): reachable without being enumerated. `count` stays
      // the project count. `root` is null when the caller's scope excludes it.
      const projects = all.filter((p) => !isRootKey(p.slug));
      const root = all.find((p) => isRootKey(p.slug)) ?? null;
      return ok({ count: projects.length, projects, root });
    } catch (error) {
      return fail(`Error listing projects: ${errText(error)}`);
    }
  };
}

export function listChatsHandler(context: SelfMcpContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const project = workspaceArg(args.project);
      const includeArchived = coerceBoolean(args.include_archived, false);
      // #560: `""` is the ROOT workspace's key, so it is passed THROUGH as an
      // address. The old `project && project.length > 0` collapsed it into "no
      // filter", which answered an explicitly-named target with a different
      // target's chats — silently. Absent (`undefined`) still means every
      // workspace, root included.
      const all = await context.listChats(project);
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
      const project = workspaceArg(args.project);
      const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
      // ABSENT, not empty (#560): `""` is the root workspace's key and a perfectly
      // valid target. The old truthiness check made the root unaddressable AND
      // reported a supplied argument as missing.
      if (project === undefined) {
        return fail(
          'Error: `project` (a workspace key — a project slug, or "" for the root workspace) is required.',
        );
      }
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
