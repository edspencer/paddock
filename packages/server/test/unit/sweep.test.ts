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
import { SweepService, stripBoxConventions } from "../../src/sweep.js";
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
  /** Pre-existing CLAUDE.md content the sweeper is shown (issue #177). */
  claudeMd?: string;
  /** Make appendClaudeMd reject to exercise the non-fatal path. */
  claudeAppendThrows?: boolean;
  /**
   * Content of the optional per-project `.paddock/hooks/sweep.md` (issue #G2).
   * `undefined` → the file is absent (readFile rejects, as on disk).
   */
  sweepInstructions?: string;
}

describe("SweepService", () => {
  let dataDir: string;
  let project: { slug: string; name: string; dir: string; summary: string };
  let overviewWrites: string[];
  let changelogAppends: string[];
  let claudeAppends: string[];

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-sweep-");
    project = { slug: "demo", name: "Demo", dir: path.join(dataDir, "demo"), summary: "" };
    await fs.mkdir(project.dir, { recursive: true });
    overviewWrites = [];
    changelogAppends = [];
    claudeAppends = [];
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
      readFile: vi.fn(async (_slug: string, name: string) => {
        if (name === ".paddock/hooks/sweep.md") {
          // Absent file → reject (mirrors fs.readFile ENOENT), which the service
          // catches into "" (no extra instructions).
          if (o.sweepInstructions === undefined) throw new Error("ENOENT");
          return o.sweepInstructions;
        }
        return "# Changelog\n";
      }),
      readClaudeMd: vi.fn(async () => o.claudeMd ?? ""),
      writeOverview: vi.fn(async (_slug: string, content: string) => {
        overviewWrites.push(content);
      }),
      appendChangelog: vi.fn(async (_slug: string, line: string) => {
        changelogAppends.push(line);
      }),
      appendClaudeMd: vi.fn(async (_slug: string, addition: string) => {
        if (o.claudeAppendThrows) throw new Error("disk full");
        claudeAppends.push(addition);
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
    // A reply with no <<<CLAUDE>>> section (the OK_REPLY) must not touch CLAUDE.md.
    expect(claudeAppends).toEqual([]);
    svc.stop();
  });

  it("appends to CLAUDE.md when the reply carries a <<<CLAUDE>>> section (#177)", async () => {
    const reply =
      "<<<OVERVIEW>>>\n# Overview\nState.\n<<<CHANGELOG>>>\nDid a thing.\n" +
      "<<<CLAUDE>>>\n- Durable: the API is versioned under /v2.\n<<<END>>>";
    const { svc } = makeService({ sweeperText: reply });
    svc.enqueue("demo");
    await vi.waitFor(() => expect(claudeAppends.length).toBe(1), { timeout: 2000 });
    expect(claudeAppends[0]).toBe("- Durable: the API is versioned under /v2.");
    // The changelog must NOT absorb the CLAUDE marker/section.
    expect(changelogAppends[0]).toBe("Did a thing.");
    expect(overviewWrites[0]).toContain("# Overview");
    svc.stop();
  });

  it("does NOT touch CLAUDE.md for a repo-backed project — the repo owns it (#187)", async () => {
    // A repo-backed project's CLAUDE.md is the external repo's own, upstream-
    // owned file; the sweeper must never write it even when it reports a durable
    // fact. OVERVIEW + CHANGELOG are still curated (sidecarred).
    (project as { repoBacked?: boolean }).repoBacked = true;
    const reply =
      "<<<OVERVIEW>>>\n# Overview\nState.\n<<<CHANGELOG>>>\nDid a thing.\n" +
      "<<<CLAUDE>>>\n- Durable: the API is versioned under /v2.\n<<<END>>>";
    const { svc } = makeService({ sweeperText: reply });
    svc.enqueue("demo");
    await vi.waitFor(() => expect(overviewWrites.length).toBe(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    // OVERVIEW + CHANGELOG curated as usual; CLAUDE.md untouched.
    expect(overviewWrites[0]).toContain("# Overview");
    expect(changelogAppends[0]).toBe("Did a thing.");
    expect(claudeAppends).toEqual([]);
    svc.stop();
  });

  it("does NOT touch CLAUDE.md when the CLAUDE section is NOCHANGE (#177)", async () => {
    const reply =
      "<<<OVERVIEW>>>\n# Overview\nState.\n<<<CHANGELOG>>>\nDid a thing.\n" +
      "<<<CLAUDE>>>\nNOCHANGE\n<<<END>>>";
    const { svc } = makeService({ sweeperText: reply });
    svc.enqueue("demo");
    await vi.waitFor(() => expect(overviewWrites.length).toBe(1), { timeout: 2000 });
    // Give any stray append a chance to land, then assert none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(claudeAppends).toEqual([]);
    svc.stop();
  });

  it("treats a CLAUDE.md append failure as non-fatal (OVERVIEW/CHANGELOG still written) (#177)", async () => {
    const reply =
      "<<<OVERVIEW>>>\n# Overview\nState.\n<<<CHANGELOG>>>\nDid a thing.\n" +
      "<<<CLAUDE>>>\n- something durable\n<<<END>>>";
    const { svc } = makeService({ sweeperText: reply, claudeAppendThrows: true });
    svc.enqueue("demo");
    await vi.waitFor(() => expect(overviewWrites.length).toBe(1), { timeout: 2000 });
    expect(changelogAppends[0]).toBe("Did a thing.");
    // The append threw but was swallowed → the watermark still advanced.
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "sweep-state.json"), "utf8"));
    expect(state.demo.lastSweptSessionMtime).toBe("2026-06-20T00:00:00.000Z");
    svc.stop();
  });

  it("appends `.paddock/hooks/sweep.md` instructions to the sweeper prompt when present (#G2)", async () => {
    const marker = "ALWAYS keep a Glossary section in the overview.";
    const { svc, runSweeper } = makeService({ sweepInstructions: `# Curator notes\n${marker}\n` });
    svc.enqueue("demo");
    await vi.waitFor(() => expect(runSweeper).toHaveBeenCalled(), { timeout: 2000 });
    const prompt = runSweeper.mock.calls[0][1] as string;
    expect(prompt).toContain("=== EXTRA PROJECT-SPECIFIC CURATOR INSTRUCTIONS ===");
    expect(prompt).toContain(marker);
    // Curation still happens as normal.
    expect(overviewWrites[0]).toContain("# Overview");
    svc.stop();
  });

  it("does NOT add the extra-instructions section when `.paddock/hooks/sweep.md` is absent (#G2)", async () => {
    const { svc, runSweeper } = makeService(); // sweepInstructions undefined → file absent
    svc.enqueue("demo");
    await vi.waitFor(() => expect(runSweeper).toHaveBeenCalled(), { timeout: 2000 });
    const prompt = runSweeper.mock.calls[0][1] as string;
    expect(prompt).not.toContain("EXTRA PROJECT-SPECIFIC CURATOR INSTRUCTIONS");
    svc.stop();
  });

  it("treats a blank/whitespace-only `.paddock/hooks/sweep.md` as absent (#G2)", async () => {
    const { svc, runSweeper } = makeService({ sweepInstructions: "   \n\t\n" });
    svc.enqueue("demo");
    await vi.waitFor(() => expect(runSweeper).toHaveBeenCalled(), { timeout: 2000 });
    const prompt = runSweeper.mock.calls[0][1] as string;
    expect(prompt).not.toContain("EXTRA PROJECT-SPECIFIC CURATOR INSTRUCTIONS");
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

  it("normalizes the sweeper's OVERVIEW before writing (strips box-dev sections)", async () => {
    const withBoxConventions =
      "<<<OVERVIEW>>>\n# Demo\n\nA thing.\n\n" +
      "## Local Development\n\nClone into scratch/clones and run `vite` on localhost:4100.\n\n" +
      "## Architecture\n\nMatters.\n<<<CHANGELOG>>>\nDid a thing.\n<<<END>>>";
    const { svc } = makeService({ sweeperText: withBoxConventions });
    svc.enqueue("demo");
    await vi.waitFor(() => expect(overviewWrites.length).toBe(1), { timeout: 2000 });
    expect(overviewWrites[0]).toContain("# Demo");
    expect(overviewWrites[0]).toContain("## Architecture");
    expect(overviewWrites[0]).not.toContain("Local Development");
    expect(overviewWrites[0]).not.toContain("localhost:4100");
    svc.stop();
  });
});

describe("stripBoxConventions", () => {
  it("drops a Local Development section and keeps the rest", () => {
    const input =
      "# Demo\n\nWhat it is.\n\n" +
      "## Local Development\n\nRun `vite` on localhost:4100, backend on :4200.\n\n" +
      "## Architecture\n\nThe real project facts.\n";
    const out = stripBoxConventions(input);
    expect(out).toContain("# Demo");
    expect(out).toContain("## Architecture");
    expect(out).toContain("The real project facts.");
    expect(out).not.toContain("Local Development");
    expect(out).not.toContain("localhost:4100");
    expect(out).not.toContain(":4200");
  });

  it("drops a dropped section's sub-headings but resumes at a same-level heading", () => {
    const input =
      "## Running Locally\n\ntext\n\n### Ports\n\n5001\n\n## Decisions\n\nkeep me\n";
    const out = stripBoxConventions(input);
    expect(out).not.toContain("Running Locally");
    expect(out).not.toContain("Ports");
    expect(out).not.toContain("5001");
    expect(out).toContain("## Decisions");
    expect(out).toContain("keep me");
  });

  it.each([
    "## Dev Server",
    "## Development Server",
    "## Preview Server",
    "## Run Locally",
    "## How to Run",
    "## Local Setup",
    "### Dev Environment",
    "# Serving the App",
  ])("recognizes box-ops heading %s", (heading) => {
    // Terminate with a level-1 heading so it closes a dropped section at any level.
    const out = stripBoxConventions(`${heading}\n\ndrop this\n\n# Keep\n\nkeep this\n`);
    expect(out).not.toContain("drop this");
    expect(out).toContain("keep this");
  });

  it("leaves unrelated content untouched", () => {
    const input = "# Project\n\n## Goals\n\nShip it.\n\n## Open Questions\n\nWhat next?\n";
    expect(stripBoxConventions(input)).toBe(input.trimEnd());
  });

  it("does not treat 'development' inside prose or unrelated headings as a match", () => {
    const input = "# App\n\n## Development Roadmap\n\nQ3 plans.\n";
    expect(stripBoxConventions(input)).toContain("Development Roadmap");
  });

  it("returns the original when stripping would empty the document", () => {
    const input = "## Local Development\n\nonly this section exists\n";
    // Nothing survives → fall back to the original rather than write a blank file.
    expect(stripBoxConventions(input)).toBe(input);
  });

  it("handles empty input", () => {
    expect(stripBoxConventions("")).toBe("");
  });
});
