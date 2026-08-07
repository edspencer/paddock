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
import { BranchIcon, ClockIcon, ChatIcon, TerminalIcon } from "./icons";

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
      cls: "bg-warn-soft text-warn",
    };
  if (origin === "spawned")
    return {
      label: "Spawned",
      icon: <BranchIcon width={12} height={12} />,
      cls: "bg-lineage-soft text-lineage",
    };
  // Adopted from the user's Claude Code CLI history (#588). Still a run the
  // human drove — just not here — so it gets its own chip rather than the "You"
  // fallback, which would claim the turn happened in paddock. Matches the
  // success/terminal language of the sidebar's `adopted` ProvenanceBadge.
  if (origin === "adopted")
    return {
      label: "Adopted",
      icon: <TerminalIcon width={12} height={12} />,
      cls: "bg-success-soft text-success",
    };
  return {
    label: "You",
    icon: <ChatIcon width={12} height={12} />,
    cls: "bg-surface-active text-fg-muted",
  };
}

/** Status → short color-coded chip. */
function statusMeta(status: RunSummary["status"]): { label: string; cls: string } {
  switch (status) {
    case "completed":
      return { label: "completed", cls: "bg-success-soft text-success" };
    case "failed":
      return { label: "failed", cls: "bg-danger-soft text-danger" };
    case "running":
      return { label: "running", cls: "bg-info-soft text-info" };
    case "cancelled":
      return { label: "cancelled", cls: "bg-surface-active text-fg-muted" };
    case "pending":
      return { label: "pending", cls: "bg-warn-soft text-warn" };
    default:
      return { label: status, cls: "bg-surface-active text-fg-muted" };
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

/**
 * Did this run happen WITHOUT the user — the "while you were away" population.
 *
 * Written as an exclusion list rather than `origin !== "human"` because #588 added
 * a second attended origin: an `adopted` run is a turn the human drove personally,
 * just in a terminal before it was adopted. Counting it as unattended would put the
 * user's own back-catalogue in the "ran while you were away" banner the first time
 * they adopt, which is the opposite of what that banner is for.
 */
function unattended(run: RunSummary): boolean {
  return run.origin !== "human" && run.origin !== "adopted";
}

/** What triggered the run, secondary line: schedule name / parent / trigger. */
function triggerNote(run: RunSummary): string {
  if (run.origin === "scheduled") return run.schedule ? `schedule · ${run.schedule}` : "schedule";
  if (run.origin === "spawned")
    return run.depth > 1 ? `spawned · ${run.depth} levels deep` : "spawned by another chat";
  if (run.origin === "adopted") return "adopted from the Claude Code CLI";
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
      className={`flex w-full items-start gap-3 border-t border-edge px-4 py-3 text-left first:border-t-0 ${
        clickable ? "hover:bg-surface-hover" : "cursor-default"
      } ${run.isNew ? "bg-accent-soft" : ""}`}
    >
      {/* since-last-visit dot */}
      <span className="mt-1.5 w-1.5 shrink-0">
        {run.isNew && (
          <span
            data-run-unread="true"
            aria-label="New since your last visit"
            title="Ran while you were away"
            className="block h-1.5 w-1.5 rounded-full bg-accent-solid"
          />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium ${origin.cls}`}
          >
            {origin.icon}
            {origin.label}
          </span>
          <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium ${status.cls}`}>
            {status.label}
          </span>
        </div>
        <p className="mt-1 truncate text-sm text-fg">{label}</p>
        <p className="mt-0.5 truncate text-xs text-fg-muted">{triggerNote(run)}</p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-fg-muted">
        <span title={new Date(run.startedAt).toLocaleString()}>{relativeTime(run.startedAt)}</span>
        <span className="font-mono tabular">{runDuration(run)}</span>
        {/* Cost — P3 seam (DD-4 / X1#378 + X2#271): always em-dash for now. */}
        <span className="font-mono text-fg-subtle" title="Per-run cost is coming soon">
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
  const unattendedCount = useMemo(() => runs.filter(unattended).length, [runs]);
  const shown = useMemo(
    () => (filter === "unattended" ? runs.filter(unattended) : runs),
    [runs, filter],
  );
  // New-since-last-visit banner: count the unattended runs that arrived while away.
  const newAway = useMemo(() => runs.filter((r) => r.isNew && unattended(r)).length, [runs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-fg">Run history</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-xs text-fg-muted hover:text-fg"
          >
            Refresh
          </button>
        </div>
        <div className="inline-flex overflow-hidden rounded-lg border border-edge text-xs">
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
          className="border-b border-accent-edge bg-accent-soft px-4 py-2 text-sm text-fg"
        >
          <span className="font-medium">
            {newAway} new {newAway === 1 ? "run" : "runs"}
          </span>{" "}
          ran while you were away.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-4 py-10 text-center text-sm text-danger">{error}</div>
        ) : loading && runs.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-fg-muted">
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
      className={`motion-fast px-2.5 py-1 font-medium transition-colors ${
        active ? "bg-accent-soft text-accent" : "text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ filter, hasAny }: { filter: OriginFilter; hasAny: boolean }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium text-fg">
        {filter === "unattended" ? "No unattended runs yet" : "No runs yet"}
      </p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-fg-muted">
        {filter === "unattended"
          ? hasAny
            ? "Scheduled and spawned runs will show up here. Switch to All to see your own runs."
            : "Scheduled and spawned runs — the ones that happen while you're not watching — will show up here."
          : "Runs appear here once Claude starts finishing turns."}
      </p>
    </div>
  );
}
