import { describe, it, expect } from "vitest";
import {
  isKnownInstructionsMode,
  DEFAULT_INSTRUCTIONS_MODE,
  INSTRUCTION_ENTRIES,
} from "../../src/claude-instructions.js";

/**
 * The `claude.instructions` lever (#691) — the vocabulary and the scope.
 *
 * `test/unit/claude-home.test.ts` exercises the behaviour against a real home.
 * What is worth pinning separately is the DEFAULT and the LIST, because both are
 * reversals of what #620 shipped and both are the kind of thing a later change
 * flips without noticing.
 */
describe("claude-instructions (#691)", () => {
  it("defaults to own, reversing #620's unconditional bridge", () => {
    // The case AGAINST this default is real and is kept in the module doc: a
    // user with a curated ~/.claude/CLAUDE.md gets a silent behaviour change.
    // It is the default anyway because "own everywhere means nothing outside the
    // data dir is read" has to be a guarantee rather than a guarantee-with-a-
    // footnote. If this flips back, the footnote won.
    expect(DEFAULT_INSTRUCTIONS_MODE).toBe("own");
  });

  it("governs exactly the four inert-content entries", () => {
    expect([...INSTRUCTION_ENTRIES]).toEqual(["CLAUDE.md", "agents", "commands", "plugins"]);
  });

  it("does not claim settings.json or the credentials file", () => {
    // Those are `claude.hooks` and `claude.credentials`. One entry, one lever —
    // welding two concerns to one key is what #691 exists to undo.
    expect(INSTRUCTION_ENTRIES).not.toContain("settings.json");
    expect(INSTRUCTION_ENTRIES).not.toContain(".credentials.json");
  });

  it("never governs per-instance runtime state", () => {
    for (const runtime of ["projects", "todos", "shell-snapshots", "statsig", "sessions"]) {
      expect(INSTRUCTION_ENTRIES).not.toContain(runtime);
    }
  });

  it("recognises exactly the two modes", () => {
    expect(isKnownInstructionsMode("own")).toBe(true);
    expect(isKnownInstructionsMode("host")).toBe(true);
    expect(isKnownInstructionsMode("hostt")).toBe(false);
    expect(isKnownInstructionsMode("")).toBe(false);
  });
});
