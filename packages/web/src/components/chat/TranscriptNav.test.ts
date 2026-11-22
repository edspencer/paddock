import { describe, expect, it } from "vitest";
import { NAV_TOP_GAP, navTargets, type NavRow } from "./TranscriptNav";

// Rows 300px tall, 16px apart, the first 24px down: row i starts at 24 + 316i.
// Asks (section starts) at rows 0, 3 and 5.
const asks = new Set([0, 3, 5]);
const rows: NavRow[] = Array.from({ length: 7 }, (_, i) => ({
  top: 24 + 316 * i,
  ask: asks.has(i),
}));
const stop = (i: number) => (i === 0 ? 0 : rows[i].top - NAV_TOP_GAP);
const MAX = 2000;

describe("navTargets", () => {
  it("from the top: nothing above, the next row and the next section below", () => {
    expect(navTargets(rows, 0, MAX)).toEqual({
      up: null,
      back: null,
      down: stop(1),
      forward: stop(3),
    });
  });

  it("from a row's start, Up and Back go to the row and section before", () => {
    expect(navTargets(rows, stop(4), MAX)).toMatchObject({
      up: stop(3),
      back: stop(3),
      down: stop(5),
      forward: stop(5),
    });
    expect(navTargets(rows, stop(3), MAX)).toMatchObject({ up: stop(2), back: stop(0) });
  });

  it("from part-way through a row, Up and Back go to its start first", () => {
    const mid = stop(4) + 150;
    expect(navTargets(rows, mid, MAX)).toMatchObject({ up: stop(4), back: stop(3) });
    // Within the slack of a row's start counts as at it.
    expect(navTargets(rows, stop(4) + 1, MAX)).toMatchObject({ up: stop(3) });
  });

  it("skips rows that are not section starts", () => {
    expect(navTargets(rows, stop(1), MAX)).toMatchObject({ forward: stop(3), back: stop(0) });
  });

  it("clamps stops to the scroll range, and has nothing below at the bottom", () => {
    // Row 6 would stop at 1908, past a range that ends at 1800: Down lands there.
    expect(navTargets(rows, 1700, 1800)).toMatchObject({ down: 1800, forward: null });
    expect(navTargets(rows, 1800, 1800)).toMatchObject({ down: null, forward: null });
  });

  it("has nowhere to go with no rows", () => {
    expect(navTargets([], 0, 0)).toEqual({ up: null, back: null, down: null, forward: null });
  });
});
