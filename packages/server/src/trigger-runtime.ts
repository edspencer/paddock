/**
 * Per-trigger RUNTIME state builder (Epic T follow-up / #327) — the live "last-run /
 * next-run / status" view the Triggers tab renders alongside each trigger's config.
 *
 * When Epic T (#305 / T4) folded the Settings→Schedules section into the unified
 * Triggers tab, two capabilities were dropped because {@link TriggerDto} carries
 * trigger *config* only, not herdctl *runtime* state: the old section could show a
 * schedule's last/next run + status, and could fire it on demand. This module restores
 * the STATUS half — it JOINS the config DTOs with two herdctl runtime sources:
 *
 *   - **`ScheduleInfo`** (the cron scheduler's live state, keyed by trigger name — the
 *     same key the forwarded `schedules` block uses): `nextRunAt` (the only source of a
 *     future fire time), `lastRunAt`, `status` (idle/running/disabled), and `lastError`.
 *     Meaningful for SCHEDULE-type triggers only.
 *   - **job records** (`JobMetadata`, per the E3/#268 run-history pattern): the trigger's
 *     most-recent RUN — its session id, terminal status, exit reason, timing, and the
 *     agent's one-line summary. Attributable ONLY for a trigger that runs on its OWN
 *     scoped `trigger-<slug>-<name>` agent ({@link triggerRunsOnOwnAgent}): every event
 *     trigger, and a schedule trigger with a `run.tools` allow-list (T2). An UNSCOPED
 *     schedule trigger runs as the shared keeper, whose job records can't be attributed
 *     back to one trigger — so its last-run falls back to `ScheduleInfo.lastRunAt`.
 *
 * The build step is deliberately PURE (no I/O): the route resolves the DTOs, the flat
 * job list ({@link HerdctlService.listRunsForAgents}) and the schedule state
 * ({@link HerdctlService.listAgentSchedules}), then hands them here so the join stays
 * unit-testable — the same split {@link import("./runs.js").buildProjectRuns} uses.
 */
import type { JobMetadata } from "@herdctl/core";
import { triggerAgentName } from "./herdctl.js";
import { triggerRunsOnOwnAgent, type TriggerDto } from "./trigger-config.js";

/**
 * The slice of herdctl's `ScheduleInfo` this builder consumes — a local structural
 * type (mirrors the one in routes.ts / ws.ts) so the module stays off
 * `@herdctl/core`'s import surface. Keyed by the trigger's name.
 */
export interface ScheduleRuntimeInfo {
  status?: "idle" | "running" | "disabled";
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string | null;
}

/** The trigger's most-recent RUN, projected from a herdctl job record (or a schedule fire). */
export interface TriggerLastRun {
  /** herdctl job id, or null when the last-run is only known from schedule state. */
  jobId: string | null;
  /** The chat the run belongs to (link target), or null. */
  sessionId: string | null;
  /** Terminal/live status: completed | failed | cancelled | running | pending. */
  status: string;
  /** Why it exited (success | error | max_turns | timeout | cancelled), if recorded. */
  exitReason: string | null;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** ISO timestamp the run finished, or null while running / unrecorded. */
  finishedAt: string | null;
  /** Wall-clock seconds, or null while running / unrecorded. */
  durationSeconds: number | null;
  /** The agent's own one-line summary of the run, when it wrote one. */
  summary: string | null;
}

/** One trigger's live runtime state — the "status" half the Triggers tab renders. */
export interface TriggerRuntime {
  /** The trigger's name (its project.yaml map key). */
  name: string;
  /** WHEN discriminant, echoed so the client styles per type without re-parsing. */
  type: "schedule" | "event" | "webhook";
  /** True when a run is in flight (a live job, or the cron scheduler reports running). */
  running: boolean;
  /** ISO timestamp of the next scheduled fire (SCHEDULE triggers only), else null. */
  nextRunAt: string | null;
  /**
   * The cron scheduler's status for a SCHEDULE trigger (idle/running/disabled), else
   * null. Falls back to disabled/idle from the config `enabled` when herdctl hasn't
   * armed it yet (or the keeper isn't running).
   */
  scheduleStatus: string | null;
  /** The last fire's error message (SCHEDULE triggers), or null. */
  lastError: string | null;
  /** The most-recent run, or null when the trigger has never fired. */
  lastRun: TriggerLastRun | null;
}

/** Project a job record onto the {@link TriggerLastRun} shape. */
function lastRunFromJob(job: JobMetadata): TriggerLastRun {
  return {
    jobId: job.id,
    sessionId: job.session_id ?? null,
    status: job.status,
    exitReason: job.exit_reason ?? null,
    startedAt: job.started_at,
    finishedAt: job.finished_at ?? null,
    durationSeconds: job.duration_seconds ?? null,
    summary: job.summary ?? null,
  };
}

/**
 * Synthesize a minimal {@link TriggerLastRun} from the cron scheduler's `lastRunAt`
 * for an UNSCOPED schedule trigger (no attributable job record). herdctl tracks only a
 * timestamp + a `lastError`, so status is inferred: `failed` when the last fire erred,
 * else `completed` (a still-running fire is surfaced via {@link TriggerRuntime.running}
 * / `scheduleStatus`, not here).
 */
function lastRunFromSchedule(info: ScheduleRuntimeInfo): TriggerLastRun | null {
  if (!info.lastRunAt) return null;
  return {
    jobId: null,
    sessionId: null,
    status: info.lastError ? "failed" : "completed",
    exitReason: info.lastError ? "error" : null,
    startedAt: info.lastRunAt,
    finishedAt: info.lastRunAt,
    durationSeconds: null,
    summary: null,
  };
}

/**
 * Join trigger config DTOs with herdctl runtime state into the per-trigger status view.
 *
 * @param triggers  The project's trigger DTOs (config only).
 * @param runs      Job records for the project's keeper + trigger agents, most-recent
 *                  first (as {@link HerdctlService.listRunsForAgents} returns). Grouped
 *                  by `agent` here; a scoped trigger's newest own-agent job is its run.
 * @param schedules The cron scheduler's live `ScheduleInfo` for the keeper's forwarded
 *                  schedules (keyed by trigger name).
 * @param slug      The project slug — to resolve each trigger's scoped agent name.
 */
export function buildTriggerRuntime(
  triggers: TriggerDto[],
  runs: JobMetadata[],
  schedules: Array<ScheduleRuntimeInfo & { name: string }>,
  slug: string,
): TriggerRuntime[] {
  // Newest job per agent — `runs` is already most-recent-first, so the FIRST match wins.
  const newestByAgent = new Map<string, JobMetadata>();
  for (const job of runs) {
    if (!newestByAgent.has(job.agent)) newestByAgent.set(job.agent, job);
  }
  const scheduleByName = new Map(schedules.map((s) => [s.name, s]));

  return triggers.map((dto): TriggerRuntime => {
    const type = dto.trigger.type;
    const isSchedule = type === "schedule";
    const info = isSchedule ? scheduleByName.get(dto.name) : undefined;

    // A scoped trigger (every event; a schedule with a `run.tools` allow-list) writes
    // job records under its OWN agent — attribute its newest one. An unscoped schedule
    // runs as the shared keeper (no per-trigger attribution) — fall back to the cron
    // scheduler's timestamp.
    const job = triggerRunsOnOwnAgent(dto)
      ? newestByAgent.get(triggerAgentName(slug, dto.name))
      : undefined;
    const lastRun = job ? lastRunFromJob(job) : info ? lastRunFromSchedule(info) : null;

    const running = job?.status === "running" || info?.status === "running" || false;
    const scheduleStatus = isSchedule
      ? info?.status ?? (dto.enabled === false ? "disabled" : "idle")
      : null;

    return {
      name: dto.name,
      type,
      running,
      nextRunAt: isSchedule ? info?.nextRunAt ?? null : null,
      scheduleStatus,
      lastError: isSchedule ? info?.lastError ?? null : null,
      lastRun,
    };
  });
}
