/**
 * Unit tests for SweepService (sweep.ts), with a stubbed HerdctlService +
 * ProjectStore. These reach the coalescing / skip-no-activity / failure-retry /
 * watermark-persistence branches that the end-to-end sweep integration test
 * can't drive deterministically.
 *
 * The sweeper "reply" is whatever the stub's runSweeper returns; we assert the
 * service parses the markers and writes OVERVIEW.md + a CHANGELOG bullet, skips
 * when there's no new activity, retries (doesn't advance the session watermark)
 * on unparseable output, and persists the watermark across instances.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SweepService } from "../../src/sweep.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/** A discovered-session stub (only the fields the sweep reads). */
function session(id: string, mtime: string) {
  return { sessionId: id, mtime, autoName: `chat-${id}`, preview: "p", resumable: true };
}

const OK_REPLY =
  "<<<OVERVIEW>>>\n# Overview\nState.\n<<<CHANGELOG>>>\nDid a thing.\n<<<END>>>";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface StubOverrides {
  sessions?: Array<ReturnType<typeof session>>;
  sweeperText?: string;
  sweeperSuccess?: boolean;
}

describe("SweepService", () => {
  let dataDir: string;
  let project: { slug: string; name: string; dir: string; summary: string };
  let overviewWrites: string[];
  let changelogAppends: string[];

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-sweep-");
    project = { slug: "demo", name: "Demo", dir: path.join(dataDir, "demo"), summary: "" };
    await fs.mkdir(project.dir, { recursive: true });
    overviewWrites = [];
    changelogAppends = [];
  });
  afterEach(async () => {
    await rmTmpDir(dataDir);
  });

  /** Build a SweepService over stub herdctl + projects, with 0 min-interval. */
  function makeService(o: StubOverrides = {}) {
    const sessions = o.sessions ?? [session("s1", "2026-06-20T00:00:00.000Z")];
    const runSweeper = vi.fn(async () => ({
      result: {
        success: o.sweeperSuccess ?? true,
        sessionId: "sw1",
        jobId: "job-x",
        error: undefined,
      },
      text: o.sweeperText ?? OK_REPLY,
    }));
    const herdctl = {
      recentSessions: vi.fn(async () => sessions),
      sessionMessages: vi.fn(async () => [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]),
      runSweeper,
    };
    const projects = {
      get: vi.fn(async (slug: string) => {
        if (slug !== project.slug) throw new Error("not found");
        return project;
      }),
      readOverview: vi.fn(async () => ""),
      readFile: vi.fn(async () => "# Changelog\n"),
      writeOverview: vi.fn(async (_slug: string, content: string) => {
        overviewWrites.push(content);
      }),
      appendChangelog: vi.fn(async (_slug: string, line: string) => {
        changelogAppends.push(line);
      }),
    };
    const svc = new SweepService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      herdctl: herdctl as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects: projects as any,
      dataDir,
      minIntervalMs: 0,
      logger: silentLogger,
    });
    return { svc, herdctl, projects, runSweeper };
  }

  it("runs the sweeper and writes OVERVIEW + a CHANGELOG bullet on a parseable reply", async () => {
    const { svc, runSweeper } = makeService();
    svc.enqueue("demo");
    await vi.waitFor(() => expect(runSweeper).toHaveBeenCalled(), { timeout: 2000 });
    await vi.waitFor(() => expect(overviewWrites.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(overviewWrites[0]).toContain("# Overview");
    expect(changelogAppends[0]).toBe("Did a thing.");
    svc.stop();
  });

  it("persists a watermark and SKIPS a follow-up sweep with no new activity", async () => {
    const { svc, runSweeper } = makeService();
    svc.enqueue("demo");
    await vi.waitFor(() => expect(overviewWrites.length).toBe(1), { timeout: 2000 });

    // A state file was written under the data dir.
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "sweep-state.json"), "utf8"));
    expect(state.demo.lastSweptSessionMtime).toBe("2026-06-20T00:00:00.000Z");

    // Enqueue again with the SAME session mtime → no new activity → skipped.
    runSweeper.mockClear();
    svc.enqueue("demo");
    // Give the trailing timer a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(runSweeper).not.toHaveBeenCalled();
    svc.stop();
  });

  it("sweeps again once a NEWER session appears", async () => {
    const { svc, herdctl, runSweeper } = makeService();
    svc.enqueue("demo");
    await vi.waitFor(() => expect(overviewWrites.length).toBe(1), { timeout: 2000 });

    // Newer activity arrives.
    herdctl.recentSessions.mockResolvedValue([session("s2", "2026-06-21T00:00:00.000Z")]);
    runSweeper.mockClear();
    svc.enqueue("demo");
    await vi.waitFor(() => expect(runSweeper).toHaveBeenCalled(), { timeout: 2000 });
    svc.stop();
  });

  it("does NOT advance the session watermark when the sweeper output is unparseable", async () => {
    const { svc } = makeService({ sweeperText: "no markers here, just prose" });
    svc.enqueue("demo");
    // It runs but writes nothing (parse failure → throw → caught).
    await new Promise((r) => setTimeout(r, 200));
    expect(overviewWrites.length).toBe(0);

    // lastSweptAt advanced (don't hot-loop) but lastSweptSessionMtime stayed null
    // (so the next sweep retries the same activity).
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "sweep-state.json"), "utf8"));
    expect(state.demo.lastSweptSessionMtime).toBeNull();
    expect(state.demo.lastSweptAt).toBeGreaterThan(0);
    svc.stop();
  });

  it("skips when the sweeper trigger itself reports failure", async () => {
    const { svc } = makeService({ sweeperSuccess: false });
    svc.enqueue("demo");
    await new Promise((r) => setTimeout(r, 200));
    expect(overviewWrites.length).toBe(0);
    svc.stop();
  });

  it("skips when there are no sessions yet", async () => {
    const { svc, runSweeper } = makeService({ sessions: [] });
    svc.enqueue("demo");
    await new Promise((r) => setTimeout(r, 200));
    expect(runSweeper).not.toHaveBeenCalled();
    expect(overviewWrites.length).toBe(0);
    svc.stop();
  });

  it("coalesces a burst of enqueues into a single sweep", async () => {
    const { svc, runSweeper } = makeService();
    // Three rapid enqueues before the trailing timer fires.
    svc.enqueue("demo");
    svc.enqueue("demo");
    svc.enqueue("demo");
    await vi.waitFor(() => expect(runSweeper).toHaveBeenCalledTimes(1), { timeout: 2000 });
    svc.stop();
  });

  it("drops silently when the project was deleted between enqueue and run", async () => {
    const { svc, runSweeper } = makeService();
    svc.enqueue("ghost"); // projects.get throws for this slug
    await new Promise((r) => setTimeout(r, 100));
    expect(runSweeper).not.toHaveBeenCalled();
    svc.stop();
  });

  it("reuses a persisted watermark across SweepService instances", async () => {
    // Seed a watermark with a future-ish mtime so the next sweep is skipped.
    await fs.writeFile(
      path.join(dataDir, "sweep-state.json"),
      JSON.stringify({ demo: { lastSweptSessionMtime: "2099-01-01T00:00:00.000Z", lastSweptAt: 1 } }),
      "utf8",
    );
    const { svc, runSweeper } = makeService(); // sessions default to 2026 mtime
    svc.enqueue("demo");
    await new Promise((r) => setTimeout(r, 100));
    // The stored 2099 watermark is newer than the 2026 session → skipped.
    expect(runSweeper).not.toHaveBeenCalled();
    svc.stop();
  });

  it("stop() clears pending timers", async () => {
    const { svc, runSweeper } = makeService({ sessions: [session("s1", "2026-06-20T00:00:00.000Z")] });
    // Use a non-zero interval so the timer is pending, then stop before it fires.
    const svc2 = new SweepService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      herdctl: { recentSessions: async () => [], sessionMessages: async () => [], runSweeper } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects: { get: async () => project } as any,
      dataDir,
      minIntervalMs: 60_000,
      logger: silentLogger,
    });
    svc2.enqueue("demo");
    svc2.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(runSweeper).not.toHaveBeenCalled();
    svc.stop();
  });
});
