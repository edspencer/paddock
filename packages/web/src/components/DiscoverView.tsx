import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import type { ShellOutletContext } from "./AppShell";
import { api } from "../lib/api";
import { useProjects } from "../lib/projects-context";
import type { AdoptableCandidate, DiscoverCandidate, DiscoverResult } from "../lib/types";
import {
  applySessions,
  importPlan,
  initialRows,
  patchRow,
  rowSelectedCount,
  rowTick,
  selectedCandidates,
  setRowChecked,
  toggleSession,
  totalSelected,
  type RowStates,
} from "../lib/discoverSelection";
import {
  describeOutcome,
  outcomeTone,
  runImport,
  type ImportOutcome,
  type ImportStatus,
} from "../lib/discoverImport";
import { Button, Callout, Card, Checkbox, Chip, EmptyState, Toggle, cx } from "./ui";
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  MenuIcon,
  SearchIcon,
  TerminalIcon,
} from "./icons";

/**
 * **Discover** (#745) — the directories on this machine that already have Claude
 * Code history, offered as projects.
 *
 * ## One component, two mount points
 *
 * This is a route (`/discover`) AND the empty instance's Home, rendered inline
 * by `RootHome`. Deliberately not a dialog: a modal on first boot is something to
 * dismiss, and `paddock service install` (#796) boots from launchd with no
 * terminal, so the first-run experience has to be a page you can link to,
 * refresh and come back to rather than a moment you can miss. `firstRun` changes
 * two sentences of copy; everything below it is one implementation.
 *
 * ## Discover / Import / "Import N native chats"
 *
 * Three adjacent words. **Discover** is instance-level: which directories could
 * become projects. **Import** brings the ticked ones in. The per-project
 * "Import N native chats" button is a different, ongoing thing — a project you
 * already have, accruing more terminal history — and is untouched by this.
 *
 * ## Why an empty table would be a bug report
 *
 * A container's Claude home is `<dataDir>/claude-home`, not a user's, so
 * Discovery legitimately finds nothing there. `scanned: 0` is that case and says
 * so, naming the directory to bind-mount; a non-zero `scanned` with no rows is
 * the opposite problem and gets the exclusion tally plus the two toggles that
 * would relax it. Rendering a blank table for either is how you get told the
 * feature is broken.
 *
 * ## Refreshing without unmounting yourself (#808)
 *
 * On the Home mount this component exists only while the instance is empty, so
 * the very act of importing removes its own reason to be on screen. The run
 * therefore refreshes the project list ONCE, on completion, and `RootHome`
 * latches its empty-instance decision so that refresh cannot pull the success
 * screen — and every per-row outcome the user still has to read — out from under
 * them. Deferring the refresh all the way to "Get started" was the original
 * answer, and it is what the bug was: the finished screen claims the projects
 * are in the sidebar while the sidebar still says there are none.
 */
export function DiscoverView({
  firstRun = false,
  onLeave,
}: {
  firstRun?: boolean;
  /**
   * The Home mount's way out. `RootHome` passes its `recheck` here, because a
   * screen rendered INSTEAD of Home cannot leave by navigating to Home — it has
   * to tell Home to ask again. The `/discover` route passes nothing: it is an
   * ordinary route, and `navigate` is enough.
   */
  onLeave?: () => void;
}) {
  const navigate = useNavigate();
  const { refresh } = useProjects();
  const shell = useOutletContext<ShellOutletContext | null>();

  const [includeNonGit, setIncludeNonGit] = useState(false);
  const [includeOutsideHome, setIncludeOutsideHome] = useState(false);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [rows, setRows] = useState<RowStates>({});

  const [submitting, setSubmitting] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, ImportStatus>>({});
  const [outcomes, setOutcomes] = useState<Record<string, ImportOutcome>>({});
  /** The run has finished. Distinct from "not submitting": it gates the success screen. */
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let live = true;
    setScanning(true);
    setScanError(null);
    api
      .discover({ includeNonGit, includeOutsideHome })
      .then((res) => {
        if (!live) return;
        setResult(res);
        // A re-scan is a NEW offer, so the selection is rebuilt rather than
        // merged: keeping ticks across a toggle would leave the table holding
        // opinions about rows that are no longer on it.
        setRows(initialRows(res.candidates));
        setScanning(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setScanError(e instanceof Error ? e.message : "Discovery failed");
        setScanning(false);
      });
    return () => {
      live = false;
    };
  }, [includeNonGit, includeOutsideHome]);

  const candidates = result?.candidates ?? [];
  const total = useMemo(() => totalSelected(rows, candidates), [rows, candidates]);
  const accepted = useMemo(() => selectedCandidates(rows, candidates), [rows, candidates]);

  /** Expand a row, loading its sessions the first time (and only then). */
  const toggleExpanded = useCallback(
    (candidate: DiscoverCandidate) => {
      setRows((prev) => {
        const row = prev[candidate.path];
        if (!row) return prev;
        const next = patchRow(prev, candidate.path, { expanded: !row.expanded });
        if (row.expanded || row.sessions || row.loading) return next;
        return patchRow(next, candidate.path, { loading: true, error: null });
      });
      const row = rows[candidate.path];
      if (!row || row.expanded || row.sessions || row.loading) return;
      api
        .discoverSessions(candidate.path)
        .then((sessions) => setRows((prev) => applySessions(prev, candidate.path, sessions)))
        .catch((e: unknown) =>
          setRows((prev) =>
            patchRow(prev, candidate.path, {
              loading: false,
              error: e instanceof Error ? e.message : "Could not read this directory's sessions",
            }),
          ),
        );
    },
    [rows],
  );

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setStatuses(Object.fromEntries(accepted.map((c) => [c.path, "pending" as ImportStatus])));
    setOutcomes({});
    const jobs = accepted.map((c) => ({
      candidate: c,
      plan: importPlan(rows[c.path], c) ?? {},
    }));
    await runImport(api, jobs, (path, status, outcome) => {
      setStatuses((prev) => ({ ...prev, [path]: status }));
      if (outcome) setOutcomes((prev) => ({ ...prev, [path]: outcome }));
    });
    setSubmitting(false);
    setFinished(true);
    // The rest of the app learns about the new projects HERE, once the run is
    // over — not per row (that is the mid-run unmount this screen must not
    // suffer) and not only on "Get started". The success screen says "They are
    // in the sidebar now", and until this call that sentence was false: the
    // sidebar still read "No projects yet" and a manual browser reload was the
    // only way out (#808). Safe to do now only because `RootHome` latches its
    // empty-instance decision — see {@link useInstanceEmpty}.
    await refresh();
  }, [accepted, rows, submitting, refresh]);

  /**
   * Leave for Home.
   *
   * Two steps, and the second is the one that actually moves on the Home mount:
   * `navigate("/")` is a no-op when this screen already IS `/`, so what ends it
   * is `onLeave` — `RootHome`'s `recheck`, releasing the latch that has been
   * holding this component on screen since the run finished. The refresh is kept
   * even though {@link submit} already ran one: it is the only thing standing
   * between a failed background refresh and a Home rendered from a stale list.
   */
  const getStarted = useCallback(async () => {
    await refresh();
    onLeave?.();
    navigate("/");
  }, [navigate, refresh, onLeave]);

  const imported = Object.values(outcomes).reduce((n, o) => n + o.adopted, 0);
  const createdCount = Object.values(outcomes).filter((o) => o.project).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="pt-safe flex items-center gap-2 border-b border-edge px-3 pb-2.5 sm:px-6 lg:py-4">
        <button
          type="button"
          onClick={() => shell?.openNav()}
          aria-label="Open menu"
          className="btn-subtle -ml-1 shrink-0 px-2 py-1.5 lg:hidden"
        >
          <MenuIcon width={20} height={20} />
        </button>
        <SearchIcon width={18} height={18} className="shrink-0 text-fg-subtle" />
        <h1 className="text-md font-semibold tracking-tight">Discover</h1>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="mb-5 text-sm text-fg-muted">
            {firstRun
              ? "Nothing here yet — but you have probably already been using Claude Code in a terminal. These directories have history Paddock can bring in as projects."
              : "Directories on this machine with existing Claude Code history. Importing one links it as a project and copies its conversations in; your own history is never moved or deleted."}
          </p>

          {/* The run's outcome sits ABOVE the table, not instead of it: the rows
              are where the per-row detail is, and swapping them out for a summary
              at the moment they finish would throw away the colours the user has
              just been watching — including the ones they need to read. */}
          {finished && (
            <Done imported={imported} projects={createdCount} onGetStarted={getStarted} />
          )}
          {scanError !== null && (
            <Callout tone="danger" icon={<AlertIcon width={16} height={16} />}>
              {scanError}
            </Callout>
          )}
          {scanning && <ScanSkeleton />}
          {!scanning && scanError === null && result !== null && (
            <>
              {result.scanned === 0 ? (
                <NoHistory claudeHome={result.claudeHome} />
              ) : candidates.length === 0 ? (
                <EmptyState
                  variant="panel"
                  icon={<FolderIcon width={22} height={22} />}
                  title="Nothing left to import"
                  // The tally is NOT repeated here: `Filters` renders it
                  // directly below, always, and saying it twice on one screen
                  // reads as two different findings.
                  body="Every directory with Claude Code history on this machine is already a project, or was filtered out."
                />
              ) : (
                <ul className="space-y-2">
                  {candidates.map((c) => (
                    <Row
                      key={c.path}
                      candidate={c}
                      row={rows[c.path]}
                      status={statuses[c.path]}
                      outcome={outcomes[c.path]}
                      locked={submitting || finished}
                      onToggleRow={(on) => setRows((prev) => setRowChecked(prev, c.path, on))}
                      onToggleSession={(id) => setRows((prev) => toggleSession(prev, c.path, id))}
                      onToggleExpanded={() => toggleExpanded(c)}
                    />
                  ))}
                </ul>
              )}

              {!finished && (
                <Filters
                  result={result}
                  includeNonGit={includeNonGit}
                  includeOutsideHome={includeOutsideHome}
                  disabled={submitting}
                  onIncludeNonGit={setIncludeNonGit}
                  onIncludeOutsideHome={setIncludeOutsideHome}
                />
              )}

              {candidates.length > 0 && !finished && (
                <div className="mt-5 flex items-center justify-between gap-3 border-t border-edge pt-4">
                  <span className="text-sm text-fg-muted">
                    {total} conversation{total === 1 ? "" : "s"} from {accepted.length} director
                    {accepted.length === 1 ? "y" : "ies"}
                  </span>
                  <Button
                    variant="primary"
                    onClick={() => void submit()}
                    disabled={accepted.length === 0}
                    loading={submitting}
                    loadingLabel="Importing…"
                  >
                    Import {accepted.length} project{accepted.length === 1 ? "" : "s"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One candidate directory. */
function Row({
  candidate,
  row,
  status,
  outcome,
  locked,
  onToggleRow,
  onToggleSession,
  onToggleExpanded,
}: {
  candidate: DiscoverCandidate;
  row: RowStates[string] | undefined;
  status?: ImportStatus;
  outcome?: ImportOutcome;
  /** The run is in flight — nothing is editable while its own calls are pending. */
  locked: boolean;
  onToggleRow: (on: boolean) => void;
  onToggleSession: (sessionId: string) => void;
  onToggleExpanded: () => void;
}) {
  const state = row ?? { checked: false, expanded: false, loading: false, error: null };
  const tick = rowTick(state);
  const count = rowSelectedCount(state, candidate);
  const tone = outcome ? outcomeTone(outcome) : null;

  return (
    <li>
      <Card
        flush
        className={cx(
          "overflow-hidden",
          tone === "success" && "border-success-edge bg-success-soft",
          tone === "warn" && "border-warn-edge bg-warn-soft",
          tone === "danger" && "border-danger-edge bg-danger-soft",
          status === "running" && "border-accent-edge",
        )}
        data-testid={`discover-row-${candidate.suggestedSlug}`}
        data-tone={tone ?? undefined}
      >
        <div className="flex items-start gap-3 px-3 py-2.5">
          <Checkbox
            className="mt-1"
            checked={tick === "on"}
            indeterminate={tick === "mixed"}
            disabled={locked}
            aria-label={`Import ${candidate.path}`}
            onChange={(e) => onToggleRow(e.target.checked)}
          />
          <div className="min-w-0 flex-1">
            <code className="block break-all text-sm text-fg">{candidate.path}</code>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
              <span className="tabular">
                {candidate.sessionCount} conversation{candidate.sessionCount === 1 ? "" : "s"}
              </span>
              {candidate.filteredCount > 0 && (
                <span
                  className="tabular"
                  title="Empty, slash-command-only or sweeper transcripts, withheld as noise"
                >
                  · {candidate.filteredCount} filtered out
                </span>
              )}
              {candidate.lastSessionAt !== undefined && (
                <span className="tabular">· last {formatDate(candidate.lastSessionAt)}</span>
              )}
              {candidate.gitRemote !== undefined && (
                <Chip tone="lineage" size="sm">
                  {candidate.gitRemote}
                </Chip>
              )}
              {!candidate.hasGit && (
                <Chip tone="neutral" size="sm">
                  no git
                </Chip>
              )}
              {!candidate.insideHome && (
                <Chip tone="neutral" size="sm">
                  outside home
                </Chip>
              )}
            </div>
            {/* The scan's own warning, shown BEFORE the import rather than as a
                post-mortem: a linked project's importable sources are matched on
                exact path equality, so this row is the one that comes back with
                zero chats despite the healthy count above. */}
            {candidate.recordedPath !== undefined && (
              <Callout
                tone="warn"
                className="mt-2"
                icon={<AlertIcon width={14} height={14} />}
              >
                <span className="text-xs">
                  These transcripts record{" "}
                  <code className="break-all">{candidate.recordedPath}</code> — a different
                  spelling of this path. The import matches on the exact path, so it may bring
                  nothing in.
                </span>
              </Callout>
            )}
            {outcome && (
              <p
                className={cx(
                  "mt-2 text-xs",
                  tone === "success" && "text-success",
                  tone === "warn" && "text-warn",
                  tone === "danger" && "text-danger",
                )}
              >
                {describeOutcome(outcome, candidate)}
              </p>
            )}
            {status === "running" && !outcome && (
              <p className="mt-2 text-xs text-fg-muted">Importing…</p>
            )}
          </div>
          <span className="flex shrink-0 items-center gap-1">
            <span className="tabular text-xs text-fg-subtle">{count}</span>
            <Button
              size="icon-sm"
              variant="subtle"
              aria-label={state.expanded ? "Hide conversations" : "Show conversations"}
              aria-expanded={state.expanded}
              onClick={onToggleExpanded}
            >
              {state.expanded ? (
                <ChevronDownIcon width={14} height={14} />
              ) : (
                <ChevronRightIcon width={14} height={14} />
              )}
            </Button>
          </span>
        </div>

        {state.expanded && (
          <div className="border-t border-edge px-3 py-2">
            {state.loading && <p className="py-2 text-xs text-fg-muted">Reading transcripts…</p>}
            {state.error !== null && (
              <p className="py-2 text-xs text-danger">{state.error}</p>
            )}
            {state.sessions && state.sessions.sessions.length === 0 && (
              <p className="py-2 text-xs text-fg-muted">
                Nothing importable here any more — it may have been imported since the scan.
              </p>
            )}
            {state.sessions && state.sessions.sessions.length > 0 && (
              <ul className="space-y-1">
                {state.sessions.sessions.map((s) => (
                  <li key={s.sessionId}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-hover">
                      <Checkbox
                        checked={state.selected?.has(s.sessionId) ?? false}
                        disabled={locked}
                        aria-label={describe(s)}
                        onChange={() => onToggleSession(s.sessionId)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-fg">{describe(s)}</span>
                        <span className="tabular mt-0.5 block text-3xs text-fg-muted">
                          {formatDate(s.mtime)} · {formatSize(s.sizeBytes)}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {state.sessions && state.sessions.filtered.length > 0 && (
              <p className="mt-2 px-2 text-3xs text-fg-subtle">
                {state.sessions.filtered.length} more withheld as noise (
                {[...new Set(state.sessions.filtered.map((f) => f.reason))].join(", ")}).
              </p>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

/**
 * The two soft rules, as toggles.
 *
 * Offered only when relaxing one would actually reveal something (or when it is
 * already on, so it can be turned back off) — a permanently visible pair of
 * switches that do nothing on most machines is worse than no switches, and the
 * `excluded` tally is exactly the information needed to tell.
 */
function Filters({
  result,
  includeNonGit,
  includeOutsideHome,
  disabled,
  onIncludeNonGit,
  onIncludeOutsideHome,
}: {
  result: DiscoverResult;
  includeNonGit: boolean;
  includeOutsideHome: boolean;
  disabled: boolean;
  onIncludeNonGit: (on: boolean) => void;
  onIncludeOutsideHome: (on: boolean) => void;
}) {
  const hiddenNonGit = result.excluded["no-git"] ?? 0;
  const hiddenOutside = result.excluded["outside-home"] ?? 0;
  const nonGit = hiddenNonGit > 0 || includeNonGit;
  const outside = hiddenOutside > 0 || includeOutsideHome;
  if (result.scanned === 0) return null;

  return (
    <div className="mt-5 space-y-2 border-t border-edge pt-4">
      <p className="text-xs text-fg-muted">{excludedSentence(result)}</p>
      {nonGit && (
        // A plain row, not a <label> wrapping the Toggle: `Toggle` already IS a
        // label around its own input, and nesting labels is invalid HTML that
        // makes the accessible name the concatenation of both.
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Toggle
            checked={includeNonGit}
            disabled={disabled}
            onChange={onIncludeNonGit}
            label="Also offer directories without a git repository"
          />
          <span>
            Also offer directories without a git repository
            {hiddenNonGit > 0 && ` (${hiddenNonGit} hidden)`}
          </span>
        </div>
      )}
      {outside && (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Toggle
            checked={includeOutsideHome}
            disabled={disabled}
            onChange={onIncludeOutsideHome}
            label="Also offer directories outside your home directory"
          />
          <span>
            Also offer directories outside <code>{result.homeDir}</code>
            {hiddenOutside > 0 && ` (${hiddenOutside} hidden)`}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * `scanned: 0` — the container case.
 *
 * There is no history at all, which on a containerised server is the expected
 * answer rather than a fault: its Claude home is `<dataDir>/claude-home`, not a
 * user's. Naming that directory is the whole content of this screen — it is what
 * turns "Discover is broken" into "mount your history here".
 */
function NoHistory({ claudeHome }: { claudeHome: string }) {
  return (
    <EmptyState
      variant="panel"
      icon={<TerminalIcon width={22} height={22} />}
      title="No Claude Code history on this machine"
      body={
        <>
          Nothing has been recorded under <code className="break-all">{claudeHome}</code>. That is
          normal for a container, whose Claude home is its own rather than yours — bind-mount your
          history there and re-open this page, or import it headlessly with{" "}
          <code>npm run import-chats</code>.
        </>
      }
    />
  );
}

/**
 * The success screen.
 *
 * Deliberately a HEADLINE and nothing more: the rows underneath still carry
 * every per-row sentence, and repeating the failures here would be the same
 * information twice, the second copy detached from the path it is about.
 */
function Done({
  imported,
  projects,
  onGetStarted,
}: {
  imported: number;
  projects: number;
  onGetStarted: () => void;
}) {
  return (
    <div className="mb-6">
      <EmptyState
        variant="panel"
        icon={<FolderIcon width={22} height={22} />}
        title={
          projects === 0
            ? "Nothing was imported"
            : `${projects} project${projects === 1 ? "" : "s"}, ${imported} conversation${imported === 1 ? "" : "s"}`
        }
        body={
          projects === 0
            ? "Every row failed. Each one says why below."
            : "They are in the sidebar now. Anything that did not land says why below."
        }
        action={
          <Button variant="primary" onClick={() => void onGetStarted()}>
            Get started
          </Button>
        }
      />
    </div>
  );
}

function ScanSkeleton() {
  return (
    <div className="space-y-2" aria-label="Scanning" role="status">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-2xl bg-surface-active" />
      ))}
    </div>
  );
}

/**
 * "12 folders scanned; 8 were temp directories, 1 is already a project."
 *
 * The `excluded` tally exists so a short list always has an explanation — the
 * difference between "you have no history" and "all forty of your directories
 * are outside your home" is invisible without it.
 */
export function excludedSentence(result: DiscoverResult): string {
  const parts: string[] = [];
  const labels: Array<[keyof DiscoverResult["excluded"], (n: number) => string]> = [
    ["temp-root", (n) => `${n} in temp directories`],
    ["no-git", (n) => `${n} without a git repository`],
    ["outside-home", (n) => `${n} outside your home directory`],
    ["already-managed", (n) => `${n} already a project`],
    ["no-sessions", (n) => `${n} with nothing importable`],
    ["no-recorded-cwd", (n) => `${n} with no recorded directory`],
    ["missing", (n) => `${n} no longer on disk`],
    ["home-root", (n) => `${n} your home directory itself`],
    ["system-path", (n) => `${n} system directories`],
    ["paddock-internal", (n) => `${n} inside Paddock's own data`],
  ];
  for (const [key, label] of labels) {
    const n = result.excluded[key];
    if (n !== undefined && n > 0) parts.push(label(n));
  }
  const scanned = `${result.scanned} transcript folder${result.scanned === 1 ? "" : "s"} scanned`;
  if (parts.length === 0) return `${scanned}.`;
  return `${scanned}; skipped ${parts.join(", ")}.`;
}

/** The best one-line label available for a session — same rule as `AdoptChatsModal`. */
function describe(candidate: AdoptableCandidate): string {
  const name = candidate.autoName?.trim();
  if (name !== undefined && name !== "") return name;
  const preview = candidate.preview?.trim();
  if (preview !== undefined && preview !== "") return preview;
  return candidate.sessionId;
}

/** Short absolute date — these are historic sessions, so "3m ago" is no use. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
