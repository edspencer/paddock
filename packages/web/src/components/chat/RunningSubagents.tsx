import { SparkIcon } from "../icons";
import type { RunningSubagent, SubagentActivity } from "./useSubagentActivity";

/**
 * A live line item per RUNNING sub-agent, sitting just above the composer.
 *
 * The problem it solves: a sub-agent can work for minutes behind a collapsed card
 * that shows a cost and a duration but gives no sense of progress — and the card
 * may be scrolled far up the transcript, so there is nowhere to look. Each row
 * here names the sub-agent and its LATEST step, updating as it works, and tapping
 * one scrolls its card into view, expands it, and flashes it.
 *
 * Renders nothing when no sub-agent is running, so an ordinary turn is unchanged.
 *
 * Takes its data as PROPS rather than through the sub-agent contexts: it is docked
 * above the composer, outside the scrolling transcript those providers wrap.
 */
export function RunningSubagents({
  running,
  activity,
  onReveal,
}: {
  running: RunningSubagent[];
  activity: Map<string, SubagentActivity>;
  onReveal: (toolUseId: string) => void;
}) {
  if (running.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4" data-testid="running-subagents">
      <div className="mb-2 overflow-hidden rounded-lg border border-accent-edge bg-accent-soft">
        <div className="flex items-center gap-1.5 border-b border-accent/20 px-3 py-1.5">
          <span
            className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
            aria-hidden="true"
          />
          <span className="text-3xs eyebrow text-accent">
            {running.length} sub-agent{running.length === 1 ? "" : "s"} running
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
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/10"
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
        </ul>
      </div>
    </div>
  );
}
