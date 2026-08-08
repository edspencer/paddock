import type { ProjectStatus } from "../lib/types";

const STYLES: Record<ProjectStatus, { pill: string; dot: string; rail: string }> = {
  idea: {
    pill: "bg-surface-active text-fg-muted",
    dot: "bg-fg-muted",
    rail: "border-l-edge-strong",
  },
  active: {
    pill: "bg-success-soft text-success",
    dot: "bg-success-solid",
    rail: "border-l-success-solid",
  },
  paused: {
    pill: "bg-warn-soft text-warn",
    dot: "bg-warn-solid",
    rail: "border-l-warn-solid",
  },
  blocked: {
    pill: "bg-danger-soft text-danger",
    dot: "bg-danger-solid",
    rail: "border-l-danger-solid",
  },
  done: {
    pill: "bg-info-soft text-info",
    dot: "bg-info-solid",
    rail: "border-l-info-solid",
  },
  abandoned: {
    pill: "bg-surface-active text-fg-subtle",
    dot: "bg-fg-subtle",
    // The one status with no signal: it is not a state you act on, so it gets
    // no rail rather than a muted one. Absence is the correct encoding here.
    rail: "border-l-transparent",
  },
};

/**
 * The status as a left RAIL rather than a pill — the same grammar the transcript
 * and the Home feeds use, so a grid of project cards can be scanned by colour
 * down its left edge instead of read pill by pill. Lives beside `STYLES` so the
 * two can never drift.
 */
export function statusRail(status: ProjectStatus): string {
  return (STYLES[status] ?? STYLES.idea).rail;
}

export function StatusPill({ status }: { status: ProjectStatus }) {
  const s = STYLES[status] ?? STYLES.idea;
  return (
    <span className={`status-pill ${s.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  );
}
