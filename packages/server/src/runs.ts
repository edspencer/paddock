/**
 * Run-history DTO builder (E3 / #268 / DD-6) — the "while you were away" view.
 *
 * A *run* is one herdctl job record (a keeper turn written by a batch
 * `trigger()`): it carries timing (`started_at`/`finished_at`/`duration_seconds`),
 * `status`, `session_id`, and the schedule/fork that triggered it. This module
 * JOINS those raw records with Paddock's {@link RunProvenanceStore} marker so
 * each run reports its true origin — **human / scheduled / spawned** — plus the
 * spawn `depth`. Provenance is authoritative here: paddock-initiated turns still
 * persist `trigger_type:"manual"` on the job record (see ws.ts), so the
 * scheduled/spawned distinction lives in the provenance store, not in the enum.
 *
 * The build step is deliberately PURE (no I/O): the route resolves the job
 * records ({@link HerdctlService.listProjectRuns}), the provenance map, and the
 * per-user "runs last seen" watermark, then hands them here. That keeps the
 * join, the since-last-visit split, and the cost seam unit-testable.
 *
 * **Cost is P3 (deferred to X1/#378 + X2/#271).** herdctl does not yet persist
 * per-run token accounting on the job record, so {@link RunSummary.cost} is a
 * documented seam that is ALWAYS `null` today; when the accounting lands it slots
 * in here without touching the wire shape.
 */
import type { JobMetadata } from "@herdctl/core";
import type { RunProvenance, TurnOrigin } from "./run-provenance.js";

/**
 * Per-run cost, priced from herdctl's persisted per-model token accounting
 * (DD-4). A SEAM only — always `null` until X1/#378 (herdctl persists the
 * tokens) + X2/#271 (Paddock prices them) land. Shape reserved so adding it is
 * additive.
 */
export interface RunCost {
  /** Total cost in USD across every model the run touched. */
  usd: number;
  /** Whether `usd` is a real SDK figure or a CLI/Max-plan estimate. */
  estimated: boolean;
}

/** One row in the run-history view: a job record joined with its provenance. */
export interface RunSummary {
  /** herdctl job id (`job-YYYY-MM-DD-<rand>`); stable per run. */
  jobId: string;
  /** The chat this run belongs to (link target), or null if unresolved. */
  sessionId: string | null;
  /** How the run came to exist (provenance marker; `human` when unmarked). */
  origin: TurnOrigin;
  /** Spawn hops from the human/scheduled root (0 = root). */
  depth: number;
  /** herdctl's persisted trigger type — a secondary signal (see module note). */
  triggerType: string;
  /** Schedule name that fired this run, when scheduled. */
  schedule: string | null;
  /** Parent job id, when this run was forked from another. */
  forkedFrom: string | null;
  /** Terminal/live status: completed | failed | cancelled | running | pending. */
  status: string;
  /** Why it exited (success | error | max_turns | timeout | cancelled), if done. */
  exitReason: string | null;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** ISO timestamp the run finished, or null while running. */
  finishedAt: string | null;
  /** Wall-clock seconds, or null while running / unrecorded. */
  durationSeconds: number | null;
  /** The prompt the run was given (truncation is the client's job). */
  prompt: string | null;
  /** The agent's own one-line summary of the run, when it wrote one. */
  summary: string | null;
  /**
   * True when the run completed AFTER the viewer's "runs last seen" watermark —
   * i.e. it happened while they were away. Drives the since-last-visit digest.
   */
  isNew: boolean;
  /** Per-run cost — P3 seam, always null today (see {@link RunCost}). */
  cost: RunCost | null;
}

/** The payload the run-history endpoint returns. */
export interface ProjectRuns {
  runs: RunSummary[];
  /** Epoch-ms the viewer last visited the run-history view (0 = never). */
  lastSeen: number;
  /** Count of unattended (scheduled + spawned) runs newer than `lastSeen`. */
  newUnattended: number;
}

/** A run is "unattended" when a schedule or another chat — not a human — ran it. */
export function isUnattended(origin: TurnOrigin): boolean {
  return origin === "scheduled" || origin === "spawned";
}

/**
 * The epoch-ms a run "completed" for since-last-visit purposes: its finish time
 * when it has one, else its start time (a still-running run counts as new the
 * moment it starts). Returns 0 for an unparseable timestamp so it never spuriously
 * counts as new.
 */
function completionMs(job: JobMetadata): number {
  const iso = job.finished_at ?? job.started_at;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Join raw job records with the provenance map and the viewer's watermark into
 * the wire DTO. `jobs` is expected most-recent-first (as `listJobs` returns);
 * order is preserved. `provenanceBySession` maps a session id to its marker;
 * a missing entry (or a null session id) defaults to `human`/depth 0. Runs that
 * completed after `lastSeenMs` are flagged `isNew`.
 */
export function buildProjectRuns(
  jobs: JobMetadata[],
  provenanceBySession: ReadonlyMap<string, RunProvenance>,
  lastSeenMs: number,
): ProjectRuns {
  let newUnattended = 0;
  const runs = jobs.map((job): RunSummary => {
    const sessionId = job.session_id ?? null;
    const prov = sessionId ? provenanceBySession.get(sessionId) : undefined;
    const origin: TurnOrigin = prov?.origin ?? "human";
    const depth = prov?.depth ?? 0;
    const isNew = completionMs(job) > lastSeenMs;
    if (isNew && isUnattended(origin)) newUnattended += 1;
    return {
      jobId: job.id,
      sessionId,
      origin,
      depth,
      triggerType: job.trigger_type,
      schedule: job.schedule ?? null,
      forkedFrom: job.forked_from ?? null,
      status: job.status,
      exitReason: job.exit_reason ?? null,
      startedAt: job.started_at,
      finishedAt: job.finished_at ?? null,
      durationSeconds: job.duration_seconds ?? null,
      prompt: job.prompt ?? null,
      summary: job.summary ?? null,
      isNew,
      cost: null, // P3 seam — see RunCost
    };
  });
  return { runs, lastSeen: lastSeenMs, newUnattended };
}
