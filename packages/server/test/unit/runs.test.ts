import { describe, it, expect } from "vitest";
import type { JobMetadata } from "@herdctl/core";
import { buildProjectRuns, isUnattended } from "../../src/runs.js";
import type { RunProvenance } from "../../src/run-provenance.js";

/**
 * Unit coverage for the run-history builder (E3 / #268 / DD-6): the join of raw
 * herdctl job records with the provenance marker (true human/scheduled/spawned
 * origin, since paddock writes trigger_type:"manual"), the since-last-visit
 * `isNew` split + `newUnattended` digest count, and the P3 cost seam staying null.
 */

/** Minimal job-record factory — only the fields the builder reads. */
function job(over: Partial<JobMetadata>): JobMetadata {
  return {
    id: "job-2026-07-18-aaaaaa",
    agent: "keeper-demo",
    trigger_type: "manual",
    status: "completed",
    started_at: "2026-07-18T10:00:00.000Z",
    finished_at: "2026-07-18T10:01:00.000Z",
    duration_seconds: 60,
    session_id: "s-human",
    ...over,
  } as JobMetadata;
}

describe("isUnattended", () => {
  it("is true only for scheduled + spawned origins", () => {
    expect(isUnattended("scheduled")).toBe(true);
    expect(isUnattended("spawned")).toBe(true);
    expect(isUnattended("human")).toBe(false);
  });
});

describe("buildProjectRuns", () => {
  const prov = new Map<string, RunProvenance>([
    ["s-sched", { origin: "scheduled", depth: 0 }],
    ["s-spawn", { origin: "spawned", depth: 2 }],
    // s-human intentionally has NO marker → defaults to human/0.
  ]);

  it("joins each run with its provenance; unmarked/no-session default to human/0", () => {
    const { runs } = buildProjectRuns(
      [
        job({ id: "j1", session_id: "s-sched", schedule: "nightly" }),
        job({ id: "j2", session_id: "s-spawn" }),
        job({ id: "j3", session_id: "s-human" }),
        job({ id: "j4", session_id: null }),
      ],
      prov,
      0,
    );
    expect(runs.map((r) => [r.jobId, r.origin, r.depth])).toEqual([
      ["j1", "scheduled", 0],
      ["j2", "spawned", 2],
      ["j3", "human", 0],
      ["j4", "human", 0],
    ]);
    // Schedule name + null session flow through.
    expect(runs[0].schedule).toBe("nightly");
    expect(runs[3].sessionId).toBeNull();
  });

  it("preserves the incoming (most-recent-first) order", () => {
    const { runs } = buildProjectRuns(
      [job({ id: "newer" }), job({ id: "older" })],
      prov,
      0,
    );
    expect(runs.map((r) => r.jobId)).toEqual(["newer", "older"]);
  });

  it("flags runs completed after the watermark as new; counts unattended ones", () => {
    const watermark = Date.parse("2026-07-18T12:00:00.000Z");
    const { runs, newUnattended, lastSeen } = buildProjectRuns(
      [
        // after watermark + unattended → new AND counted
        job({ id: "sched-new", session_id: "s-sched", finished_at: "2026-07-18T13:00:00.000Z" }),
        // after watermark but human → new, NOT counted
        job({ id: "human-new", session_id: "s-human", finished_at: "2026-07-18T13:00:00.000Z" }),
        // before watermark + unattended → not new
        job({ id: "spawn-old", session_id: "s-spawn", finished_at: "2026-07-18T11:00:00.000Z" }),
      ],
      prov,
      watermark,
    );
    expect(runs.find((r) => r.jobId === "sched-new")?.isNew).toBe(true);
    expect(runs.find((r) => r.jobId === "human-new")?.isNew).toBe(true);
    expect(runs.find((r) => r.jobId === "spawn-old")?.isNew).toBe(false);
    expect(newUnattended).toBe(1); // only sched-new
    expect(lastSeen).toBe(watermark);
  });

  it("a still-running run counts as new off its start time", () => {
    const watermark = Date.parse("2026-07-18T09:00:00.000Z");
    const { runs } = buildProjectRuns(
      [job({ id: "live", session_id: "s-sched", status: "running", finished_at: null, duration_seconds: null })],
      prov,
      watermark,
    );
    expect(runs[0].isNew).toBe(true);
    expect(runs[0].status).toBe("running");
    expect(runs[0].finishedAt).toBeNull();
    expect(runs[0].durationSeconds).toBeNull();
  });

  it("cost is always the null P3 seam", () => {
    const { runs } = buildProjectRuns([job({})], prov, 0);
    expect(runs[0].cost).toBeNull();
  });
});
