import { useEffect, useState } from "react";
import { ClockIcon, SparkIcon, TerminalIcon, TreeIcon } from "../icons";
import { formatElapsed } from "../../lib/format";
import type { LiveBackgroundTask } from "../../lib/types";
import type { RunningSubagent, SubagentActivity } from "./useSubagentActivity";

/**
 * A live line item per piece of RUNNING background work, docked just above the
 * composer.
 *
 * The problem it solves: work can outlive the turn that started it and the card
 * that launched it can be scrolled far up the transcript, so there is nowhere to
 * look to find out whether anything is still happening. This bar names each
 * running thing and what it is doing right now.
 *
 * It merges two sources, deliberately:
 *
 *  - **Sub-agents** come from the transcript-derived path (`useRunningSubagents`
 *    + `useSubagentActivity`), unchanged. That path has richer per-step detail
 *    than the SDK's task signals expose, and it is already covered by tests, so
 *    this generalisation does not disturb it.
 *  - **Everything else** — background shells, monitors, workflows — comes from
 *    the server's live background-task registry (#604), which is the first time
 *    any of them have had liveness at all. Before this, a background `Bash` or a
 *    `Monitor` rendered a static "running" chip that meant only "no completion
 *    notification was found in the transcript".
 *
 * A `subagent` task from the registry is dropped when the transcript path is
 * already showing it (matched on `toolUseId`), so the two sources cannot
 * double-render the same sub-agent. One the transcript path has not found still
 * appears, which is what makes a reload mid-run honest.
 *
 * Renders nothing when nothing is running, so an ordinary turn is unchanged.
 *
 * Takes its data as PROPS rather than through the sub-agent contexts: it is
 * docked above the composer, outside the scrolling transcript those wrap.
 */

/** A one-second tick, live only while something is actually running. */
function useSecondsTick(live: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
}

/** Icon per task kind. Unknown kinds get the neutral clock rather than nothing. */
function TaskIcon({ type }: { type: string }) {
  const cls = "shrink-0 text-info";
  if (type === "shell") return <TerminalIcon width={12} height={12} className={cls} />;
  if (type === "workflow") return <TreeIcon width={12} height={12} className={cls} />;
  if (type === "subagent")
    return <SparkIcon width={12} height={12} className="shrink-0 text-accent" />;
  return <ClockIcon width={12} height={12} className={cls} />;
}

/** The short bold label at the head of a row. */
function labelOf(t: LiveBackgroundTask): string {
  if (t.type === "subagent") return t.agentType ?? "sub-agent";
  if (t.type === "workflow") return t.workflowName ?? "workflow";
  if (t.type === "monitor") return t.tool ?? "monitor";
  return t.type;
}

/** The wide middle column: what this task is actually doing. */
function detailOf(t: LiveBackgroundTask): string {
  if (t.type === "shell") return t.command ?? t.description;
  if (t.lastToolName) return t.lastToolName;
  return t.description;
}

export function RunningWork({
  running,
  activity,
  tasks,
  onReveal,
}: {
  running: RunningSubagent[];
  activity: Map<string, SubagentActivity>;
  tasks: LiveBackgroundTask[];
  onReveal: (toolUseId: string) => void;
}) {
  // Sub-agents already on screen via the transcript path — the registry's own
  // row for the same sub-agent would be a duplicate.
  const shownSubagents = new Set(running.map((r) => r.toolUseId));
  const extra = tasks.filter(
    (t) =>
      // The SDK marks ambient/housekeeping work to be kept out of the inline
      // transcript; honour that here rather than showing chores as user work.
      !t.skipTranscript && !(t.toolUseId != null && shownSubagents.has(t.toolUseId)),
  );
  const total = running.length + extra.length;
  useSecondsTick(total > 0);
  if (total === 0) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4" data-testid="running-work">
      <div className="mb-2 overflow-hidden rounded-lg border border-accent-edge bg-accent-soft">
        <div className="flex items-center gap-1.5 border-b border-accent/20 px-3 py-1.5">
          <span
            className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
            aria-hidden="true"
          />
          <span className="text-3xs font-semibold uppercase tracking-wide text-accent">
            {/* Stay specific when there is only one kind of work — "2 sub-agents
                running" says more than "2 things running". Only a genuinely
                mixed bar falls back to the generic noun. */}
            {extra.length === 0
              ? `${total} sub-agent${total === 1 ? "" : "s"} running`
              : `${total} ${total === 1 ? "thing" : "things"} running`}
          </span>
        </div>
        <ul className="divide-y divide-accent/15">
          {running.map((r) => {
            const act = activity.get(r.toolUseId);
            return (
              <li key={r.toolUseId}>
                <button
                  type="button"
                  data-testid="running-subagent-row"
                  onClick={() => onReveal(r.toolUseId)}
                  title="Show this sub-agent in the transcript"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors can-hover:hover:bg-accent/10"
                >
                  <SparkIcon width={12} height={12} className="shrink-0 text-accent" />
                  <span className="shrink-0 whitespace-nowrap font-mono text-2xs font-semibold text-fg">
                    {r.label}
                  </span>
                  {r.description && (
                    <span className="shrink-0 max-w-[10rem] truncate text-2xs text-fg-muted">
                      {r.description}
                    </span>
                  )}
                  {/* The live bit: what it is doing right now. */}
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-2xs text-accent/90"
                    title={act?.latestStep}
                  >
                    {act?.latestStep ?? "starting…"}
                  </span>
                  {act != null && act.stepCount > 0 && (
                    <span className="shrink-0 whitespace-nowrap text-3xs tabular-nums text-fg-subtle">
                      {act.stepCount} step{act.stepCount === 1 ? "" : "s"}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {extra.map((t) => {
            const detail = detailOf(t);
            // A row is only tappable when we know which card it came from; a
            // background shell launched several turns ago may have no tool_use_id.
            const reveal = t.toolUseId;
            const Row = reveal ? "button" : "div";
            return (
              <li key={t.id}>
                <Row
                  {...(reveal
                    ? {
                        type: "button" as const,
                        onClick: () => onReveal(reveal),
                        title: "Show this task in the transcript",
                      }
                    : {})}
                  data-testid="running-task-row"
                  data-task-type={t.type}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    reveal ? "can-hover:hover:bg-accent/10" : ""
                  }`}
                >
                  <TaskIcon type={t.type} />
                  <span className="shrink-0 whitespace-nowrap font-mono text-2xs font-semibold text-fg">
                    {labelOf(t)}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-2xs text-info"
                    title={detail}
                  >
                    {detail || "starting…"}
                  </span>
                  {t.toolUses != null && t.toolUses > 0 && (
                    <span className="shrink-0 whitespace-nowrap text-3xs tabular-nums text-fg-subtle">
                      {t.toolUses} step{t.toolUses === 1 ? "" : "s"}
                    </span>
                  )}
                  <span
                    className="shrink-0 whitespace-nowrap text-3xs tabular-nums text-fg-subtle"
                    data-testid="running-task-elapsed"
                  >
                    {formatElapsed(Date.now() - t.startedAt)}
                  </span>
                </Row>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
