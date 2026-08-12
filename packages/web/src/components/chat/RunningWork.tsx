import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  SparkIcon,
  TerminalIcon,
  TreeIcon,
} from "../icons";
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

/**
 * Above this many rows the bar starts collapsed.
 *
 * Four rows is roughly the height of the composer the bar docks above, which is
 * the actual constraint — past that the bar starts eating the conversation.
 */
const AUTO_COLLAPSE_ABOVE = 4;

/** A one-second tick, live only while something is actually running. */
function useSecondsTick(live: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
}

/**
 * The role to render this task as.
 *
 * The server maps the SDK's internal discriminant (`local_bash`, `local_agent`,
 * …) to a role at the registry boundary (#846) — that mapping is deliberately
 * NOT duplicated here, so there is one place to change when the SDK adds a kind.
 * The fallback to the raw `type` covers a stale cached SPA against a server that
 * predates `role`: those rows render exactly as they did before, rather than
 * every row going blank.
 */
const roleOf = (t: LiveBackgroundTask): string => t.role ?? t.type;

/** Icon per task role. Unknown roles get the neutral clock rather than nothing. */
function TaskIcon({ role }: { role: string }) {
  const cls = "shrink-0 text-info";
  if (role === "shell") return <TerminalIcon width={12} height={12} className={cls} />;
  if (role === "workflow") return <TreeIcon width={12} height={12} className={cls} />;
  if (role === "subagent")
    return <SparkIcon width={12} height={12} className="shrink-0 text-accent" />;
  return <ClockIcon width={12} height={12} className={cls} />;
}

/** The short bold label at the head of a row. */
function labelOf(t: LiveBackgroundTask): string {
  const role = roleOf(t);
  if (role === "subagent") return t.agentType ?? "sub-agent";
  if (role === "workflow") return t.workflowName ?? "workflow";
  if (role === "monitor") return t.tool ?? "monitor";
  return role;
}

/** The wide middle column: what this task is actually doing. */
function detailOf(t: LiveBackgroundTask): string {
  if (roleOf(t) === "shell") return t.command ?? t.description;
  if (t.lastToolName) return t.lastToolName;
  return t.description;
}

/**
 * Human noun per role, for counting. Absent for a role we do not recognise —
 * callers fall back to the generic "things", because inventing a noun for a kind
 * we have never seen is how "15 local_bashs running" happens.
 */
const ROLE_NOUNS: Record<string, string> = {
  subagent: "sub-agent",
  shell: "shell",
  monitor: "monitor",
  workflow: "workflow",
  task: "task",
};

/** `6 sub-agents` / `1 monitor`. Unknown roles are counted but not pluralised. */
function countOf(role: string, n: number): string {
  const noun = ROLE_NOUNS[role];
  return noun ? `${n} ${noun}${n === 1 ? "" : "s"}` : `${n} ${role}`;
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

  /*
   * Collapse (#847). Fifteen rows is a wall — taller than the composer it docks
   * above — so a big fan-out pushes the conversation off screen at exactly the
   * moment you want to read it.
   *
   * The state is decided ONCE per APPEARANCE of the bar and never reactively: a
   * bar that collapsed itself as work arrived would move the ground under a
   * click. Re-arming when the bar empties is a small extension of the issue's
   * "decided once at first render" — without it the very first burst of work in
   * a chat decides for the whole session, so a chat that starts with two
   * sub-agents would later render a fifteen-shell fan-out fully expanded, which
   * is the wall this exists to prevent. An empty bar is not on screen, so
   * re-deciding cannot move anything under the pointer.
   */
  const [collapsed, setCollapsed] = useState(() => total > AUTO_COLLAPSE_ABOVE);
  const barWasEmpty = useRef(total === 0);
  useLayoutEffect(() => {
    if (total === 0) barWasEmpty.current = true;
    else if (barWasEmpty.current) {
      barWasEmpty.current = false;
      setCollapsed(total > AUTO_COLLAPSE_ABOVE);
    }
    // Laid out before paint so a re-armed bar never flashes fifteen rows first.
  }, [total]);

  const panelId = useId();
  useSecondsTick(total > 0);
  if (total === 0) return null;

  /*
   * Counts by role, which drive both the header noun and the collapsed line.
   * Transcript-path rows are always sub-agents; registry rows carry their own.
   */
  const byRole = new Map<string, number>();
  if (running.length) byRole.set("subagent", running.length);
  for (const t of extra) {
    const role = roleOf(t);
    byRole.set(role, (byRole.get(role) ?? 0) + 1);
  }
  const mix = [...byRole.entries()].sort((a, b) => b[1] - a[1]);
  // Name the kind when the bar is homogeneous — "15 shells running" says more
  // than "15 things running". A mixed bar, or one whose single kind we have no
  // noun for, falls back to the generic count.
  const soleRole = mix.length === 1 && ROLE_NOUNS[mix[0][0]] ? mix[0][0] : null;
  const heading = soleRole
    ? `${countOf(soleRole, total)} running`
    : `${total} ${total === 1 ? "thing" : "things"} running`;

  /*
   * The collapsed line, which must not simply restate the header. A mixed bar
   * shows the mix; a homogeneous one shows what the NEWEST thing is doing, since
   * the header has already named the kind.
   */
  const newestTask = extra.reduce<LiveBackgroundTask | null>(
    (acc, t) => (acc == null || t.startedAt > acc.startedAt ? t : acc),
    null,
  );
  const newestSubagent = running.length ? running[running.length - 1] : null;
  const summary =
    mix.length > 1
      ? mix.map(([role, n]) => countOf(role, n)).join(" · ")
      : newestTask
        ? detailOf(newestTask) || heading
        : newestSubagent
          ? (activity.get(newestSubagent.toolUseId)?.latestStep ?? newestSubagent.label)
          : heading;
  // Only registry rows carry a start time; the transcript path has none. This is
  // the number that tells you something is wedged rather than merely slow.
  const oldest = extra.reduce<number | null>(
    (acc, t) => (acc == null || t.startedAt < acc ? t.startedAt : acc),
    null,
  );
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;

  return (
    <div className="mx-auto w-full max-w-3xl px-4" data-testid="running-work">
      <div className="mb-2 overflow-hidden rounded-lg border border-accent-edge bg-accent-soft">
        {/* A flex row rather than a bare button so a header action (#848's "stop
            all") can sit beside the toggle — a button inside a button is not
            valid HTML, which is why the whole header cannot simply be one. */}
        <div className="flex items-center border-b border-accent/20">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-controls={panelId}
            data-testid="running-work-toggle"
            title={collapsed ? "Show each running item" : "Collapse to a summary"}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left transition-colors can-hover:hover:bg-accent/10 focus-visible:focus-ring"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-3xs font-semibold uppercase tracking-wide text-accent">
              {heading}
            </span>
            <Chevron
              width={12}
              height={12}
              aria-hidden="true"
              className="ml-auto shrink-0 text-accent/70"
            />
          </button>
        </div>

        {collapsed ? (
          <div
            id={panelId}
            className="flex items-center gap-2 px-3 py-1.5"
            data-testid="running-work-summary"
          >
            <ClockIcon width={12} height={12} aria-hidden="true" className="shrink-0 text-info" />
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-info" title={summary}>
              {summary}
            </span>
            {oldest != null && (
              <span className="shrink-0 whitespace-nowrap text-3xs tabular-nums text-fg-subtle">
                oldest {formatElapsed(Date.now() - oldest)}
              </span>
            )}
          </div>
        ) : (
          <ul id={panelId} className="divide-y divide-accent/15">
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
                    <TaskIcon role={roleOf(t)} />
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
        )}
      </div>
    </div>
  );
}
