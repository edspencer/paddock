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
import { SweepService } from "../../src/sweep.js";
import { isSweeperPrompt } from "../../src/adoptable.js";
import { DEFAULT_CURATION } from "../../src/curation-config.js";
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

/**
 * The curation prompt ↔ adoption-filter contract (#658).
 *
 * The sweeper is a one-shot `claude -p` subprocess, so it writes an ordinary
 * transcript into the project's own chat folder. When no run record binds that
 * session, attribution cannot distinguish it from a session the user typed in a
 * terminal — and the "Import N native chats" button offers paddock's own
 * curation output back to the user (ten such transcripts on the dogfooding
 * instance). `isSweeperPrompt` is what keeps them out of the offer.
 *
 * It matches on the prompt's opening, so it is only as good as its agreement
 * with the prompt `SweepService` really builds. Asserted against the real
 * builder rather than a pasted copy: the sentence has already drifted once
 * ("curating two files in this project directory" → "curating this project's
 * three context files"), and a stale copy here would let it drift again with the
 * filter quietly following.
 */
describe("curation prompt ↔ adoption filter (#658)", () => {
  const promptFor = (over: Partial<Project> = {}): string => {
    const svc = new SweepService({
      herdctl: {} as never,
      projects: {} as never,
      dataDir: "/tmp/data",
      logger: { info() {}, warn() {}, error() {} },
    });
    // `curationPrompt` is private; reached through the index signature rather
    // than exported, so production code keeps its narrow surface.
    const build = (svc as unknown as Record<string, (a: unknown) => string>)["curationPrompt"];
    return build.call(svc, {
      project: { slug: "demo", name: "Demo", summary: "", ...over } as unknown as Project,
      overview: "# Overview",
      changelog: "# Changelog",
      claudeMd: "# CLAUDE",
      digest: "some recent activity",
      extraInstructions: "",
      budget: DEFAULT_CURATION,
    });
  };

  /** Truncate exactly as `extractFirstMessagePreview` does — the filter only ever
   *  sees the first 100 characters, so the marker has to land inside them. */
  const asPreview = (text: string): string =>
    text.length > 100 ? `${text.substring(0, 100)}...` : text;

  it("opens with something the adoption filter recognises", () => {
    expect(isSweeperPrompt(asPreview(promptFor()))).toBe(true);
  });

  it("is still recognised when the project has a summary line", () => {
    expect(isSweeperPrompt(asPreview(promptFor({ summary: "A demo project" } as Partial<Project>))))
      .toBe(true);
  });

  it("does not match an ordinary chat that merely mentions curating", () => {
    expect(isSweeperPrompt("You are curating the wrong file — why does the sweeper do that?")).toBe(
      false,
    );
    expect(isSweeperPrompt("Project: Demo (slug: demo) — what is left before the release?")).toBe(
      false,
    );
  });
});
