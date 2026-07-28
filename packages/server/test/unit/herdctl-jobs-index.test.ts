import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { JobsDirIndex } from "../../src/herdctl-jobs-index.js";
import { lastTurnCompletedAt, lastTurnCompletedAtByProject } from "../../src/herdctl-jobs.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the incremental jobs-dir index (#529) behind the unread
 * affordance.
 *
 * Two things are under test and they pull in opposite directions:
 *
 *  - **Semantics** — `session_id -> max(finished_at)`, per-project grouping by
 *    keeper agent, and "skip, never throw" on a corrupt/half-written record.
 *    These must be byte-identical to the un-indexed scan this replaced; a wrong
 *    unread badge is worse than a slow one.
 *  - **The cache** — a warm scan must not re-parse, AND must still observe every
 *    kind of change: a new record, a running record that later completes, a
 *    rewritten `agent:` (promote/re-attribute), and a deleted record.
 *
 * The freshness cases are the ones with teeth: each fails against a plausible
 * over-eager cache (memoize the derived map; cache by filename alone; cache a
 * record that has no `finished_at` yet).
 */
describe("JobsDirIndex (#529)", () => {
  let stateDir: string;
  const jobsDir = () => path.join(stateDir, "jobs");

  beforeEach(async () => {
    stateDir = await makeTmpDir("paddock-jobs-index-");
    await fs.mkdir(path.join(stateDir, "jobs"), { recursive: true });
  });
  afterEach(async () => {
    await rmTmpDir(stateDir);
  });

  /** Write a job record. `finished` omitted → a still-running record. */
  async function writeJob(
    id: string,
    fields: {
      session_id?: string | null;
      agent?: string | null;
      finished_at?: string | null;
      /** Padding so a rewrite is guaranteed to change the file SIZE too. */
      prompt?: string;
    },
  ): Promise<void> {
    const record = {
      id,
      agent: "agent" in fields ? fields.agent : "keeper-alpha",
      schedule: null,
      trigger_type: "web",
      status: fields.finished_at ? "completed" : "running",
      session_id: fields.session_id ?? null,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: fields.finished_at ?? null,
      prompt: fields.prompt ?? "hello",
    };
    await fs.writeFile(path.join(jobsDir(), `${id}.yaml`), YAML.stringify(record), "utf8");
  }

  // ---------------------------------------------------------------------------
  // Semantics — must match the un-indexed scan exactly
  // ---------------------------------------------------------------------------

  it("maps each session to its LATEST completed turn", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    await writeJob("job-2026-01-01-bbbbbb", {
      session_id: "s1",
      finished_at: "2026-01-03T10:00:00.000Z",
    });
    await writeJob("job-2026-01-01-cccccc", {
      session_id: "s1",
      finished_at: "2026-01-02T10:00:00.000Z",
    });

    const index = new JobsDirIndex(stateDir);
    expect(await lastTurnCompletedAt(index)).toEqual(
      new Map([["s1", "2026-01-03T10:00:00.000Z"]]),
    );
  });

  it("skips records that are still running or not session-resolved", async () => {
    await writeJob("job-2026-01-01-aaaaaa", { session_id: "s1", finished_at: null }); // running
    await writeJob("job-2026-01-01-bbbbbb", {
      session_id: null,
      finished_at: "2026-01-01T10:00:00.000Z",
    }); // unresolved
    await writeJob("job-2026-01-01-cccccc", {
      session_id: "s2",
      finished_at: "2026-01-01T11:00:00.000Z",
    });

    const index = new JobsDirIndex(stateDir);
    expect(await lastTurnCompletedAt(index)).toEqual(
      new Map([["s2", "2026-01-01T11:00:00.000Z"]]),
    );
  });

  it("groups by keeper slug, dropping non-keeper agents", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      agent: "keeper-alpha",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    await writeJob("job-2026-01-01-bbbbbb", {
      session_id: "s2",
      agent: "keeper-beta",
      finished_at: "2026-01-01T11:00:00.000Z",
    });
    // Not a project chat — must not appear under any slug.
    await writeJob("job-2026-01-01-cccccc", {
      session_id: "s3",
      agent: "sweeper-alpha",
      finished_at: "2026-01-01T12:00:00.000Z",
    });
    // No agent at all: counts for the flat map, but cannot be grouped.
    await writeJob("job-2026-01-01-dddddd", {
      session_id: "s4",
      agent: null,
      finished_at: "2026-01-01T13:00:00.000Z",
    });

    const index = new JobsDirIndex(stateDir);
    const byProject = await lastTurnCompletedAtByProject(index);
    expect([...byProject.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(byProject.get("alpha")).toEqual(new Map([["s1", "2026-01-01T10:00:00.000Z"]]));
    expect(byProject.get("beta")).toEqual(new Map([["s2", "2026-01-01T11:00:00.000Z"]]));
    // s4 has no agent, so it is in the flat map but in no project group.
    expect((await lastTurnCompletedAt(index)).get("s4")).toBe("2026-01-01T13:00:00.000Z");
  });

  it("skips a corrupt or half-written record instead of throwing", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    await fs.writeFile(path.join(jobsDir(), "job-2026-01-01-bbbbbb.yaml"), "{[not: yaml", "utf8");
    await fs.writeFile(path.join(jobsDir(), "job-2026-01-01-cccccc.yaml"), "", "utf8");

    const index = new JobsDirIndex(stateDir);
    expect(await lastTurnCompletedAt(index)).toEqual(
      new Map([["s1", "2026-01-01T10:00:00.000Z"]]),
    );
    expect(await lastTurnCompletedAtByProject(index)).toEqual(
      new Map([["alpha", new Map([["s1", "2026-01-01T10:00:00.000Z"]])]]),
    );
  });

  it("returns empty (and does not throw) when the jobs dir does not exist", async () => {
    await fs.rm(jobsDir(), { recursive: true, force: true });
    const index = new JobsDirIndex(stateDir);
    expect(await lastTurnCompletedAt(index)).toEqual(new Map());
    expect(await lastTurnCompletedAtByProject(index)).toEqual(new Map());
  });

  it("ignores non-.yaml files in the jobs dir", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    // Every record has a sibling .jsonl output file; it must never be read.
    await fs.writeFile(path.join(jobsDir(), "job-2026-01-01-aaaaaa.jsonl"), "{}\n", "utf8");
    const index = new JobsDirIndex(stateDir);
    expect(await lastTurnCompletedAt(index)).toEqual(
      new Map([["s1", "2026-01-01T10:00:00.000Z"]]),
    );
  });

  // ---------------------------------------------------------------------------
  // The cache: warm scans skip work…
  // ---------------------------------------------------------------------------

  it("re-parses nothing on a warm scan of an unchanged directory", async () => {
    for (let i = 0; i < 5; i++) {
      await writeJob(`job-2026-01-01-a${i}aaaa`, {
        session_id: `s${i}`,
        finished_at: "2026-01-01T10:00:00.000Z",
      });
    }
    const index = new JobsDirIndex(stateDir);

    await lastTurnCompletedAt(index);
    expect(index.stats.parsed).toBe(5);

    await lastTurnCompletedAt(index);
    expect(index.stats.parsed).toBe(0);
    expect(index.stats.reused).toBe(5);
  });

  it("parses only the records it has never seen", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    const index = new JobsDirIndex(stateDir);
    await lastTurnCompletedAt(index);

    await writeJob("job-2026-01-02-bbbbbb", {
      session_id: "s2",
      finished_at: "2026-01-02T10:00:00.000Z",
    });
    const map = await lastTurnCompletedAt(index);

    expect(index.stats.parsed).toBe(1); // only the new one
    expect(index.stats.reused).toBe(1);
    expect(map.get("s2")).toBe("2026-01-02T10:00:00.000Z");
  });

  it("coalesces concurrent reads onto a single scan", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    const index = new JobsDirIndex(stateDir);
    const [a, b, c] = await Promise.all([index.read(), index.read(), index.read()]);
    expect(index.stats.scans).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  // ---------------------------------------------------------------------------
  // …but a warm scan still sees every change. These are the teeth.
  // ---------------------------------------------------------------------------

  it("picks up a running record once it completes", async () => {
    // The one genuinely MUTABLE record: written mid-turn, rewritten on completion.
    // Caching it as final would freeze the chat's unread state forever.
    await writeJob("job-2026-01-01-aaaaaa", { session_id: "s1", finished_at: null });
    const index = new JobsDirIndex(stateDir);
    expect(await lastTurnCompletedAt(index)).toEqual(new Map());

    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    expect(await lastTurnCompletedAt(index)).toEqual(
      new Map([["s1", "2026-01-01T10:00:00.000Z"]]),
    );
  });

  it("picks up a LATER completion of the same session", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    const index = new JobsDirIndex(stateDir);
    await lastTurnCompletedAt(index);

    // A second turn on the same chat writes its own record.
    await writeJob("job-2026-01-02-bbbbbb", {
      session_id: "s1",
      finished_at: "2026-01-02T10:00:00.000Z",
    });
    expect(await lastTurnCompletedAt(index)).toEqual(
      new Map([["s1", "2026-01-02T10:00:00.000Z"]]),
    );
  });

  it("picks up a re-attributed record (promote rewrites `agent:`)", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      agent: "keeper-alpha",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    const index = new JobsDirIndex(stateDir);
    expect([...(await lastTurnCompletedAtByProject(index)).keys()]).toEqual(["alpha"]);

    // `reattributeSession` rewrites the file in place with a different agent.
    // The prompt padding differs too, so this is caught by size as well as mtime;
    // `HerdctlService` additionally calls `invalidate()` at that write site.
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      agent: "keeper-beta",
      finished_at: "2026-01-01T10:00:00.000Z",
      prompt: "hello there",
    });
    expect([...(await lastTurnCompletedAtByProject(index)).keys()]).toEqual(["beta"]);
  });

  it("drops a record that is deleted from the jobs dir", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    const index = new JobsDirIndex(stateDir);
    expect((await lastTurnCompletedAt(index)).size).toBe(1);

    await fs.rm(path.join(jobsDir(), "job-2026-01-01-aaaaaa.yaml"));
    expect(await lastTurnCompletedAt(index)).toEqual(new Map());
  });

  it("re-reads everything after invalidate()", async () => {
    await writeJob("job-2026-01-01-aaaaaa", {
      session_id: "s1",
      finished_at: "2026-01-01T10:00:00.000Z",
    });
    const index = new JobsDirIndex(stateDir);
    await lastTurnCompletedAt(index);
    expect(index.stats.parsed).toBe(0 + 1);

    index.invalidate();
    await lastTurnCompletedAt(index);
    expect(index.stats.parsed).toBe(1);
    expect(index.stats.reused).toBe(0);
  });

  it("does not leak cache entries for files that no longer exist", async () => {
    for (let i = 0; i < 3; i++) {
      await writeJob(`job-2026-01-01-a${i}aaaa`, {
        session_id: `s${i}`,
        finished_at: "2026-01-01T10:00:00.000Z",
      });
    }
    const index = new JobsDirIndex(stateDir);
    await lastTurnCompletedAt(index);
    await fs.rm(path.join(jobsDir(), "job-2026-01-01-a0aaaa.yaml"));
    await fs.rm(path.join(jobsDir(), "job-2026-01-01-a1aaaa.yaml"));

    await lastTurnCompletedAt(index);
    // One file left → one reused entry, nothing re-parsed, and — the point of
    // this test — the cache is not still holding the two that went away.
    expect(index.stats.reused).toBe(1);
    expect(index.stats.parsed).toBe(0);
    expect(index.stats.tracked).toBe(1);
    expect((await lastTurnCompletedAt(index)).size).toBe(1);
  });
});
