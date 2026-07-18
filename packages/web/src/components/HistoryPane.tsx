// The per-project "History" panel — the "while you were away" run-history view
// (#268 / E3 / DD-6). Lists recent herdctl runs joined with their provenance so
// the unattended ones (scheduled + spawned) stand out, with status, duration,
// what triggered them, and a link into the chat. A since-last-visit banner +
// per-row highlight surface what ran while you weren't watching.
//
// Data comes from GET /api/projects/:slug/runs (see lib/useProjectRuns); the
// parent (ProjectView) owns the fetch so the tab badge can render the new-run
// count without opening the tab. Cost is a P3 seam (DD-4 / X1#378 + X2#271) —
// the column is present but always "—" until per-run accounting lands.
import { useEffect, useMemo, useState } from "react";
import type { Chat, RunSummary } from "../lib/types";
import type { ProjectRunsState } from "../lib/useProjectRuns";
import { relativeTime, formatDuration } from "../lib/format";
import { BranchIcon, ClockIcon, ChatIcon } from "./icons";

export interface HistoryPaneProps {
  slug: string;
  /** Shared run-history state (owned by ProjectView for the tab badge). */
  state: ProjectRunsState;
  /** The project's chats, for resolving a run's session → chat title. */
  chats: Chat[];
  /** Open a run's chat (project chat route). */
  onOpenChat: (sessionId: string) => void;
}

type OriginFilter = "unattended" | "all";

/** Origin → label + color language (mirrors the ProvenanceBadge palette). */
function originMeta(origin: RunSummary["origin"]): {
  label: string;
  icon: React.ReactNode;
  cls: string;
} {
  if (origin === "scheduled")
    return {
      label: "Scheduled",
      icon: <ClockIcon width={12} height={12} />,
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
    };
  if (origin === "spawned")
    return {
      label: "Spawned",
      icon: <BranchIcon width={12} height={12} />,
      cls: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-400",
    };
  return {
    label: "You",
    icon: <ChatIcon width={12} height={12} />,
    cls: "bg-paddock-200/70 text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300",
  };
}

/** Status → short color-coded chip. */
function statusMeta(status: RunSummary["status"]): { label: string; cls: string } {
  switch (status) {
    case "completed":
      return { label: "completed", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400" };
    case "failed":
      return { label: "failed", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400" };
    case "running":
      return { label: "running", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400" };
    case "cancelled":
      return { label: "cancelled", cls: "bg-paddock-200/70 text-paddock-500 dark:bg-paddock-800 dark:text-paddock-400" };
    case "pending":
      return { label: "pending", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400" };
    default:
      return { label: status, cls: "bg-paddock-200/70 text-paddock-500 dark:bg-paddock-800 dark:text-paddock-400" };
  }
}

/** Human duration for a run: server seconds when finished, else live elapsed. */
function runDuration(run: RunSummary): string {
  if (run.durationSeconds != null) return formatDuration(run.durationSeconds * 1000) ?? "—";
  if (run.status === "running") {
    const started = Date.parse(run.startedAt);
    if (Number.isFinite(started)) return `${formatDuration(Date.now() - started) ?? "—"}…`;
  }
  return "—";
}

/** What triggered the run, secondary line: schedule name / parent / trigger. */
function triggerNote(run: RunSummary): string {
  if (run.origin === "scheduled") return run.schedule ? `schedule · ${run.schedule}` : "schedule";
  if (run.origin === "spawned")
    return run.depth > 1 ? `spawned · ${run.depth} levels deep` : "spawned by another chat";
  return "you";
}

function RunRow({
  run,
  title,
  onOpen,
}: {
  run: RunSummary;
  title: string;
  onOpen: () => void;
}) {
  const origin = originMeta(run.origin);
  const status = statusMeta(run.status);
  const clickable = run.sessionId != null;
  const label = run.prompt?.trim() || run.summary?.trim() || title;
  return (
    <button
      type="button"
      onClick={clickable ? onOpen : undefined}
      disabled={!clickable}
      data-run-origin={run.origin}
      data-run-new={run.isNew ? "true" : undefined}
      className={`flex w-full items-start gap-3 border-t border-paddock-200 px-4 py-3 text-left first:border-t-0 dark:border-paddock-800 ${
        clickable ? "hover:bg-paddock-100/70 dark:hover:bg-paddock-900/40" : "cursor-default"
      } ${run.isNew ? "bg-accent/[0.06]" : ""}`}
    >
      {/* since-last-visit dot */}
      <span className="mt-1.5 w-1.5 shrink-0">
        {run.isNew && (
          <span
            data-run-unread="true"
            aria-label="New since your last visit"
            title="Ran while you were away"
            className="block h-1.5 w-1.5 rounded-full bg-accent"
          />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${origin.cls}`}
          >
            {origin.icon}
            {origin.label}
          </span>
          <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${status.cls}`}>
            {status.label}
          </span>
        </div>
        <p className="mt-1 truncate text-sm text-ink dark:text-ink-dark">{label}</p>
        <p className="mt-0.5 truncate text-xs text-paddock-500 dark:text-paddock-400">
          {triggerNote(run)}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-paddock-500 dark:text-paddock-400">
        <span title={new Date(run.startedAt).toLocaleString()}>{relativeTime(run.startedAt)}</span>
        <span className="font-mono">{runDuration(run)}</span>
        {/* Cost — P3 seam (DD-4 / X1#378 + X2#271): always em-dash for now. */}
        <span className="font-mono text-paddock-400 dark:text-paddock-600" title="Per-run cost is coming soon">
          —
        </span>
      </div>
    </button>
  );
}

export function HistoryPane({ slug, state, chats, onOpenChat }: HistoryPaneProps) {
  const { data, loading, error, refresh, markSeen } = state;
  const [filter, setFilter] = useState<OriginFilter>("unattended");

  // Opening the tab clears the badge: advance the watermark once per mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void markSeen();
  }, [slug]);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of chats) m.set(c.sessionId, c.name);
    return (sessionId: string | null) =>
      (sessionId && m.get(sessionId)) || (sessionId ? sessionId.slice(0, 8) : "unknown chat");
  }, [chats]);

  const runs = data?.runs ?? [];
  const unattendedCount = useMemo(
    () => runs.filter((r) => r.origin !== "human").length,
    [runs],
  );
  const shown = useMemo(
    () => (filter === "unattended" ? runs.filter((r) => r.origin !== "human") : runs),
    [runs, filter],
  );
  // New-since-last-visit banner: count the unattended runs that arrived while away.
  const newAway = useMemo(
    () => runs.filter((r) => r.isNew && r.origin !== "human").length,
    [runs],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-paddock-200 px-4 py-3 dark:border-paddock-800">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink dark:text-ink-dark">Run history</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-xs text-paddock-500 hover:text-paddock-700 dark:text-paddock-400 dark:hover:text-paddock-200"
          >
            Refresh
          </button>
        </div>
        <div className="inline-flex overflow-hidden rounded-lg border border-paddock-200 text-xs dark:border-paddock-800">
          <FilterButton active={filter === "unattended"} onClick={() => setFilter("unattended")}>
            Unattended{unattendedCount > 0 ? ` (${unattendedCount})` : ""}
          </FilterButton>
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterButton>
        </div>
      </div>

      {newAway > 0 && (
        <div
          data-since-last-visit={newAway}
          className="border-b border-accent/30 bg-accent/[0.08] px-4 py-2 text-sm text-ink dark:text-ink-dark"
        >
          <span className="font-medium">
            {newAway} new {newAway === 1 ? "run" : "runs"}
          </span>{" "}
          ran while you were away.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-4 py-10 text-center text-sm text-rose-600 dark:text-rose-400">
            {error}
          </div>
        ) : loading && runs.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-paddock-500 dark:text-paddock-400">
            Loading run history…
          </div>
        ) : shown.length === 0 ? (
          <EmptyState filter={filter} hasAny={runs.length > 0} />
        ) : (
          <div>
            {shown.map((run) => (
              <RunRow
                key={run.jobId}
                run={run}
                title={nameOf(run.sessionId)}
                onOpen={() => run.sessionId && onOpenChat(run.sessionId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 font-medium transition-colors ${
        active
          ? "bg-accent/15 text-accent-700 dark:text-accent"
          : "text-paddock-500 hover:text-paddock-700 dark:text-paddock-400 dark:hover:text-paddock-200"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ filter, hasAny }: { filter: OriginFilter; hasAny: boolean }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium text-ink dark:text-ink-dark">
        {filter === "unattended" ? "No unattended runs yet" : "No runs yet"}
      </p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-paddock-500 dark:text-paddock-400">
        {filter === "unattended"
          ? hasAny
            ? "Scheduled and spawned runs will show up here. Switch to All to see your own runs."
            : "Scheduled and spawned runs — the ones that happen while you're not watching — will show up here."
          : "Runs appear here once the keeper starts finishing turns."}
      </p>
    </div>
  );
}
