import type { LiveBackgroundTask } from "../lib/types";
import { taskSummary } from "./chat/RunningWork";
import { Tooltip } from "./Tooltip";
import { ClockIcon } from "./icons";

/**
 * The chats that are idle but still have background work running (#604): in the
 * running set, out of the turn set. sessionId -> that chat's live tasks, which
 * can be momentarily empty — `running` and the task list arrive on separate
 * frames, and the mark trusts `running`.
 */
export function idleBackgroundWork(
  running: ReadonlySet<string>,
  turns: ReadonlySet<string>,
  tasks: ReadonlyMap<string, LiveBackgroundTask[]>,
): ReadonlyMap<string, LiveBackgroundTask[]> {
  const out = new Map<string, LiveBackgroundTask[]>();
  for (const id of running) if (!turns.has(id)) out.set(id, tasks.get(id) ?? []);
  return out;
}

/** The mark's tooltip and accessible name. */
export function backgroundWorkLabel(tasks: LiveBackgroundTask[]): string {
  if (tasks.length === 0) return "Idle, but background work running";
  const n = tasks.length;
  return `Idle, but ${n} background task${n === 1 ? "" : "s"} running: ${tasks
    .map(taskSummary)
    .join(", ")}`;
}

/**
 * A chat whose turn has ended but whose background work has not: a clock and
 * the task count, in the info tone the running-work bar gives its rows.
 *
 * Deliberately still. The spinning context ring means a model turn is in
 * flight; this state can last an hour (a `Monitor`), and a chat list is on
 * screen all the time, so anything moving here would be moving for that hour
 * (docs/DESIGN.md, Motion). The count changing is the only motion.
 */
export function BackgroundWorkMark({
  tasks,
  size = 11,
}: {
  tasks: LiveBackgroundTask[];
  size?: number;
}) {
  const label = backgroundWorkLabel(tasks);
  return (
    <Tooltip content={label} className="shrink-0">
      <span
        data-background-work={tasks.length}
        role="img"
        aria-label={label}
        className="inline-flex shrink-0 items-center gap-0.5 text-info"
      >
        <ClockIcon width={size} height={size} />
        {tasks.length > 0 && (
          <span className="text-3xs font-medium tabular-nums leading-none">{tasks.length}</span>
        )}
      </span>
    </Tooltip>
  );
}
