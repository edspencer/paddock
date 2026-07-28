/**
 * herdctl-jobs-index — an incremental, mtime-keyed index of the shared
 * `<stateDir>/jobs` directory (issue #529).
 *
 * ## Why this exists
 *
 * {@link import("./herdctl-jobs.js").lastTurnCompletedAt} and its per-project
 * sibling are the server signal behind the unread affordance, so they run on
 * `GET /api/projects`, `GET /api/projects/:slug` and
 * `GET /api/projects/:slug/chats` — i.e. on essentially every page load. They
 * used to `readdir` + `YAML.parse` EVERY `job-*.yaml` on every one of those
 * requests, with no cache. On a real instance (1,996 records, 46.6 MB) a CPU
 * profile attributed **61% of all busy server CPU** to that parse. Because it is
 * synchronous work on the single event loop it pinned throughput at ~1.1 req/s
 * and made an unrelated 2 ms endpoint take ~850 ms while a scan was in flight.
 * The jobs dir is shared fleet-wide and never pruned, so the cost was flat in
 * project size and linear in instance age.
 *
 * ## The invariant that makes an index safe
 *
 * A job record is written when a turn starts and rewritten when it finishes; it
 * is **immutable once `finished_at` is set**, and the directory is append-only.
 * So a warm index only ever has to parse files it has not seen before. Measured
 * on the same 1,996-record dir: full parse 821 ms → stat-only pass 18 ms (45×) →
 * `readdir` alone 2.8 ms (290×).
 *
 * Two deliberate belts on that invariant, because a wrong unread badge is worse
 * than a slow one:
 *
 * 1. **An entry is only cached once its record has a `finished_at`.** Anything
 *    still running (or half-written, or corrupt) is re-read on every scan, so a
 *    mid-turn record can never be memoized as if it were final. That is the one
 *    mutable case, and it is tiny — 4 of 1,996 records on the production corpus.
 * 2. **The cache key is `mtimeMs` AND `size`**, not mtime alone (core's
 *    `AttributionIndexBuilder` uses mtime only). `mtimeMs` carries sub-millisecond
 *    precision here, and adding size closes the theoretical same-tick rewrite.
 *
 * Entries for files that have disappeared are dropped each scan, so the cache
 * tracks the directory rather than growing without bound: it holds one ~100-byte
 * tuple per record, never the 24.5 KB average record body (97.3% of which is
 * `prompt`/`summary` prose no caller reads).
 *
 * ## Why not reuse core's index
 *
 * `@herdctl/core` exports {@link AttributionIndexBuilder}, which keeps exactly
 * this kind of mtime-keyed `jobFileCache` — but its public `AttributionIndex`
 * surfaces only `getAttribute(sessionId) -> { origin, agentName, triggerType }`.
 * It carries **no `finished_at`** and cannot enumerate its sessions, so it cannot
 * answer "the latest completed turn per session" at all. The only core API that
 * returns whole records, `listJobs`, is itself uncached (herdctl#415). So this
 * reuses core's *pattern* — the shape it validated — rather than its *code*.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** The shared jobs directory herdctl writes `job-*.yaml` records into. */
export function jobsDirOf(stateDir: string): string {
  return path.join(stateDir, "jobs");
}

/**
 * The only three fields any caller of this index reads, lifted off a job record.
 *
 * Only records that resolved to a session AND completed are represented — the
 * same records the un-indexed scan kept. `agent` is `null` when the record
 * carries no usable agent name (such a record counts for the flat
 * session→timestamp map but cannot be grouped by project).
 */
export interface JobIndexEntry {
  readonly sessionId: string;
  readonly finishedAt: string;
  readonly agent: string | null;
}

/** What we remember per file: enough to validate the cache, and the payload. */
interface CachedFile {
  readonly mtimeMs: number;
  readonly size: number;
  /** `null` for a record that parsed but is not session-resolved + completed. */
  readonly entry: JobIndexEntry | null;
}

/**
 * An incremental view of one jobs directory.
 *
 * One instance per {@link import("./herdctl.js").HerdctlService} (mirroring core's
 * "a single builder instance must be reused across builds to get the benefit"),
 * so a test server, a fork of the app, and production each get their own — no
 * module-level state keyed by path.
 */
export class JobsDirIndex {
  private readonly cache = new Map<string, CachedFile>();
  private inFlight: Promise<readonly JobIndexEntry[]> | null = null;
  private readonly jobsDir: string;

  /**
   * Diagnostics only (exercised by tests): scans performed, and files parsed /
   * reused on the last scan, plus how many files the cache currently tracks.
   */
  stats = { scans: 0, parsed: 0, reused: 0, tracked: 0 };

  constructor(stateDir: string) {
    this.jobsDir = jobsDirOf(stateDir);
  }

  /**
   * Every completed, session-resolved job record in the directory, in no
   * particular order.
   *
   * Concurrent callers COALESCE onto one scan: the `/projects` grid fires seven
   * parallel `/chats` requests, and running seven identical directory passes
   * helps nobody. A caller that arrives mid-scan therefore observes the directory
   * as of that scan's `readdir` — at most one scan (~20 ms) stale, against the
   * ~850 ms of drift the un-indexed version already had between its own `readdir`
   * and its last parse. A call made AFTER a write always sees that write.
   *
   * Never throws: an unreadable directory yields `[]`, and an unreadable or
   * half-written record is skipped, exactly as before.
   */
  async read(): Promise<readonly JobIndexEntry[]> {
    if (this.inFlight) return this.inFlight;
    const scan = this.scan();
    this.inFlight = scan;
    try {
      return await scan;
    } finally {
      if (this.inFlight === scan) this.inFlight = null;
    }
  }

  /**
   * Forget everything, forcing the next {@link read} to re-parse.
   *
   * The mtime+size key already self-heals after Paddock's own jobs-dir writes
   * (`reattributeSession` rewrites records, `writeAgentAdoptionJob` adds them),
   * so this is belt-and-braces called alongside the existing
   * `invalidateSessions` at those sites — it makes the freshness guarantee
   * independent of filesystem timestamp granularity.
   */
  invalidate(): void {
    this.cache.clear();
  }

  private async scan(): Promise<readonly JobIndexEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.jobsDir);
    } catch {
      // No jobs dir yet (fresh instance). Drop any stale entries with it.
      this.cache.clear();
      return [];
    }
    this.stats.scans++;
    let parsed = 0;
    let reused = 0;

    // Only `.yaml` records are candidates — the sibling `.jsonl` output files are
    // half the directory and are never stat'd, let alone read.
    const yamls = names.filter((n) => n.endsWith(".yaml"));
    const out: JobIndexEntry[] = [];
    await Promise.all(
      yamls.map(async (name) => {
        const file = path.join(this.jobsDir, name);
        let st: { mtimeMs: number; size: number };
        try {
          st = await fs.stat(file);
        } catch {
          return; // vanished between readdir and stat
        }
        const cached = this.cache.get(name);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          reused++;
          if (cached.entry) out.push(cached.entry);
          return;
        }
        parsed++;
        const entry = await parseJobFile(file);
        // Only a COMPLETED record is immutable, so only a completed record is
        // safe to memoize. A running/half-written/corrupt one is re-read next
        // scan — there are a handful of those, and being wrong about one would
        // freeze a chat's unread state.
        if (entry) this.cache.set(name, { mtimeMs: st.mtimeMs, size: st.size, entry });
        else this.cache.delete(name);
        if (entry) out.push(entry);
      }),
    );

    // Track the directory: forget files that are no longer there, so the cache
    // stays the size of the dir rather than growing across a process's lifetime.
    // (Unconditional — comparing sizes first would miss a scan that deletes and
    // adds the same number of files, for no measurable saving.)
    const present = new Set(yamls);
    for (const name of this.cache.keys()) if (!present.has(name)) this.cache.delete(name);

    this.stats.parsed = parsed;
    this.stats.reused = reused;
    this.stats.tracked = this.cache.size;
    return out;
  }
}

/**
 * Parse one `job-*.yaml` down to the three fields the index keeps.
 *
 * Returns `null` — meaning "nothing to index, and nothing to cache" — for a
 * record that is unreadable, half-written, still running (`finished_at` unset),
 * or not yet session-resolved. That is the same skip the un-indexed scan applied;
 * it never throws.
 */
async function parseJobFile(file: string): Promise<JobIndexEntry | null> {
  let parsedYaml: Record<string, unknown> | null = null;
  try {
    parsedYaml = YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> | null;
  } catch {
    return null; // skip an unreadable/half-written record
  }
  const sid = parsedYaml?.session_id;
  const finished = parsedYaml?.finished_at;
  if (typeof sid !== "string" || typeof finished !== "string") return null;
  const agent = parsedYaml?.agent;
  return { sessionId: sid, finishedAt: finished, agent: typeof agent === "string" ? agent : null };
}
