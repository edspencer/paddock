// The per-project "History" panel — the "while you were away" run-history view
// (#268 / E3 / DD-6). Lists recent herdctl runs joined with their provenance so
// the unattended ones (scheduled + spawned) stand out, with status, duration,
// what triggered them, and a link into the chat.
//
// Data comes from GET /api/projects/:slug/runs (see lib/useProjectRuns); the
// parent (ProjectView) owns the fetch so the tab badge can render the new-run
// count without opening the tab.
//
// ---------------------------------------------------------------------------
// THE REGISTER — this is the `register` direction's signature surface.
//
// Paddock is a system of record and this is the record. The rebuild is not a
// restyle: `GET /runs` was already shipping five fields the old pane fetched
// and threw away, and the pane's one column of real estate was spent on a
// hard-coded em-dash.
//
//   run.summary     the agent's own one-line account of what it did. The best
//                   sentence in the whole dataset, previously used only as a
//                   FALLBACK label when `prompt` was empty — so on a normal run
//                   it was fetched and discarded.
//   run.exitReason  success | error | max_turns | timeout | cancelled. The old
//                   pane showed the coarse `status`, so "failed" never said why.
//   run.finishedAt  shipped; only `startedAt` was rendered.
//   run.forkedFrom  a real parent JOB id, computed server-side, read by nothing.
//   data.lastSeen   the epoch of your previous visit — shipped, but collapsed to
//                   the boolean `isNew` and never shown as a date.
//   run.jobId       used only as a React key. It encodes the run's date.
//
// Three structural devices, and each carries a fact rather than a decoration:
//
//   1. THE MARGIN holds the day. Runs are grouped by calendar day and the day
//      is set once, large, in the display face, in the gutter — so scrolling
//      the list is scrolling time. One rule per day, and none between rows:
//      ruling every boundary is how an editorial layout turns into newsprint.
//   2. THE FOLIO is the run's position in the project's record, counted from
//      the oldest. It is what `forkedFrom` points AT, which is what lets a
//      forked run name its parent in the margin instead of in prose.
//   3. THE LAST-VISIT RULE is laid between the runs newer and older than
//      `lastSeen`. It is the deliberate break in the repeated pattern, and it
//      is the only place in the pane that spends the accent.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import type { Chat, RunSummary } from "../lib/types";
import type { ProjectRunsState } from "../lib/useProjectRuns";
import { relativeTime, formatDuration } from "../lib/format";
import { Button } from "./ui";
import { MarginalDate } from "./MarginalDate";

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

/**
 * Origin → label + hue.
 *
 * `hook` had no branch here, so a hook-fired run rendered as "You" with a chat
 * icon while simultaneously being filed under Unattended by `unattended()`
 * below. It gets its own entry now; the two disagreeing is a server/client
 * split worth filing separately (`ORIGIN_IS_UNATTENDED` in runs.ts calls `hook`
 * attended, this file does not).
 *
 * Chanel's rule, applied: each of these used to carry an 11px icon as well — a
 * clock beside the word "Scheduled", a branch beside "Spawned". The eyebrow's
 * word says it, the eyebrow's ink says it a second time, and the icon said it a
 * third. Taking the icons off is what lets a row read as a line of type rather
 * than as a toolbar.
 */
function originMeta(origin: RunSummary["origin"]): { label: string; cls: string } {
  if (origin === "scheduled") return { label: "Scheduled", cls: "text-warn" };
  if (origin === "spawned") return { label: "Spawned", cls: "text-lineage" };
  if (origin === "hook") return { label: "Hook", cls: "text-info" };
  // Adopted from the user's Claude Code CLI history (#588). Still a run the
  // human drove — just not here.
  if (origin === "adopted") return { label: "Adopted", cls: "text-success" };
  return { label: "You", cls: "text-fg-subtle" };
}

/**
 * Status → the outcome as one printed word.
 *
 * `exitReason` is preferred over `status` wherever it says more: a failed run
 * that timed out and a failed run that hit its turn cap are different events,
 * and the record should say which. `success` is dropped on a completed run —
 * "completed · success" is one fact printed twice.
 */
function outcomeOf(run: RunSummary): { label: string; cls: string } | null {
  const reason = run.exitReason && run.exitReason !== "success" ? run.exitReason : null;
  switch (run.status) {
    case "completed":
      return reason ? { label: reason.replace(/_/g, " "), cls: "text-warn" } : null;
    case "failed":
      return { label: reason ?? "failed", cls: "text-danger" };
    case "running":
      return { label: "running", cls: "text-info" };
    case "cancelled":
      return { label: "cancelled", cls: "text-fg-subtle" };
    case "pending":
      return { label: "pending", cls: "text-warn" };
    default:
      return { label: run.status, cls: "text-fg-subtle" };
  }
}

/**
 * Human duration for a run: server seconds when finished, else live elapsed.
 *
 * A recorded `0` is herdctl saying `started_at === finished_at`, i.e. it never
 * learned how long the run took — not that the run was instantaneous. Printing
 * "0ms" would be the register asserting something it does not know.
 */
function runDuration(run: RunSummary): string | null {
  if (run.durationSeconds) return formatDuration(run.durationSeconds * 1000);
  if (run.status === "running") {
    const started = Date.parse(run.startedAt);
    if (Number.isFinite(started)) return `${formatDuration(Date.now() - started) ?? "—"}…`;
  }
  return null;
}

/**
 * Did this run happen WITHOUT the user — the "while you were away" population.
 *
 * Written as an exclusion list rather than `origin !== "human"` because #588 added
 * a second attended origin: an `adopted` run is a turn the human drove personally,
 * just in a terminal before it was adopted.
 */
function unattended(run: RunSummary): boolean {
  return run.origin !== "human" && run.origin !== "adopted";
}

/**
 * The agent's own account of the run, cut to one line.
 *
 * A real `summary` runs to several hundred words of Markdown. The first
 * non-empty, non-heading line is almost always the sentence that says what
 * happened, which is exactly what a record wants and nothing more.
 */
function summaryLine(summary: string | null): string | null {
  if (!summary) return null;
  const line = summary
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) return null;
  const clean = line.replace(/^[*_`>\s-]+/, "").trim();
  if (clean.length <= 150) return clean;
  return `${clean.slice(0, 149).trimEnd()}…`;
}

/** A calendar-day bucket: the unit the register is organised in. */
interface DayGroup {
  key: string;
  date: Date;
  runs: RunSummary[];
}

function groupByDay(runs: RunSummary[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const run of runs) {
    const date = new Date(run.startedAt);
    const key = Number.isNaN(date.getTime())
      ? "unknown"
      : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.runs.push(run);
    else groups.push({ key, date, runs: [run] });
  }
  return groups;
}

/** `0007` — zero-padded to the width of the largest folio in the record. */
function folio(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function RunRow({
  run,
  folioNo,
  folioWidth,
  title,
  onOpen,
}: {
  run: RunSummary;
  folioNo: number;
  folioWidth: number;
  title: string;
  onOpen: () => void;
}) {
  const origin = originMeta(run.origin);
  const outcome = outcomeOf(run);
  const clickable = run.sessionId != null;
  const label = run.prompt?.trim() || run.summary?.trim() || title;
  const account = run.prompt?.trim() ? summaryLine(run.summary) : null;
  const duration = runDuration(run);
  const finished = run.finishedAt ? new Date(run.finishedAt) : null;

  return (
    <button
      type="button"
      onClick={clickable ? onOpen : undefined}
      disabled={!clickable}
      data-run-origin={run.origin}
      data-run-new={run.isNew ? "true" : undefined}
      className={`group flex w-full gap-3 rounded-lg px-3 py-2.5 text-left ${
        clickable ? "can-hover:hover:bg-surface-hover" : "cursor-default"
      }`}
    >
      {/*
       * The folio. Its width is the width of the whole record, so the column
       * stays true whether the project has 9 runs or 9,000.
       */}
      <span
        aria-hidden
        className="folio mt-px shrink-0 text-3xs text-fg-subtle/70 group-disabled:opacity-60"
      >
        {folio(folioNo, folioWidth)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`eyebrow shrink-0 text-3xs ${origin.cls}`}>{origin.label}</span>
          {outcome && (
            <span className={`eyebrow shrink-0 text-3xs ${outcome.cls}`}>{outcome.label}</span>
          )}
          <span className="min-w-0 flex-1" />
          <span
            className="folio shrink-0 text-3xs text-fg-subtle"
            title={
              finished
                ? `Started ${new Date(run.startedAt).toLocaleString()}\nFinished ${finished.toLocaleString()}`
                : new Date(run.startedAt).toLocaleString()
            }
          >
            {finished
              ? finished.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : relativeTime(run.startedAt)}
            {duration ? ` · ${duration}` : ""}
          </span>
        </span>

        <span className="mt-1 block truncate text-sm text-fg">{label}</span>

        {/*
         * The agent's own sentence. This is the line the old pane fetched and
         * dropped, and it is the reason the register is worth reading rather
         * than merely counting.
         */}
        {account && (
          <span className="mt-0.5 block truncate text-xs italic text-fg-muted">{account}</span>
        )}

        {/*
         * Lineage, in the margin of the row rather than in prose. Depth is a
         * real number of spawn hops; `forkedFrom` is a real parent job.
         */}
        {(run.depth > 1 || run.forkedFrom || run.schedule) && (
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {/*
             * Depth only earns a line when it says something the origin does
             * not. "Spawned" already means one hop from a person; printing
             * "spawned · 1 level deep" under it is the same fact twice, which
             * is what the old pane did on every spawned row.
             */}
            {run.depth > 1 && (
              <span
                className="eyebrow text-3xs text-lineage"
                title={`${run.depth} spawn hops from the person who started this`}
              >
                {"·".repeat(Math.min(run.depth, 6))}
                <span className="ml-1.5">{run.depth} hops deep</span>
              </span>
            )}
            {run.forkedFrom && (
              <span className="folio text-3xs text-lineage">forked from {run.forkedFrom}</span>
            )}
            {run.schedule && (
              <span className="eyebrow text-3xs text-warn">
                <span className="opacity-70">on</span> {run.schedule}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

export function HistoryPane({ slug, state, chats, onOpenChat }: HistoryPaneProps) {
  const { data, loading, error, refresh, markSeen } = state;
  const [filter, setFilter] = useState<OriginFilter>("all");

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
  const newAway = useMemo(() => runs.filter((r) => r.isNew && unattended(r)).length, [runs]);

  /*
   * Folio numbers count from the OLDEST run, so a given run keeps its number
   * for ever as newer ones arrive. They are assigned over the full record, not
   * over the filtered view — filtering to Unattended must not renumber history.
   */
  const folioOf = useMemo(() => {
    const m = new Map<string, number>();
    runs.forEach((run, i) => m.set(run.jobId, runs.length - i));
    return m;
  }, [runs]);
  const folioWidth = Math.max(3, String(runs.length).length);

  const groups = useMemo(() => groupByDay(shown), [shown]);

  /*
   * The last-visit rule goes before the first run OLDER than the watermark, so
   * everything above it arrived since you were here. Suppressed when the
   * watermark is unset (a first visit — everything is new, and a rule at the
   * very top says nothing) or when it falls outside the loaded window.
   */
  const lastSeen = data?.lastSeen ?? 0;
  const firstOldJobId = useMemo(() => {
    if (!lastSeen) return null;
    const old = shown.find((r) => Date.parse(r.startedAt) <= lastSeen);
    if (!old || old === shown[0]) return null;
    return old.jobId;
  }, [shown, lastSeen]);

  const span = useMemo(() => {
    if (runs.length === 0) return null;
    const oldest = new Date(runs[runs.length - 1]!.startedAt);
    const newest = new Date(runs[0]!.startedAt);
    if (Number.isNaN(oldest.getTime()) || Number.isNaN(newest.getTime())) return null;
    const fmt = (d: Date) => d.toLocaleDateString([], { day: "numeric", month: "short" });
    return oldest.toDateString() === newest.toDateString()
      ? fmt(newest)
      : `${fmt(oldest)} – ${fmt(newest)}`;
  }, [runs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
       * The masthead. A record says what it covers before it says anything
       * else: how many entries, over what span, and how many you have not seen.
       */}
      <div className="border-b border-edge px-5 pb-4 pt-5">
        <div className="mx-auto flex max-w-3xl flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {/* The eyebrow classifies what you are looking at, so it tracks the
              filter rather than restating the title underneath it. */}
          <p className="eyebrow text-3xs text-fg-subtle">
            {filter === "unattended" ? "Unattended runs" : "Every run"}
          </p>
          <h2 className="mt-1.5 text-xl font-semibold text-fg">The register</h2>
          {runs.length > 0 && (
            <p className="mt-1 text-xs text-fg-muted">
              <span className="tabular">{runs.length}</span> recorded
              {span ? ` · ${span}` : ""}
              {newAway > 0 ? (
                <>
                  {" · "}
                  <span className="text-accent">
                    <span className="tabular">{newAway}</span> while you were away
                  </span>
                </>
              ) : null}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button variant="subtle" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
          <div className="inline-flex overflow-hidden rounded-lg border border-edge text-xs">
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
              All
            </FilterButton>
            <FilterButton active={filter === "unattended"} onClick={() => setFilter("unattended")}>
              Unattended{unattendedCount > 0 ? ` ${unattendedCount}` : ""}
            </FilterButton>
          </div>
        </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        <div className="mx-auto max-w-3xl">
        {error ? (
          <div className="px-4 py-10 text-center text-sm text-danger">{error}</div>
        ) : loading && runs.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-fg-muted">Loading the register…</div>
        ) : shown.length === 0 ? (
          <EmptyRegister filter={filter} hasAny={runs.length > 0} />
        ) : (
          groups.map((group, gi) => (
            <section
              key={group.key}
              className="flex gap-3 border-t border-edge-subtle pt-3 first:border-t-0"
            >
              {/*
               * The margin. The day is set once per group, in the display face,
               * and it is sticky — so the date you are reading under is always
               * on screen. This is the whole "time made structural" idea in one
               * element.
               */}
              <div className="w-14 shrink-0 pl-2 pt-1.5 sm:w-16">
                <div className="sticky top-2">
                  {/*
                   * The year prints only where it CHANGES — at the top of the
                   * list and at each January boundary. Stamping it on all 22
                   * day-groups would be an ornament, and this direction's rule
                   * for a structural device is that it carries a fact.
                   */}
                  <MarginalDate
                    date={group.date}
                    showYear={
                      gi === 0 ||
                      groups[gi - 1]!.date.getFullYear() !== group.date.getFullYear()
                    }
                  />
                </div>
              </div>

              <div className="min-w-0 flex-1 pb-2">
                {group.runs.map((run) => (
                  <div key={run.jobId}>
                    {run.jobId === firstOldJobId && <LastVisitRule at={lastSeen} />}
                    <RunRow
                      run={run}
                      folioNo={folioOf.get(run.jobId) ?? 0}
                      folioWidth={folioWidth}
                      title={nameOf(run.sessionId)}
                      onOpen={() => run.sessionId && onOpenChat(run.sessionId)}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
        </div>
      </div>
    </div>
  );
}

/**
 * The break in the pattern.
 *
 * Every other boundary in this pane is whitespace; this one gets a rule, an
 * accent and a date, because it is the only boundary that is about YOU rather
 * than about the runs. `lastSeen` was already on the wire — the old pane spent
 * it on a boolean and a banner that said "N new runs" without ever saying since
 * when.
 */
function LastVisitRule({ at }: { at: number }) {
  const when = new Date(at);
  const label = Number.isNaN(when.getTime())
    ? "your last visit"
    : when.toLocaleString([], {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        // 24-hour, to match the time on every row beneath it. A register that
        // prints "12:46 PM" here and "12:46" three lines down is two records.
        hour12: false,
      });
  return (
    <div
      data-last-visit
      className="my-3 flex items-center gap-3 px-3 text-accent"
      aria-label={`Everything above this line ran since your last visit, ${label}`}
    >
      <span className="h-px flex-1 bg-accent-edge" />
      <span className="eyebrow shrink-0 text-3xs">You were last here · {label}</span>
      <span className="h-px w-6 bg-accent-edge" />
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

/**
 * The register is blank for most installs, and that is normal rather than
 * broken: job records are only written by `driveMode: batch` turns, and
 * `session` is the default. So the empty state explains the mechanism instead
 * of implying nothing has happened.
 */
function EmptyRegister({ filter, hasAny }: { filter: OriginFilter; hasAny: boolean }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <p className="eyebrow text-3xs text-fg-subtle">Nothing recorded</p>
      <h3 className="mt-2 text-lg font-semibold text-fg">
        {filter === "unattended" ? "No unattended runs yet" : "The register is empty"}
      </h3>
      <p className="mt-2 text-sm text-fg-muted">
        {filter === "unattended"
          ? hasAny
            ? "Scheduled, spawned and hook-fired runs land here — the ones that happen while you are not watching. Switch to All to read your own."
            : "Runs that happen without you — scheduled, spawned or fired by a hook — are recorded here so you can catch up on them later."
          : "Every finished turn is written into the record with what triggered it, how long it took and how it ended."}
      </p>
    </div>
  );
}
