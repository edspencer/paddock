/**
 * concurrency — bounded fan-out for the routes that touch one file per chat.
 *
 * ## Why this exists
 *
 * Several endpoints map over every session in a project and open a transcript
 * per session. Written as `Promise.all(sessions.map(...))` that starts EVERY
 * read at once: on a real instance that is 1,515 concurrent read streams, each
 * buffering a transcript that averages ~350 KB. The work is identical either
 * way — the reads just all land in memory at the same moment instead of a few
 * at a time.
 *
 * Measured on that corpus (`GET /chats/usage`, issue #544):
 *
 * | concurrency | wall time | peak RSS |
 * |---|---|---|
 * | unbounded (1,515) | 4,510 ms | 706 MB |
 * | 64 | 4,477 ms | 280 MB |
 * | 16 | 4,329 ms | 178 MB |
 *
 * Bounding it is not a latency trade: the bounded runs were marginally FASTER,
 * because 1,515 interleaved streams cost more in scheduling and GC pressure than
 * they buy in overlap. The disk is not the bottleneck at this size — the parse
 * is, and the parse is single-threaded regardless.
 *
 * ## Why a local copy
 *
 * `@herdctl/core` has this function twice (`state/job-index.ts` and
 * `state/utils/concurrency.ts`) and exports NEITHER from the package root, so it
 * is not reachable from here today. Consolidating and exporting the survivor is
 * filed upstream as **herdctl#421**; when that lands, this module should be
 * deleted and the import repointed at core. The clamping below matches the
 * `state/utils` variant deliberately — the `job-index` copy silently spawns zero
 * workers (and so resolves having done nothing) when `limit <= 0`.
 */

/**
 * Default bound for per-chat file fan-out.
 *
 * 16 measured *faster* than unbounded on a 1,515-chat project while cutting peak
 * RSS ~4× (706 MB → 178 MB), so there is headroom on both sides of this number;
 * it is not a knife-edge. Kept as a named constant because the next caller — the
 * boot-warm sweep — must use the same bound to get the same guarantee.
 */
export const FILE_FANOUT_CONCURRENCY = 16;

/**
 * Map over `items` with at most `limit` calls to `fn` in flight, preserving
 * input order in the result.
 *
 * Order-preserving is load-bearing: callers index the result positionally
 * against the input array, so this must behave exactly like `Promise.all(
 * items.map(fn))` in everything except how many calls are live at once.
 *
 * `limit` is clamped to at least 1, so a mis-computed or zero bound degrades to
 * serial execution rather than silently completing without running `fn` at all.
 * Rejections propagate as they would from `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
