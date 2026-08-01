import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listJobs } from "@herdctl/core";
import { listRunsForAgents } from "../../src/herdctl-jobs.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Coverage for {@link listRunsForAgents}, the data source behind the Triggers
 * tab's per-trigger last-run column (#535).
 *
 * This function used to ask core for EVERY job record with neither filter nor
 * limit and then filter/slice in JS — which defeats core's job index entirely
 * (with `limit` undefined core retains and hydrates every match) and cost ~2 s
 * per `/triggers/runtime` request on a real instance. It now pushes both
 * `agents` and `limit` down into `listJobs`.
 *
 * That makes ORDER the thing at risk, not just membership: the old shape sorted
 * every record in the directory and then filtered, the new one filters first and
 * lets core sort the survivors. Those agree only because core sorts the whole
 * candidate set before paging — so the central test here diffs the new call
 * against a literal reimplementation of the old one, rather than asserting some
 * order the test author believed was correct.
 */
describe("listRunsForAgents (#535)", () => {
  let stateDir: string;
  const jobsDir = () => path.join(stateDir, "jobs");

  beforeEach(async () => {
    stateDir = await makeTmpDir("paddock-runs-for-agents-");
    await fs.mkdir(jobsDir(), { recursive: true });
  });
  afterEach(async () => {
    await rmTmpDir(stateDir);
  });

  /** Write one job record. `startedAt` drives the sort core applies. */
  async function writeJob(id: string, agent: string, startedAt: string): Promise<void> {
    const record = {
      id,
      agent,
      schedule: null,
      trigger_type: "manual",
      status: "completed",
      exit_reason: "success",
      session_id: null,
      forked_from: null,
      started_at: startedAt,
      finished_at: startedAt,
      duration_seconds: 0,
      output_file: null,
    };
    await fs.writeFile(path.join(jobsDir(), `${id}.yaml`), YAML.stringify(record), "utf8");
  }

  /**
   * The pre-#535 implementation, verbatim: list everything, filter in JS, slice.
   * Kept here as the oracle so the push-down is checked against what it replaced.
   */
  async function legacyListRunsForAgents(agents: string[], limit = 200) {
    if (agents.length === 0) return [];
    const wanted = new Set(agents);
    const { jobs } = await listJobs(jobsDir()).catch(() => ({ jobs: [], errors: 0 }));
    const filtered = jobs.filter((j) => wanted.has(j.agent));
    return limit > 0 ? filtered.slice(0, limit) : filtered;
  }

  /** Interleave agents across time so any per-agent grouping would reorder. */
  async function seedInterleaved(agents: string[], count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await writeJob(
        `job-2026-01-01-i${String(i).padStart(5, "0")}`,
        agents[i % agents.length]!,
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      );
    }
  }

  it("returns the identical set AND order as the pre-#535 scan-and-filter", async () => {
    const all = ["keeper-alpha", "trigger-alpha-nightly", "sweeper-alpha", "keeper-other"];
    await seedInterleaved(all, 40);
    const wanted = ["keeper-alpha", "trigger-alpha-nightly"];

    const legacy = await legacyListRunsForAgents(wanted);
    const current = await listRunsForAgents(stateDir, wanted);

    expect(current.map((j) => j.id)).toEqual(legacy.map((j) => j.id));
    expect(current).toEqual(legacy);
    expect(current.length).toBeGreaterThan(0);
  });

  it("agrees with the legacy shape when the limit truncates", async () => {
    // The interesting case: the cap must be applied AFTER filtering to the
    // wanted agents, not before. Applying it first would let a chatty unwanted
    // agent push every wanted record out of the window.
    const all = ["keeper-alpha", "chatty-other"];
    await seedInterleaved(all, 60);
    const wanted = ["keeper-alpha"];

    const legacy = await legacyListRunsForAgents(wanted, 7);
    const current = await listRunsForAgents(stateDir, wanted, 7);

    expect(current.map((j) => j.id)).toEqual(legacy.map((j) => j.id));
    expect(current).toHaveLength(7);
    expect(current.every((j) => j.agent === "keeper-alpha")).toBe(true);
  });

  it("returns runs most-recent-first", async () => {
    await writeJob("job-2026-01-01-aaaaaa", "keeper-alpha", "2026-01-01T10:00:00.000Z");
    await writeJob("job-2026-01-01-cccccc", "keeper-alpha", "2026-01-03T10:00:00.000Z");
    await writeJob("job-2026-01-01-bbbbbb", "keeper-alpha", "2026-01-02T10:00:00.000Z");

    const runs = await listRunsForAgents(stateDir, ["keeper-alpha"]);

    expect(runs.map((j) => j.started_at)).toEqual([
      "2026-01-03T10:00:00.000Z",
      "2026-01-02T10:00:00.000Z",
      "2026-01-01T10:00:00.000Z",
    ]);
  });

  it("spans several agents in one pass and excludes the rest", async () => {
    await writeJob("job-2026-01-01-aaaaaa", "keeper-alpha", "2026-01-01T10:00:00.000Z");
    await writeJob("job-2026-01-01-bbbbbb", "trigger-alpha-nightly", "2026-01-02T10:00:00.000Z");
    await writeJob("job-2026-01-01-cccccc", "sweeper-alpha", "2026-01-03T10:00:00.000Z");

    const runs = await listRunsForAgents(stateDir, ["keeper-alpha", "trigger-alpha-nightly"]);

    expect(runs.map((j) => j.agent)).toEqual(["trigger-alpha-nightly", "keeper-alpha"]);
  });

  it("tolerates a repeated agent name", async () => {
    // The caller builds `[keeper, ...triggers.map(agentName)]`, and an UNSCOPED
    // schedule trigger runs under the keeper — so the keeper legitimately
    // appears twice. It must not yield duplicate rows.
    await writeJob("job-2026-01-01-aaaaaa", "keeper-alpha", "2026-01-01T10:00:00.000Z");

    const runs = await listRunsForAgents(stateDir, ["keeper-alpha", "keeper-alpha"]);

    expect(runs).toHaveLength(1);
  });

  it("returns [] for no agents without touching the jobs dir", async () => {
    await writeJob("job-2026-01-01-aaaaaa", "keeper-alpha", "2026-01-01T10:00:00.000Z");
    expect(await listRunsForAgents(stateDir, [])).toEqual([]);
  });

  it("returns [] rather than throwing when the jobs dir is missing", async () => {
    // The Triggers view degrades to config-only rather than failing to render.
    const missing = path.join(stateDir, "nope");
    expect(await listRunsForAgents(missing, ["keeper-alpha"])).toEqual([]);
  });

  it("treats limit <= 0 as no cap, still filtered to the agents", async () => {
    await seedInterleaved(["keeper-alpha", "other"], 30);

    const runs = await listRunsForAgents(stateDir, ["keeper-alpha"], 0);

    expect(runs).toHaveLength(15);
    expect(runs.every((j) => j.agent === "keeper-alpha")).toBe(true);
  });
});
