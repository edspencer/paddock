import type { ProjectStatus } from "../lib/types";

const STYLES: Record<ProjectStatus, { pill: string; dot: string }> = {
  idea: {
    pill: "bg-surface-active text-fg-muted",
    dot: "bg-fg-muted",
  },
  active: {
    pill: "bg-success-soft text-success",
    dot: "bg-success-solid",
  },
  paused: {
    pill: "bg-warn-soft text-warn",
    dot: "bg-warn-solid",
  },
  blocked: {
    pill: "bg-danger-soft text-danger",
    dot: "bg-danger-solid",
  },
  done: {
    pill: "bg-info-soft text-info",
    dot: "bg-info-solid",
  },
  abandoned: {
    pill: "bg-surface-active text-fg-subtle",
    dot: "bg-fg-subtle",
  },
};

export function StatusPill({ status }: { status: ProjectStatus }) {
  const s = STYLES[status] ?? STYLES.idea;
  return (
    <span className={`status-pill ${s.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  );
}
