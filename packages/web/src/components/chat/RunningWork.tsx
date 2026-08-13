import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  SparkIcon,
  TerminalIcon,
  TreeIcon,
  XIcon,
} from "../icons";
import { Button, Dialog } from "../ui";
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

/**
 * The COMMAND a background shell is running, when we can find it (#853).
 *
 * `t.command` first — it is the field the type has always advertised, so if a
 * future signal ever fills it, it wins over anything we reconstruct. Failing
 * that, the transcript join: `commands` is keyed by the `tool_use_id` the
 * registry folded onto the task (see `useShellCommands`).
 *
 * `undefined` for every other role and for every case where the join comes up
 * empty — no id, no matching call, a launch scrolled out of loaded history — so
 * the caller falls back to exactly what it rendered before.
 */
function commandOf(
  t: LiveBackgroundTask,
  commands?: ReadonlyMap<string, string>,
): string | undefined {
  if (roleOf(t) !== "shell") return undefined;
  const own = t.command?.trim();
  if (own) return own;
  if (!t.toolUseId) return undefined;
  return commands?.get(t.toolUseId)?.trim() || undefined;
}

/** The wide middle column: what this task is actually doing. */
function detailOf(t: LiveBackgroundTask, commands?: ReadonlyMap<string, string>): string {
  const command = commandOf(t, commands);
  if (command) return command;
  if (roleOf(t) === "shell") return t.description;
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

/**
 * A stop the user has asked for but not yet confirmed (#848).
 *
 * Carries the ids to send, so the decision cannot drift onto a different row if
 * the bar's contents change while the dialog is open.
 */
interface PendingStop {
  taskIds: string[];
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * Does stopping this role warrant a confirmation?
 *
 * A background shell is cheap to relaunch, so making the user confirm one is
 * friction with nothing behind it. A sub-agent is not: it may be forty steps in,
 * and the kill CASCADES to everything it started — so the row understates what
 * the click destroys, which is exactly when a confirmation earns its place.
 */
const NEEDS_CONFIRM = (role: string): boolean => role === "subagent";

/**
 * The stop affordance for one row (#848), or nothing when the row cannot offer
 * one. Factored out because the two row shapes — transcript-derived sub-agent
 * and registry task — need an identical button, and a second hand-rolled copy is
 * how the two drift.
 */
function StopButton({
  taskId,
  label,
  stopping,
  failed,
  onStop,
}: {
  taskId: string | undefined;
  label: string;
  stopping: boolean;
  failed: string | undefined;
  /** Already bound to this row; absent when the row cannot be stopped at all. */
  onStop: (() => void) | undefined;
}) {
  // No handler, or no id to name the task by, means no button — rather than one
  // that no-ops. A transcript-derived sub-agent row whose registry twin has not
  // arrived is the real case: there is genuinely nothing to send.
  if (!onStop || !taskId) return null;
  return (
    <button
      type="button"
      onClick={onStop}
      // Held for the round trip, so a double-click cannot send two stops. Note
      // it is NOT disabled after a failure: the task is still running, and
      // retrying is the only thing left to try.
      disabled={stopping}
      data-testid="running-task-cancel"
      data-stop-state={failed ? "failed" : stopping ? "stopping" : "idle"}
      title={failed ? `Could not stop: ${failed}` : `Stop ${label}`}
      aria-label={failed ? `Retry stopping ${label}` : `Stop ${label}`}
      className={`mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
        failed
          ? "text-danger can-hover:hover:bg-danger-soft"
          : "text-fg-subtle can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
      }`}
    >
      <XIcon width={12} height={12} />
    </button>
  );
}

export function RunningWork({
  running,
  activity,
  tasks,
  commands,
  onReveal,
  onCancel,
  stopping,
  stopFailed,
}: {
  running: RunningSubagent[];
  activity: Map<string, SubagentActivity>;
  tasks: LiveBackgroundTask[];
  /**
   * `tool_use_id` → the command a background shell is running, joined from the
   * transcript by `useShellCommands` (#853). Optional so a caller that has no
   * turns to join against — and every existing test — behaves as before.
   */
  commands?: ReadonlyMap<string, string>;
  onReveal: (toolUseId: string) => void;
  /**
   * Ask the server to stop one task by its SDK task id (#848). Optional, and
   * absent hides every stop affordance — better than a button that no-ops. The
   * caller withholds it when there is no session to send the request about.
   */
  onCancel?: (taskId: string) => void;
  /**
   * Task ids with a stop in flight, or accepted and awaiting the SDK's terminal
   * notification. The row is HELD here, not removed: the click is not what
   * removes a row, the notification is — so a refused stop cannot leave the bar
   * claiming work has ended while it is still running.
   */
  stopping?: Set<string>;
  /**
   * Task ids whose stop was REFUSED, mapped to why. These tasks are still
   * running, so the row stays live and the button stays clickable; the failure
   * is shown rather than swallowed, and rather than leaving `stopping…` to hang
   * forever.
   */
  stopFailed?: Map<string, string>;
}) {
  // Sub-agents already on screen via the transcript path — the registry's own
  // row for the same sub-agent would be a duplicate.
  const shownSubagents = new Set(running.map((r) => r.toolUseId));
  // The SDK marks ambient/housekeeping work to be kept out of the inline
  // transcript; honour that here rather than showing chores as user work.
  const visible = tasks.filter((t) => !t.skipTranscript);
  const extra = visible.filter((t) => !(t.toolUseId != null && shownSubagents.has(t.toolUseId)));
  // The registry rows just deduped away are the SAME sub-agents the transcript
  // path is rendering, and they carry the `task_id` a stop needs. Without this
  // the three richest rows in the bar would be the only ones you could not stop.
  // A sub-agent with no twin yet simply gets no button (see {@link StopButton}).
  const taskIdByToolUse = new Map(
    visible.filter((t) => t.toolUseId != null).map((t) => [t.toolUseId!, t]),
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
  /*
   * The pending confirmation, if any (#848). Held as the STOP ITSELF — the ids
   * to send plus the words to say — rather than as a flag plus a separate "what
   * was I confirming" lookup, so a row that leaves the bar mid-dialog cannot
   * re-target the confirm at whatever slid into its place.
   */
  const [confirming, setConfirming] = useState<PendingStop | null>(null);
  /*
   * Drop a pending confirmation when the bar empties. The early return below
   * renders nothing, but it does NOT unmount this component — the parent still
   * renders it — so without this the dialog's state outlives the work it was
   * about, and the next burst of background work would open a stale
   * confirmation for tasks that finished minutes ago.
   */
  useEffect(() => {
    if (total === 0) setConfirming(null);
  }, [total]);
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
        ? detailOf(newestTask, commands) || heading
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

  // Stop all acts on what a stop can actually reach: rows the server says are
  // stoppable, minus those already in flight. Offered only when there is more
  // than one thing to stop — with a single row its own ✕ is right there.
  const stoppableIds = visible
    .filter((t) => t.stoppable !== false && !stopping?.has(t.id))
    .map((t) => t.id);

  /*
   * Route one row's stop through the confirmation policy: shells go straight
   * through, sub-agents ask first. Returns undefined when there is nothing to
   * send, which is what makes the button disappear rather than no-op.
   */
  const stopFor = (taskId: string | undefined, role: string, label: string) => {
    if (!onCancel || !taskId) return undefined;
    return () => {
      if (!NEEDS_CONFIRM(role)) return onCancel(taskId);
      setConfirming({
        taskIds: [taskId],
        title: `Stop ${label}?`,
        // Say the part the row does not: the children go too. A user who has
        // watched a sub-agent fan out has no other way to know that from a ✕.
        body: `This sub-agent and everything it started will be stopped. Work already in progress is lost, and it cannot be resumed from where it got to.`,
        confirmLabel: "Stop sub-agent",
      });
    };
  };

  /*
   * Stop all ALWAYS confirms, whatever is in the bar. It is the one action here
   * that is both destructive and un-aimed — you are agreeing to lose whatever
   * happens to be running, which by definition you have not read row by row.
   */
  const requestStopAll = () => {
    const subagents = visible.filter(
      (t) => stoppableIds.includes(t.id) && roleOf(t) === "subagent",
    ).length;
    setConfirming({
      taskIds: stoppableIds,
      title: "Stop all running work?",
      body:
        `${countOf("task", stoppableIds.length)} will be stopped` +
        (subagents > 0
          ? `, including ${countOf("subagent", subagents)} and everything they started.`
          : ".") +
        " Work already in progress is lost.",
      confirmLabel: "Stop all",
    });
  };

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
          {onCancel && total > 1 && stoppableIds.length > 0 && (
            <button
              type="button"
              // Fires one independent stop per task. Partial failure therefore
              // reads correctly with no extra machinery: each row settles on its
              // own answer, so one refusal shows as one row saying so while the
              // rest leave the bar. An aggregate result would have to round that
              // to "worked" or "failed", and both would be a lie.
              onClick={requestStopAll}
              data-testid="running-work-stop-all"
              title="Stop every running task"
              className="shrink-0 px-3 py-1.5 text-3xs font-semibold uppercase tracking-wide text-fg-subtle transition-colors can-hover:hover:text-danger focus-visible:focus-ring"
            >
              Stop all
            </button>
          )}
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
              // The registry twin is the only thing carrying this sub-agent's
              // SDK task id; absent (or unstoppable), the row gets no button.
              const twin = taskIdByToolUse.get(r.toolUseId);
              const taskId = twin && twin.stoppable !== false ? twin.id : undefined;
              const isStopping = taskId != null && stopping?.has(taskId) === true;
              const failed = taskId != null ? stopFailed?.get(taskId) : undefined;
              const onStop = stopFor(taskId, "subagent", r.label);
              return (
                <li key={r.toolUseId} className="flex items-center">
                  <button
                    type="button"
                    data-testid="running-subagent-row"
                    onClick={() => onReveal(r.toolUseId)}
                    title="Show this sub-agent in the transcript"
                    className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left transition-colors can-hover:hover:bg-accent/10 ${
                      onStop ? "pr-1" : "pr-3"
                    } ${isStopping ? "opacity-50" : ""}`}
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
                      className={`min-w-0 flex-1 truncate font-mono text-2xs ${
                        failed ? "text-danger" : "text-accent/90"
                      }`}
                      title={failed ?? act?.latestStep}
                    >
                      {failed
                        ? "can't stop"
                        : isStopping
                          ? "stopping…"
                          : (act?.latestStep ?? "starting…")}
                    </span>
                    {act != null && act.stepCount > 0 && (
                      <span className="shrink-0 whitespace-nowrap text-3xs tabular-nums text-fg-subtle">
                        {act.stepCount} step{act.stepCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </button>
                  <StopButton
                    taskId={taskId}
                    label={r.label}
                    stopping={isStopping}
                    failed={failed}
                    onStop={onStop}
                  />
                </li>
              );
            })}
            {extra.map((t) => {
              const detail = detailOf(t, commands);
              /*
               * A shell whose command we found shows BOTH: the description (the
               * intent) as a short chip, and the command (the reality) in the
               * wide column — the same shape a sub-agent row already uses for
               * its description + latest step. The gap between the two is the
               * diagnostic: "wait for scan completion" beside a poll of a path
               * that does not exist is what #853 exists to make visible.
               *
               * Only when the join landed. Without it `detail` IS the
               * description, and repeating it beside itself would be noise.
               */
              const intent = commandOf(t, commands) ? t.description.trim() : "";
              // A row is only tappable when we know which card it came from; a
              // background shell launched several turns ago may have no tool_use_id.
              const reveal = t.toolUseId;
              const Row = reveal ? "button" : "div";
              const isStopping = stopping?.has(t.id) === true;
              const failed = stopFailed?.get(t.id);
              // A `monitor_mcp` task has no kill strategy in the CLI, so the
              // server marks it unstoppable and no button is offered — the
              // refusal is predictable, and a button that always fails is worse
              // than none.
              const taskId = t.stoppable !== false ? t.id : undefined;
              const onStop = stopFor(taskId, roleOf(t), labelOf(t));
              return (
                <li key={t.id} className="flex items-center">
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
                    className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left transition-colors ${
                      onStop ? "pr-1" : "pr-3"
                    } ${reveal ? "can-hover:hover:bg-accent/10" : ""} ${
                      isStopping ? "opacity-50" : ""
                    }`}
                  >
                    <TaskIcon role={roleOf(t)} />
                    <span className="shrink-0 whitespace-nowrap font-mono text-2xs font-semibold text-fg">
                      {labelOf(t)}
                    </span>
                    {intent && (
                      <span
                        className="shrink-0 max-w-[10rem] truncate text-2xs text-fg-muted"
                        data-testid="running-task-intent"
                      >
                        {intent}
                      </span>
                    )}
                    <span
                      className={`min-w-0 flex-1 truncate font-mono text-2xs ${
                        failed ? "text-danger" : "text-info"
                      }`}
                      data-testid="running-task-detail"
                      title={failed ?? detail}
                    >
                      {failed ? "can't stop" : isStopping ? "stopping…" : detail || "starting…"}
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
                  <StopButton
                    taskId={taskId}
                    label={labelOf(t)}
                    stopping={isStopping}
                    failed={failed}
                    onStop={onStop}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* #848. `alertdialog` because the action destroys work, and the shared
          primitive because it is the only thing here that traps and restores
          focus — a hand-rolled box would drop a keyboard user at the top of the
          document on cancel. Cancelling calls NOTHING, which is what keeps a
          declined confirmation from leaving a `stopping…` hold behind. */}
      <Dialog
        open={confirming != null}
        onClose={() => setConfirming(null)}
        role="alertdialog"
        size="sm"
        title={confirming?.title ?? ""}
        description={confirming?.body}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Keep running
            </Button>
            <Button
              variant="danger"
              data-testid="running-work-confirm-stop"
              onClick={() => {
                // Snapshot the ids at confirm time — `confirming` is cleared
                // first so a second click cannot fire the same stops twice.
                const ids = confirming?.taskIds ?? [];
                setConfirming(null);
                ids.forEach((id) => onCancel?.(id));
              }}
            >
              {confirming?.confirmLabel ?? "Stop"}
            </Button>
          </>
        }
      />
    </div>
  );
}
