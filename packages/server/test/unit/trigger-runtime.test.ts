/**
 * Per-trigger RUNTIME builder (Epic T follow-up / #327).
 *
 * Unit-tests the PURE join that powers the Triggers tab's last-run / next-run / status
 * columns: trigger config DTOs + herdctl job records + the cron scheduler's
 * `ScheduleInfo` → one `TriggerRuntime` per trigger. Covers the three attribution
 * shapes that matter:
 *
 *  1. a SCOPED trigger (event, or a schedule with a `run.tools` allow-list) whose runs
 *     land under its OWN `trigger-<slug>-<name>` agent → rich last-run from the job;
 *  2. an UNSCOPED schedule (runs as the shared keeper, no attributable job) → last-run
 *     falls back to the scheduler's `lastRunAt`, and next-run comes from `nextRunAt`;
 *  3. an event trigger with no run yet → null last-run, no next-run.
 */
import { describe, it, expect } from "vitest";
import type { JobMetadata } from "@herdctl/core";
import { buildTriggerRuntime, type ScheduleRuntimeInfo } from "../../src/trigger-runtime.js";
import { triggerAgentName } from "../../src/herdctl.js";
import { toTriggerDto } from "../../src/triggers.js";
import type { PaddockTrigger } from "../../src/trigger-config.js";

const SLUG = "proj";

function dto(name: string, trigger: PaddockTrigger) {
  return toTriggerDto(SLUG, name, trigger);
}

function job(over: Partial<JobMetadata> & { agent: string; id: string }): JobMetadata {
  return {
    trigger_type: "manual",
    status: "completed",
    started_at: "2026-07-20T10:00:00.000Z",
    ...over,
  } as JobMetadata;
}

function sched(name: string, over: Partial<ScheduleRuntimeInfo> = {}): ScheduleRuntimeInfo & { name: string } {
  return { name, status: "idle", lastRunAt: null, nextRunAt: null, lastError: null, ...over };
}

describe("buildTriggerRuntime (#327)", () => {
  it("attributes a SCOPED event trigger's newest own-agent job as its last-run", () => {
    const t = dto("cleanup", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "x", tools: ["Bash"], session: "new" },
      enabled: true,
    });
    const agent = triggerAgentName(SLUG, "cleanup");
    // Most-recent-first, as listRunsForAgents returns.
    const runs = [
      job({ id: "job-new", agent, session_id: "sess-2", status: "completed", exit_reason: "success", started_at: "2026-07-20T12:00:00.000Z", finished_at: "2026-07-20T12:01:00.000Z", duration_seconds: 60, summary: "did the thing" }),
      job({ id: "job-old", agent, session_id: "sess-1", started_at: "2026-07-20T09:00:00.000Z" }),
      // A different trigger's job must NOT bleed in.
      job({ id: "job-other", agent: triggerAgentName(SLUG, "other"), session_id: "sess-x" }),
    ];

    const [rt] = buildTriggerRuntime([t], runs, [], SLUG);
    expect(rt.name).toBe("cleanup");
    expect(rt.type).toBe("event");
    expect(rt.running).toBe(false);
    expect(rt.nextRunAt).toBeNull(); // events have no scheduled fire
    expect(rt.scheduleStatus).toBeNull();
    expect(rt.lastRun).toMatchObject({
      jobId: "job-new",
      sessionId: "sess-2",
      status: "completed",
      exitReason: "success",
      durationSeconds: 60,
      summary: "did the thing",
    });
  });

  it("surfaces next-run + scheduler status for a SCOPED schedule trigger, last-run from its job", () => {
    const t = dto("daily", {
      trigger: { type: "schedule", cron: "0 9 * * *" },
      run: { prompt: "curate", tools: ["Read"], session: "new" },
      enabled: true,
    });
    const agent = triggerAgentName(SLUG, "daily");
    const runs = [job({ id: "job-1", agent, session_id: "s1", started_at: "2026-07-20T09:00:00.000Z", finished_at: "2026-07-20T09:02:00.000Z" })];
    const schedules = [sched("daily", { nextRunAt: "2026-07-21T09:00:00.000Z", lastRunAt: "2026-07-20T09:00:00.000Z", status: "idle" })];

    const [rt] = buildTriggerRuntime([t], runs, schedules, SLUG);
    expect(rt.nextRunAt).toBe("2026-07-21T09:00:00.000Z");
    expect(rt.scheduleStatus).toBe("idle");
    // The rich job wins over the scheduler's bare timestamp.
    expect(rt.lastRun?.jobId).toBe("job-1");
    expect(rt.lastRun?.sessionId).toBe("s1");
  });

  it("falls back to scheduler lastRunAt for an UNSCOPED schedule (keeper-run, no attributable job)", () => {
    const t = dto("nightly", {
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "curate", tools: [], session: "new" }, // no tools → runs as keeper
      enabled: true,
    });
    // A keeper job exists but is NOT attributable to this specific trigger — must be ignored.
    const runs = [job({ id: "job-keeper", agent: "keeper-proj", session_id: "k1" })];
    const schedules = [sched("nightly", { nextRunAt: "2026-07-20T13:00:00.000Z", lastRunAt: "2026-07-20T12:00:00.000Z" })];

    const [rt] = buildTriggerRuntime([t], runs, schedules, SLUG);
    expect(rt.nextRunAt).toBe("2026-07-20T13:00:00.000Z");
    // Synthesized last-run from the scheduler (no job id/session), status completed.
    expect(rt.lastRun).toMatchObject({ jobId: null, sessionId: null, status: "completed", startedAt: "2026-07-20T12:00:00.000Z" });
  });

  it("marks failed when the scheduler recorded a lastError", () => {
    const t = dto("nightly", {
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "curate", tools: [], session: "new" },
      enabled: true,
    });
    const schedules = [sched("nightly", { lastRunAt: "2026-07-20T12:00:00.000Z", lastError: "boom" })];
    const [rt] = buildTriggerRuntime([t], [], schedules, SLUG);
    expect(rt.lastError).toBe("boom");
    expect(rt.lastRun).toMatchObject({ status: "failed", exitReason: "error" });
  });

  it("reports running when the newest job or the scheduler is running", () => {
    const scoped = dto("ev", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "x", tools: ["Bash"], session: "new" },
      enabled: true,
    });
    const runs = [job({ id: "j", agent: triggerAgentName(SLUG, "ev"), session_id: "s", status: "running", finished_at: null })];
    const [a] = buildTriggerRuntime([scoped], runs, [], SLUG);
    expect(a.running).toBe(true);
    expect(a.lastRun?.status).toBe("running");

    const unscoped = dto("nightly", {
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "curate", tools: [], session: "new" },
      enabled: true,
    });
    const [b] = buildTriggerRuntime([unscoped], [], [sched("nightly", { status: "running" })], SLUG);
    expect(b.running).toBe(true);
  });

  it("an event trigger with no run yet has a null last-run and no next-run", () => {
    const t = dto("fresh", {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "x", tools: [], session: "new" },
      enabled: false,
    });
    const [rt] = buildTriggerRuntime([t], [], [], SLUG);
    expect(rt.lastRun).toBeNull();
    expect(rt.nextRunAt).toBeNull();
    expect(rt.running).toBe(false);
  });

  it("a disabled schedule with no scheduler entry reports scheduleStatus 'disabled'", () => {
    const t = dto("off", {
      trigger: { type: "schedule", interval: "1h" },
      run: { prompt: "x", tools: [], session: "new" },
      enabled: false,
    });
    const [rt] = buildTriggerRuntime([t], [], [], SLUG);
    expect(rt.scheduleStatus).toBe("disabled");
    expect(rt.nextRunAt).toBeNull();
  });
});
