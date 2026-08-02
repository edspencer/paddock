import { describe, it, expect } from "vitest";
import { mapWithConcurrency, FILE_FANOUT_CONCURRENCY } from "../../src/concurrency.js";

/**
 * Unit coverage for the bounded fan-out helper behind `/chats/usage` (#544).
 *
 * The helper's whole job is to be indistinguishable from `Promise.all(items.map(fn))`
 * EXCEPT in how many calls are live at once, so the tests come in two halves:
 * the equivalence (order, values, rejection) that callers already rely on, and
 * the bound itself — which is the only reason the helper exists and the only
 * thing a naive rewrite would silently drop.
 */
describe("mapWithConcurrency (#544)", () => {
  /** Run `fn` over `items` while recording how many calls were ever in flight. */
  async function withPeak<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<{ results: R[]; peak: number }> {
    let live = 0;
    let peak = 0;
    const results = await mapWithConcurrency(items, limit, async (item, i) => {
      live++;
      peak = Math.max(peak, live);
      try {
        return await fn(item, i);
      } finally {
        live--;
      }
    });
    return { results, peak };
  }

  const tick = () => new Promise((r) => setTimeout(r, 1));

  it("preserves input order even when items settle out of order", async () => {
    // Reverse-ordered delays: without positional writes the fastest item would
    // land first. Callers index the result against the input, so this is the
    // property that would corrupt `/chats/usage` most quietly if it broke.
    const items = [50, 40, 30, 20, 10, 0];
    const out = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual(items);
  });

  it("matches Promise.all's results exactly", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const fn = async (n: number) => n * 2;
    expect(await mapWithConcurrency(items, 7, fn)).toEqual(await Promise.all(items.map(fn)));
  });

  it("never exceeds the requested bound", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const { results, peak } = await withPeak(items, 8, async (n) => {
      await tick();
      return n;
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(results).toHaveLength(100);
  });

  it("actually reaches the bound rather than serialising", async () => {
    // Guards the opposite failure: a helper that is "safe" by running one at a
    // time would pass every test above while making the endpoint 16× slower.
    const items = Array.from({ length: 100 }, (_, i) => i);
    const { peak } = await withPeak(items, 8, async (n) => {
      await tick();
      return n;
    });
    expect(peak).toBe(8);
  });

  it("clamps a zero or negative limit to serial instead of doing nothing", async () => {
    // Core's `job-index` copy spawns zero workers here and resolves with an array
    // of holes, having never called `fn`. That is the bug this clamp exists for.
    for (const limit of [0, -1, Number.NaN]) {
      const calls: number[] = [];
      const out = await mapWithConcurrency([1, 2, 3], limit, async (n) => {
        calls.push(n);
        return n;
      });
      expect(out, `limit=${limit}`).toEqual([1, 2, 3]);
      expect(calls, `limit=${limit}`).toEqual([1, 2, 3]);
    }
  });

  it("caps workers at the item count for a limit larger than the input", async () => {
    const { peak, results } = await withPeak([1, 2], 64, async (n) => {
      await tick();
      return n;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([1, 2]);
  });

  it("handles an empty input without spawning a worker", async () => {
    let called = 0;
    const out = await mapWithConcurrency([], 16, async () => {
      called++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  it("propagates a rejection like Promise.all does", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("keeps the shipped bound in the range the measurements cover", () => {
    // 16 measured faster than unbounded at 4× less peak RSS; the doc's data
    // covers 16-64. A change outside that band needs re-measuring, not a nudge.
    expect(FILE_FANOUT_CONCURRENCY).toBeGreaterThanOrEqual(16);
    expect(FILE_FANOUT_CONCURRENCY).toBeLessThanOrEqual(64);
  });
});
