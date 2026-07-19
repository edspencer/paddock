/**
 * TriggerSessionStore — a Paddock-side sidecar mapping an *accreting* trigger
 * (`run.session: "resume"`) to the ONE chat session it owns (Epic T / T1). A trigger
 * whose run declares `session: "resume"` should build up a single long-lived
 * transcript across every fire (a "manager" that accretes context) rather than
 * spawning a fresh chat each time. To make that resume unambiguous, Paddock records
 * the session id the trigger created on its FIRST fire and reuses it thereafter — so
 * the binding survives a server restart (the resume rebinds off the reloaded sidecar).
 *
 * This is the unified successor to `ScheduleSessionStore` (issue #265): the same
 * pattern, keyed by (project slug, TRIGGER name) instead of schedule name, so both
 * schedule-type and event-type triggers can own an accreting session. A
 * `session: "new"` trigger owns nothing — it gets a new chat every fire and never
 * touches this store.
 *
 * Shape + concurrency: a `"<slug>\0<triggerName>" -> sessionId` map persisted as a
 * plain JSON object — the exact ArchiveStore / RunProvenanceStore / ScheduleSessionStore
 * sidecar pattern (lazy-loaded, write-through, serialised, corruption-tolerant,
 * `0o600`), INCLUDING the in-flight-load-promise fix: {@link ensureLoaded} caches the
 * load PROMISE (not just the resolved map) so concurrent first-callers share ONE read
 * and can't each build a separate map and race on the assignment (a lost update).
 * Reachable if several triggers fire in the same tick right after boot.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "trigger-sessions.json";

/** The composite key separator — NUL can't appear in a slug or trigger name. */
const SEP = "\0";

/** A session id we're willing to key on — mirrors RunProvenanceStore's guard. */
function isSafeId(sessionId: string): boolean {
  return typeof sessionId === "string" && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

export class TriggerSessionStore {
  private readonly stateFile: string;
  /** In-memory map of `<slug>\0<triggerName>` -> owned sessionId. */
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

  private static key(slug: string, triggerName: string): string {
    return `${slug}${SEP}${triggerName}`;
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

  /** The session id this trigger owns, or undefined if it hasn't fired yet. Non-throwing. */
  async get(slug: string, triggerName: string): Promise<string | undefined> {
    const map = await this.ensureLoaded().catch(() => new Map<string, string>());
    return map.get(TriggerSessionStore.key(slug, triggerName));
  }

  /**
   * Record the session a trigger owns (its first-fire chat). Idempotent for the same
   * id; an unsafe/blank id is ignored. Overwrites if called again (used only on a
   * fresh first fire, or to re-point after a stale id was cleared).
   */
  async set(slug: string, triggerName: string, sessionId: string): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const key = TriggerSessionStore.key(slug, triggerName);
    const map = await this.ensureLoaded();
    if (map.get(key) === sessionId) return; // no-op
    map.set(key, sessionId);
    await this.persist(map);
  }

  /**
   * Forget a trigger's owned session — used when the recorded transcript has vanished
   * (so the next fire re-creates one) or the trigger was removed. No-op if there was
   * nothing recorded.
   */
  async clear(slug: string, triggerName: string): Promise<void> {
    const key = TriggerSessionStore.key(slug, triggerName);
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
