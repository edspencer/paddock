import type { ProjectStatus } from "../lib/types";

const STYLES: Record<ProjectStatus, { pill: string; dot: string }> = {
  idea: {
    pill: "bg-paddock-200/70 text-paddock-700 dark:bg-paddock-800 dark:text-paddock-300",
    dot: "bg-paddock-500",
  },
  active: {
    pill: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  paused: {
    pill: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  blocked: {
    pill: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  done: {
    pill: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  abandoned: {
    pill: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    dot: "bg-zinc-400",
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
