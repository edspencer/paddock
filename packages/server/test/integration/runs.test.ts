/**
 * Run-history endpoint (E3 / #268 / DD-6): `GET /api/projects/:slug/runs` reads
 * herdctl job records for the project's keeper agent, joins them with the A1
 * provenance marker (#261) so scheduled/spawned runs report their true origin,
 * and folds in the per-user "runs last seen" watermark for the since-last-visit
 * digest. `POST .../runs/seen` advances that watermark (monotonic).
 *
 * We seed job YAMLs + a run-provenance.json sidecar directly into the state/data
 * dirs (no turn run) so all three origins — human, scheduled, spawned — are
 * exercised through the real route without depending on drive mode.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";

const SLUG = "runs-proj";
const KEEPER = `keeper-${SLUG}`;

interface SeedJob {
  id: string;
  session_id: string | null;
  trigger_type?: string;
  status?: string;
  schedule?: string | null;
  forked_from?: string | null;
  started_at: string;
  finished_at?: string | null;
  duration_seconds?: number | null;
  prompt?: string | null;
  agent?: string;
}

async function seedJob(jobsDir: string, j: SeedJob): Promise<void> {
  const record = {
    id: j.id,
    agent: j.agent ?? KEEPER,
    trigger_type: j.trigger_type ?? "manual",
    status: j.status ?? "completed",
    schedule: j.schedule ?? null,
    forked_from: j.forked_from ?? null,
    session_id: j.session_id,
    started_at: j.started_at,
    finished_at: j.finished_at ?? null,
    duration_seconds: j.duration_seconds ?? null,
    prompt: j.prompt ?? null,
  };
  await fs.writeFile(path.join(jobsDir, `${j.id}.yaml`), YAML.stringify(record), "utf8");
}

describe("integration: run-history endpoint (#268)", () => {
  let t: TestApp;
  let jobsDir: string;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    // Create the project (registers the keeper; does NOT run a turn).
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Runs Proj" } });

    const dataDir = path.join(t.tmp, "data");
    jobsDir = path.join(dataDir, ".herdctl", "jobs");
    await fs.mkdir(jobsDir, { recursive: true });

    // Seed provenance for a scheduled + a spawned session (human left unmarked).
    await fs.writeFile(
      path.join(dataDir, "run-provenance.json"),
      JSON.stringify({
        "s-sched": { origin: "scheduled", depth: 0 },
        "s-spawn": { origin: "spawned", depth: 1 },
      }),
      "utf8",
    );

    // Three runs, newest first by started_at. A sweeper record must be excluded.
    await seedJob(jobsDir, {
      id: "job-2026-07-18-sched1",
      session_id: "s-sched",
      schedule: "nightly-triage",
      started_at: "2026-07-18T12:00:00.000Z",
      finished_at: "2026-07-18T12:02:00.000Z",
      duration_seconds: 120,
      prompt: "triage new issues",
    });
    await seedJob(jobsDir, {
      id: "job-2026-07-18-spawn1",
      session_id: "s-spawn",
      started_at: "2026-07-18T11:00:00.000Z",
      finished_at: "2026-07-18T11:00:30.000Z",
      duration_seconds: 30,
      prompt: "child task",
    });
    await seedJob(jobsDir, {
      id: "job-2026-07-18-human1",
      session_id: "s-human",
      trigger_type: "web",
      started_at: "2026-07-18T10:00:00.000Z",
      finished_at: "2026-07-18T10:05:00.000Z",
      duration_seconds: 300,
    });
    // Sweeper agent — must NOT surface as a project run.
    await seedJob(jobsDir, {
      id: "job-2026-07-18-sweep1",
      agent: `sweeper-${SLUG}`,
      session_id: "s-sweep",
      started_at: "2026-07-18T12:30:00.000Z",
    });
  });

  afterAll(async () => {
    await t?.teardown();
  });

  it("lists keeper runs newest-first with joined provenance; excludes the sweeper", async () => {
    const res = await t.app.inject({ method: "GET", url: `/api/projects/${SLUG}/runs` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.runs.map((r: { jobId: string }) => r.jobId)).toEqual([
      "job-2026-07-18-sched1",
      "job-2026-07-18-spawn1",
      "job-2026-07-18-human1",
    ]);
    const [sched, spawn, human] = body.runs;
    expect(sched).toMatchObject({
      origin: "scheduled",
      depth: 0,
      schedule: "nightly-triage",
      status: "completed",
      durationSeconds: 120,
      sessionId: "s-sched",
      cost: null,
    });
    expect(spawn).toMatchObject({ origin: "spawned", depth: 1 });
    expect(human).toMatchObject({ origin: "human", depth: 0, triggerType: "web" });
  });

  it("since-last-visit: every run is new when never seen; seen endpoint clears the digest", async () => {
    const before = (
      await t.app.inject({ method: "GET", url: `/api/projects/${SLUG}/runs` })
    ).json();
    expect(before.lastSeen).toBe(0);
    // 2 unattended (scheduled + spawned) newer than watermark 0.
    expect(before.newUnattended).toBe(2);
    expect(before.runs.every((r: { isNew: boolean }) => r.isNew)).toBe(true);

    // Mark seen at a moment AFTER every seeded run.
    const when = Date.parse("2026-07-19T00:00:00.000Z");
    const seen = await t.app.inject({
      method: "POST",
      url: `/api/projects/${SLUG}/runs/seen`,
      payload: { when },
    });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ ok: true, lastSeen: when });

    const after = (
      await t.app.inject({ method: "GET", url: `/api/projects/${SLUG}/runs` })
    ).json();
    expect(after.lastSeen).toBe(when);
    expect(after.newUnattended).toBe(0);
    expect(after.runs.every((r: { isNew: boolean }) => r.isNew)).toBe(false);
  });

  it("respects ?limit=", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${SLUG}/runs?limit=1`,
    });
    expect(res.json().runs).toHaveLength(1);
    expect(res.json().runs[0].jobId).toBe("job-2026-07-18-sched1");
  });
});
