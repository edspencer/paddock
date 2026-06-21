import type { ProjectStatus } from "../lib/types";

const STYLES: Record<ProjectStatus, string> = {
  idea: "bg-paddock-200 text-paddock-700 dark:bg-paddock-800 dark:text-paddock-300",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  blocked: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
  done: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
  abandoned: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export function StatusPill({ status }: { status: ProjectStatus }) {
  return <span className={`status-pill ${STYLES[status]}`}>{status}</span>;
}
