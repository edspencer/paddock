/**
 * ScheduleSessionStore — a Paddock-side sidecar mapping an *accreting* schedule
 * to the ONE chat session it owns (issue #265 / DD-2). A schedule declared with
 * `resume_session: true` should build up a single long-lived transcript across
 * every fire (a "manager" that accretes context), rather than spawning a fresh
 * chat each time. To make that resume unambiguous, Paddock records the session id
 * the schedule created on its FIRST fire and reuses it thereafter.
 *
 * Chosen over "resume the latest chat of a lineage" (DD-2, resolved decision #1):
 * a stable owned id is unambiguous and survives new chats a human might start in
 * the same project. A `resume_session: false` schedule owns nothing — it gets a
 * new chat every fire and never touches this store.
 *
 * Shape + concurrency: a `"<slug>\0<scheduleName>" -> sessionId` map persisted as
 * a plain JSON object — the exact ArchiveStore / ReadStateStore / RunProvenanceStore
 * sidecar pattern (lazy-loaded, write-through, serialised, corruption-tolerant,
 * `0o600`), INCLUDING the in-flight-load-promise fix: `ensureLoaded` caches the
 * load PROMISE (not just the resolved map) so concurrent first-callers share one
 * read and can't each build a separate map and race on the assignment (a lost
 * update). Reachable if several schedules fire in the same tick right after boot.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "schedule-sessions.json";

/** The composite key separator — NUL can't appear in a slug or schedule name. */
const SEP = "\0";

/** A session id we're willing to key on — mirrors RunProvenanceStore's guard. */
function isSafeId(sessionId: string): boolean {
  return typeof sessionId === "string" && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

export class ScheduleSessionStore {
  private readonly stateFile: string;
  /** In-memory map of `<slug>\0<scheduleName>` -> owned sessionId. */
  private state: Map<string, string> | null = null;
  /**
   * The in-flight load, cached so concurrent first-callers share ONE read (the
   * RunProvenanceStore fix): caching only the resolved `state` would let several
   * fires that begin before the first `fs.readFile` resolves each build their own
   * map and race on the assignment — a lost update.
   */
  private loadPromise: Promise<Map<string, string>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  private static key(slug: string, scheduleName: string): string {
    return `${slug}${SEP}${scheduleName}`;
  }

  /** Load the persisted map (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Map<string, string>> {
    if (this.state) return Promise.resolve(this.state);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const map = new Map<string, string>();
        try {
          const raw = await fs.readFile(this.stateFile, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof v === "string" && isSafeId(v)) map.set(k, v);
            }
          }
        } catch {
          /* missing or unreadable — start empty */
        }
        this.state = map;
        return map;
      })();
    }
    return this.loadPromise;
  }

  /** The session id this schedule owns, or undefined if it hasn't fired yet. Non-throwing. */
  async get(slug: string, scheduleName: string): Promise<string | undefined> {
    const map = await this.ensureLoaded().catch(() => new Map<string, string>());
    return map.get(ScheduleSessionStore.key(slug, scheduleName));
  }

  /**
   * Record the session a schedule owns (its first-fire chat). Idempotent for the
   * same id; an unsafe/blank id is ignored. Overwrites if called again (used only
   * on a fresh first fire, or to re-point after a stale id was cleared).
   */
  async set(slug: string, scheduleName: string, sessionId: string): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const key = ScheduleSessionStore.key(slug, scheduleName);
    const map = await this.ensureLoaded();
    if (map.get(key) === sessionId) return; // no-op
    map.set(key, sessionId);
    await this.persist(map);
  }

  /**
   * Forget a schedule's owned session — used when the recorded transcript has
   * vanished (so the next fire re-creates one) or the schedule was removed. No-op
   * if there was nothing recorded.
   */
  async clear(slug: string, scheduleName: string): Promise<void> {
    const key = ScheduleSessionStore.key(slug, scheduleName);
    const map = await this.ensureLoaded();
    if (!map.has(key)) return;
    map.delete(key);
    await this.persist(map);
  }

  /** Write-through, serialised so overlapping writes can't corrupt the file. */
  private persist(map: Map<string, string>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const obj: Record<string, string> = {};
      for (const [k, v] of map) obj[k] = v;
      const json = JSON.stringify(obj, null, 2);
      await fs.writeFile(this.stateFile, json, { encoding: "utf8", mode: 0o600 }).catch(
        () => undefined,
      );
    });
    return this.writing;
  }
}
