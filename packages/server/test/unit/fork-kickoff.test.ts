import { describe, it, expect } from "vitest";
import { forkKickoffPrompt } from "../../src/ws.js";

/**
 * The fork-kickoff preamble (#214 Phase 2) frames a forked child so it treats the
 * inherited (possibly mid-turn) transcript as context and runs its new directive,
 * instead of inheriting the parent's identity and refusing the seed (QA finding).
 */
describe("forkKickoffPrompt", () => {
  it("wraps the directive with inherited-context framing and preserves it verbatim", () => {
    const out = forkKickoffPrompt("Implement item #3 from the plan above.");
    expect(out).toContain("INHERITED CONTEXT");
    expect(out).toContain("NOT in the middle of the prior");
    expect(out.endsWith("Implement item #3 from the plan above.")).toBe(true);
  });
});
