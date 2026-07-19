/**
 * Background-job & Monitor enrichment — issue #230.
 *
 * Keepers launch a lot of *detached* work: background `Bash`
 * (`run_in_background:true`), `Monitor` event streams, and the background-task
 * ops (`BashOutput`/`TaskOutput`/`TaskStop`/`KillShell`). herdctl's parser
 * renders each as a plain tool call, identical to a synchronous `Read`, and the
 * eventual result arrives *separately* as a `<task-notification>` (surfaced by
 * herdctl #363 as `origin.kind:"task-notification"`) that the web draws as a
 * disconnected status pill.
 *
 * This pass reconnects the two. Everything needed is already in the parsed
 * messages — no raw-JSONL re-scan, no positional id recovery — because the
 * **task id** appears on both sides:
 *
 *   launch output  →  bg Bash:  "Command running in background with ID: <id>…"
 *                     Monitor:  "Monitor started (task <id>, timeout …| persistent …)"
 *   notification   →  <task-id><id></task-id> + <status>/<summary>/<event>
 *
 * We flag background tool calls, fold the matching notification(s) into the
 * launching `toolCall` (final status + completion summary for bg Bash; the
 * streamed `<event>` lines for Monitor), and mark the consumed notification
 * messages so the web no longer scatters them as standalone pills.
 *
 * Pure and synchronous — composes after {@link enrichWithSubagents} over the same
 * `EnrichedMessage[]`. No herdctl change.
 */
import type { EnrichedMessage, EnrichedToolCall } from "./subagents.js";
import { isTerminatedTaskStatus } from "./recovery-config.js";

/** Background-task *ops* — badge only (they operate on an already-detached task). */
const BACKGROUND_OP_NAMES = new Set(["BashOutput", "TaskOutput", "TaskStop", "KillShell"]);

/** bg `Bash` (and any tool) launch: "…running in background with ID: <id>…". */
const BG_LAUNCH_RE = /running in (?:the )?background with ID: ([A-Za-z0-9]+)/i;
/** `Monitor` launch: "Monitor started (task <id>, timeout … | persistent …)". */
const MONITOR_LAUNCH_RE = /^Monitor started \(task ([A-Za-z0-9]+)/;
/** `TaskStop` result: {"message":"Successfully stopped task: <id> (…)"}. */
const STOPPED_TASK_RE = /stopped task:\s*([A-Za-z0-9]+)/i;

type LaunchKind = "monitor" | "bash";
interface Launch {
  taskId: string;
  kind: LaunchKind;
}

/** Identify a background *launch* (Monitor / bg Bash) and its task id, else null. */
function detectLaunch(tc: EnrichedToolCall): Launch | null {
  const output = tc.output ?? "";
  if (tc.toolName === "Monitor") {
    const m = MONITOR_LAUNCH_RE.exec(output);
    if (m) return { taskId: m[1], kind: "monitor" };
    // A Monitor whose start was denied/errored has no task — still background.
    return null;
  }
  const m = BG_LAUNCH_RE.exec(output);
  if (m) return { taskId: m[1], kind: "bash" };
  return null;
}

/** Cheap gate: does this transcript contain any background-class tool call? */
function hasBackgroundTool(messages: EnrichedMessage[]): boolean {
  return messages.some((m) => {
    const tc = m.toolCall;
    if (!tc) return false;
    return (
      tc.toolName === "Monitor" ||
      BACKGROUND_OP_NAMES.has(tc.toolName) ||
      BG_LAUNCH_RE.test(tc.output ?? "")
    );
  });
}

const tag = (content: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content);
  const v = m?.[1]?.trim();
  return v && v.length ? v : undefined;
};

/** True when a `role:"user"` message is an internal `<task-notification>` block. */
function isTaskNotification(m: EnrichedMessage): boolean {
  return (
    m.origin?.kind === "task-notification" ||
    (m.role === "user" && m.content.trimStart().startsWith("<task-notification>"))
  );
}

interface TaskAgg {
  events: string[];
  status?: string;
  completionSummary?: string;
}

/**
 * Enrich background tool calls: flag them, parse task ids from launch outputs,
 * index task-notifications by task id, fold status/summary/events into the
 * launching `toolCall`, and mark the folded notification messages `bgConsumed`.
 * Non-background tool calls and notification-free transcripts pass through
 * unchanged (cheap early return).
 */
export function enrichWithBackground(messages: EnrichedMessage[]): EnrichedMessage[] {
  if (!hasBackgroundTool(messages)) return messages;

  // Pass 1 — index every task-notification by its task id.
  const byTask = new Map<string, TaskAgg>();
  for (const m of messages) {
    if (!isTaskNotification(m)) continue;
    const taskId = tag(m.content, "task-id");
    if (!taskId) continue;
    let agg = byTask.get(taskId);
    if (!agg) {
      agg = { events: [] };
      byTask.set(taskId, agg);
    }
    const event = tag(m.content, "event");
    if (event !== undefined) agg.events.push(event);
    const status = tag(m.content, "status");
    if (status) {
      agg.status = status;
      agg.completionSummary = tag(m.content, "summary");
    }
  }

  // Pass 2 — attach to each background launch; collect the consumed task ids.
  const consumed = new Set<string>();
  const attached = messages.map((m): EnrichedMessage => {
    const tc = m.toolCall;
    if (!tc) return m;
    const launch = detectLaunch(tc);
    if (launch) {
      const agg = byTask.get(launch.taskId);
      const next: EnrichedToolCall = { ...tc, background: true, taskId: launch.taskId };
      if (launch.kind === "monitor") {
        if (agg?.events.length) next.monitorEvents = agg.events;
        // A Monitor rarely gets an explicit <status>; it ends with a timeout
        // *event* ("[Monitor timed out …]") or runs until TaskStop / session end.
        const timedOut = agg?.events.some((e) => /monitor timed out/i.test(e));
        next.taskStatus =
          agg?.status ??
          (timedOut ? "timed out" : /persistent/.test(tc.output ?? "") ? "persistent" : "running");
      } else {
        next.taskStatus = agg?.status ?? "running";
        if (agg?.completionSummary) next.taskResultSummary = agg.completionSummary;
      }
      if (agg) consumed.add(launch.taskId);
      return { ...m, toolCall: next };
    }
    if (BACKGROUND_OP_NAMES.has(tc.toolName)) {
      // A background-task op — badge only. Recover a task id where cheap (TaskStop).
      const stopped = STOPPED_TASK_RE.exec(tc.output ?? "");
      return {
        ...m,
        toolCall: { ...tc, background: true, ...(stopped ? { taskId: stopped[1] } : {}) },
      };
    }
    return m;
  });

  if (consumed.size === 0) return attached;

  // Pass 3 — mark folded notifications so the web drops the standalone pill.
  // EXCEPTION (issue #301, Layer 2): a KILLED/STOPPED notification is NEVER folded
  // away, even when its task id matches a launch. That's the turn-boundary-kill
  // case (edspencer/herdctl#374) — the keeper is left alive-but-idle — and it must
  // surface as a prominent standalone affordance ("keeper is idle" + Continue),
  // not be reduced to a small "killed" chip on a scrolled-away tool block. The
  // chip STILL renders (Pass 2 folded the status onto the launch); this only keeps
  // the standalone notification turn alive so the recovery UI has something to hang.
  return attached.map((m): EnrichedMessage => {
    if (!isTaskNotification(m)) return m;
    const taskId = tag(m.content, "task-id");
    if (!taskId || !consumed.has(taskId)) return m;
    if (isTerminatedTaskStatus(tag(m.content, "status"))) return m;
    return { ...m, bgConsumed: true };
  });
}
