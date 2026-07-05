/**
 * Preload wrapper build/strip round-trip (issue #62). The WS layer wraps and the
 * chat-list strips; single-sourcing them here keeps the two in lock-step.
 */
import { describe, it, expect } from "vitest";
import { wrapPreload, stripPreloadWrapper, PRELOAD_CONTEXT_OPEN } from "../../src/preload.js";

describe("preload wrapper", () => {
  it("strips the wrapper back to exactly the user's request", () => {
    const wrapped = wrapPreload("# Overview\n\nlots of project state here", "do the thing");
    expect(wrapped.startsWith(PRELOAD_CONTEXT_OPEN)).toBe(true);
    expect(stripPreloadWrapper(wrapped)).toBe("do the thing");
  });

  it("round-trips a multi-line request intact", () => {
    const msg = "line one\nline two\n\nline four";
    expect(stripPreloadWrapper(wrapPreload("ctx", msg))).toBe(msg);
  });

  it("leaves a non-wrapped message unchanged", () => {
    expect(stripPreloadWrapper("just a normal message")).toBe("just a normal message");
    // A message that merely mentions the tag but isn't the wrapper is untouched.
    expect(stripPreloadWrapper("talking about <project-context> tags")).toBe(
      "talking about <project-context> tags",
    );
  });

  it("returns the input unchanged when the request marker is absent (truncated wrapper)", () => {
    // Mirrors Claude Code's 100-char preview cutting off inside the overview,
    // before the </project-context> marker — nothing to strip, so leave as-is.
    const truncated = "<project-context>\n# Overview\nsome long overview text that got cut";
    expect(stripPreloadWrapper(truncated)).toBe(truncated);
  });
});
