import { useMemo } from "react";
import type { ToolCall } from "../../lib/ws";

/**
 * The COMMAND behind each background shell, keyed by the `tool_use_id` that
 * launched it — recovered from the transcript the client already has (#853).
 *
 * ## Why a join, and not a field on the wire
 *
 * The registry's level signal (`background_tasks_changed`) carries exactly
 * `task_id`, `task_type` and `description` — the agent's statement of INTENT.
 * The command it actually ran is never on that wire, and cannot be put there
 * from here: the signal is emitted by Anthropic's `claude` binary and forwarded
 * verbatim, so `LiveBackgroundTask.command` has a type but no producer.
 *
 * That matters because a description is not a substitute. The case that
 * produced #853 was fifteen hour-old shells reading `wait for scan completion`,
 * `block until scan done`, `final wait for scan` — each a true statement of
 * intent, and all fifteen in fact polling a path that did not exist, with
 * `2>/dev/null` swallowing the error. One glance at the command says so; no
 * amount of reading the descriptions can.
 *
 * Both halves of the join are, however, already on the client:
 *
 *  - **The key.** `BackgroundRegistry` folds `tool_use_id` from `task_started` /
 *    `task_progress` onto each task, so `LiveBackgroundTask.toolUseId` names the
 *    tool call that launched it.
 *  - **The value.** `getToolInputSummary("Bash", input)` in `@herdctl/core`
 *    returns the command itself (truncated at 200 chars), so `inputSummary` on a
 *    Bash tool call IS the command — the same string the tool card in the
 *    transcript already renders, which is why this adds no exposure that a
 *    secret-bearing command did not already have.
 *
 * So this walks the SAME turn list the transcript renders, exactly as
 * {@link import("./useSubagentActivity").useRunningSubagents} does, and hands
 * the bar a lookup. No SDK change, no herdctl change, no new frame.
 *
 * ## The live turn is covered too
 *
 * `ToolCall.toolUseId` was documented as history-only. It is not (and #853 asked
 * for that to be checked rather than believed): `chat:tool_start` and
 * `chat:tool_call` have both carried `toolUseId` since #175, which needs it to
 * reconcile a pending row into its completion. So a shell launched in the
 * CURRENT turn joins as soon as its `chat:tool_start` lands — the command shows
 * up live, not only after a reload.
 *
 * ## Degradation
 *
 * A missing id, a launch scrolled out of loaded history, or a Bash call whose
 * summary is empty simply yields no entry, and the bar renders that row exactly
 * as it does today. Never a blank row, never half a command.
 */
export function useShellCommands(
  turns: Array<{ kind: string; tool?: ToolCall }>,
): ReadonlyMap<string, string> {
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const t of turns) {
      const tool = t.kind === "tool" ? t.tool : undefined;
      if (!tool?.toolUseId) continue;
      // Both spellings, because `getToolInputSummary` accepts both and the
      // command is only the command for a Bash call — a Read's summary is a
      // file path, and showing that as "the command" would be a lie.
      if (tool.toolName !== "Bash" && tool.toolName !== "bash") continue;
      const command = tool.inputSummary?.trim();
      if (!command) continue;
      out.set(tool.toolUseId, command);
    }
    return out;
  }, [turns]);
}
