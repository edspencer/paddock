/**
 * The sweeper's `system_prompt` must encode the SAME contract that SweepService
 * actually implements (issue #480).
 *
 * Background: #379 moved the curator from append-a-bullet to whole-file replace.
 * `sweep.ts` and its per-sweep user prompt both moved; the registered
 * `system_prompt` did not. That left the model holding two contradictory
 * instructions, and the destructive reading — "emit exactly ONE bare sentence" —
 * was the one the system prompt endorsed. Since `writeChangelog` replaces the
 * file with whatever comes back, a model that obeyed it wiped CHANGELOG.md down
 * to a single line. That happened in the wild before this was caught.
 *
 * These assertions pin the contract itself rather than the prose, so the prompt
 * stays free to be reworded but cannot silently drift back to append semantics.
 */
import { describe, it, expect } from "vitest";
import { buildSweeperConfig } from "../../src/herdctl-agent-config.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";

// `dataDir` is load-bearing: the sweeper's working directory derives from it, so
// that it never shares a CLI session dir with the keeper (issue #548).
const cfg = { dataDir: "/tmp/data" } as PaddockConfig;

const project = {
  slug: "demo",
  name: "Demo",
  dir: "/tmp/demo",
} as unknown as Project;

const systemPrompt = () => String(buildSweeperConfig(cfg, project).system_prompt);

describe("sweeper system_prompt ↔ writer contract (#480)", () => {
  it("does not ask for a single bare bullet as the whole CHANGELOG", () => {
    const p = systemPrompt();
    // The exact phrasing that caused the wipe, plus the general shape of it.
    expect(p).not.toMatch(/exactly ONE changelog bullet/i);
    expect(p).not.toMatch(/just the bare sentence/i);
    expect(p).not.toMatch(/no date heading/i);
  });

  it("tells the model the CHANGELOG it returns replaces the whole file", () => {
    const p = systemPrompt();
    const changelog = p.slice(p.indexOf("<<<CHANGELOG>>>"), p.indexOf("<<<CLAUDE>>>"));
    expect(changelog).toMatch(/full markdown CHANGELOG\.md/i);
    expect(changelog).toMatch(/REPLACES the current one wholesale/i);
    // Existing history must be preserved — the failure mode was losing it.
    expect(changelog).toMatch(/PRESERVE the existing dated entries/i);
    expect(changelog).toMatch(/NOCHANGE/);
  });

  it("describes CLAUDE.md as a wholesale section replace, not amend-only", () => {
    const p = systemPrompt();
    const claude = p.slice(p.indexOf("<<<CLAUDE>>>"), p.indexOf("<<<END>>>"));
    // `writeClaudeMd` replaces the managed `## Curated notes` section, so an
    // "amend-only / never rewrite existing content" instruction is now false.
    expect(claude).not.toMatch(/amend-only/i);
    expect(claude).not.toMatch(/never rewrite existing content/i);
    expect(claude).not.toMatch(/to APPEND to CLAUDE\.md/i);
    expect(claude).toMatch(/REPLACES that managed section/i);
    expect(claude).toMatch(/DEDUP/);
  });

  it("promises the same number of sections it actually emits", () => {
    const p = systemPrompt();
    const markers = ["<<<OVERVIEW>>>", "<<<CHANGELOG>>>", "<<<CLAUDE>>>"];
    for (const m of markers) expect(p).toContain(m);
    expect(p).toContain("<<<END>>>");
    // The stale prompt said "the two sections" while emitting three.
    expect(p).toMatch(/ONLY the three sections/i);
    expect(p).not.toMatch(/ONLY the two sections/i);
  });

  it("keeps the sweeper tool-less, so the writer stays the only file mutator", () => {
    expect(buildSweeperConfig(cfg, project).allowed_tools).toEqual([]);
  });
});
