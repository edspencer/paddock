import { describe, it, expect } from "vitest";
import { normalizeBatchSessionIds, BATCH_SESSIONS_MAX } from "../../src/chat-dto.js";

/**
 * Body validation for the batch (subtree) chat routes (#508).
 *
 * The interesting property is that it is ALL-OR-NOTHING. These routes exist so a
 * parent and its descendants can't end up in different states; quietly dropping
 * one bad id and applying the rest would manufacture exactly the torn family they
 * were added to prevent, so a single bad entry fails the whole request.
 */
describe("normalizeBatchSessionIds (#508)", () => {
  it("accepts a list of safe ids and de-duplicates it", () => {
    expect(normalizeBatchSessionIds(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("accepts real session-id shapes (UUIDs)", () => {
    const id = "0b6f2a1e-9c3d-4f77-8a10-2b5c6d7e8f90";
    expect(normalizeBatchSessionIds([id])).toEqual([id]);
  });

  it("rejects a non-array, an empty array, and a list over the cap", () => {
    expect(normalizeBatchSessionIds(undefined)).toBeNull();
    expect(normalizeBatchSessionIds("a")).toBeNull();
    expect(normalizeBatchSessionIds({ 0: "a" })).toBeNull();
    expect(normalizeBatchSessionIds([])).toBeNull();
    expect(
      normalizeBatchSessionIds(Array.from({ length: BATCH_SESSIONS_MAX + 1 }, (_, i) => `s${i}`)),
    ).toBeNull();
    // …and the cap itself is fine.
    expect(
      normalizeBatchSessionIds(Array.from({ length: BATCH_SESSIONS_MAX }, (_, i) => `s${i}`)),
    ).toHaveLength(BATCH_SESSIONS_MAX);
  });

  it("rejects the WHOLE batch when any single id is unsafe", () => {
    // Path traversal, separators, and non-strings — none of these may be silently
    // skipped, because the caller would then apply a partial subtree action.
    expect(normalizeBatchSessionIds(["good", "../../etc/passwd"])).toBeNull();
    expect(normalizeBatchSessionIds(["good", "a/b"])).toBeNull();
    expect(normalizeBatchSessionIds(["good", ""])).toBeNull();
    expect(normalizeBatchSessionIds(["good", 7])).toBeNull();
    expect(normalizeBatchSessionIds(["good", null])).toBeNull();
  });
});
