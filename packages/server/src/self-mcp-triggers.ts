/**
 * Unified trigger-management handler factories for the Paddock self-management MCP
 * (Epic T "Unify Triggers" / T3 — issue #214). Collapse the paired schedule
 * (issue #289) + hook (Epic G / G5) verbs onto ONE TriggerService over
 * `project.yaml`'s single `triggers` block. A trigger is WHEN (`type`
 * schedule|event|webhook) + WHAT (the shared run) + `enabled`. These tools are
 * injected ONLY when the project opted into the trigger-management MCP
 * (`triggersMcpEnabled`) — a coarse binary gate. Enable/disable is `set_trigger`
 * with `enabled` flipped (GG-3), not a separate verb.
 */
import type { McpToolCallResult } from "@herdctl/core";
import type { SelfMcpWriteContext } from "./self-mcp-types.js";
import { ok, fail, errText, coerceToolList } from "./self-mcp-util.js";

/**
 * Assemble the PARTIAL structured `{ trigger?, run?, enabled? }` record the
 * `set_trigger` handler passes to `write.setTrigger` (which merges it over the
 * existing trigger via `mergeTriggerUpdate`, then validates). Only fields the
 * caller actually supplied are set, so an edit that omits a field preserves it
 * (create-or-update patch semantics) — the classic being an `enabled`-only flip.
 * Flat MCP args are the robust transport (the CLI runtime drops nested/array args,
 * so the discriminant is rebuilt here from scalar args). Returns a string error
 * message instead of a partial when a supplied `type`'s required WHEN field is
 * missing; `null` on none.
 */
export function buildTriggerUpdate(args: Record<string, unknown>): Record<string, unknown> | string {
  const incoming: Record<string, unknown> = {};

  // WHEN: only when `type` is supplied does the caller (re)specify the discriminant;
  // an omitted `type` inherits the existing trigger's WHEN unchanged (partial edit).
  const type = typeof args.type === "string" ? args.type.trim() : "";
  if (type) {
    if (type === "schedule") {
      const cron = typeof args.cron === "string" ? args.cron.trim() : "";
      const interval = typeof args.interval === "string" ? args.interval.trim() : "";
      if (!cron && !interval) {
        return 'Error: a "schedule" trigger needs `cron` (a 5-field expression, e.g. "0 9 * * *") or `interval` (e.g. "30m").';
      }
      if (cron && interval) {
        return 'Error: a "schedule" trigger takes exactly ONE of `cron` or `interval`, not both.';
      }
      incoming.trigger = cron ? { type, cron } : { type, interval };
    } else if (type === "event") {
      const event = typeof args.event === "string" ? args.event.trim() : "";
      if (!event) return 'Error: an "event" trigger needs `event` (the lifecycle trigger, e.g. "onArchive").';
      incoming.trigger = { type, on: event };
    } else if (type === "webhook") {
      const p = typeof args.path === "string" ? args.path.trim() : "";
      if (!p) return 'Error: a "webhook" trigger needs `path` (the ingress path; reserved — not yet fired).';
      incoming.trigger = { type, path: p };
    } else {
      return 'Error: `type` must be "schedule", "event", or "webhook".';
    }
  }

  // WHAT: assemble only the run fields the caller supplied.
  const run: Record<string, unknown> = {};
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const promptFile = typeof args.prompt_file === "string" ? args.prompt_file.trim() : "";
  if (prompt) run.prompt = prompt;
  if (promptFile) run.promptFile = promptFile;
  if (typeof args.session === "string" && (args.session === "new" || args.session === "resume")) {
    run.session = args.session;
  }
  if (typeof args.model === "string" && args.model.trim() !== "") run.model = args.model.trim();
  // `tools` is present (even as "") → set it (an empty list = a tool-less curator);
  // absent → leave the existing grant untouched on an edit.
  if (args.tools !== undefined) run.tools = coerceToolList(args.tools);
  if (typeof args.max_spawn_depth === "number") run.maxSpawnDepth = args.max_spawn_depth;
  if (typeof args.permission_mode === "string" && args.permission_mode.trim() !== "") {
    run.permissionMode = args.permission_mode.trim();
  }
  if (typeof args.max_turns === "number") run.maxTurns = args.max_turns;
  if (Object.keys(run).length > 0) incoming.run = run;

  if (typeof args.enabled === "boolean") incoming.enabled = args.enabled;
  return incoming;
}

export function setTriggerHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the trigger's key).");
      const incoming = buildTriggerUpdate(args);
      if (typeof incoming === "string") return fail(incoming);

      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const saved = await write.setTrigger(project, name, incoming);
      return ok({ set: true, project, trigger: saved });
    } catch (error) {
      return fail(`Error setting trigger: ${errText(error)}`);
    }
  };
}

export function removeTriggerHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the trigger to remove).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const removed = await write.removeTrigger(project, name);
      return ok({ removed, project, name });
    } catch (error) {
      return fail(`Error removing trigger: ${errText(error)}`);
    }
  };
}

export function listTriggersHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const triggers = await write.listTriggers(project);
      return ok({ project, count: triggers.length, triggers });
    } catch (error) {
      return fail(`Error listing triggers: ${errText(error)}`);
    }
  };
}

export function runTriggerHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the trigger to run).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const sessionId = await write.runTrigger(project, name);
      if (!sessionId) {
        return fail(
          `Error running trigger “${name}”: no such trigger, or it did not start a chat.`,
        );
      }
      return ok({ ran: true, project, name, sessionId });
    } catch (error) {
      return fail(`Error running trigger: ${errText(error)}`);
    }
  };
}
