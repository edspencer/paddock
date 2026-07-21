/**
 * StarStore — a Paddock-side sidecar for the per-chat "starred" (pinned) flag (#373).
 *
 * Starring pins a chat to the top of its list without touching its transcript —
 * the flag is purely presentational metadata, exactly like `archived` (#95).
 * Starring is ORTHOGONAL to archiving: a chat can be starred whether or not it's
 * archived, and within BOTH the active list and the Archived section starred
 * chats float to the top of their own population (the client does the ordering).
 *
 * This is a near-verbatim copy of {@link ArchiveStore} — the same tiny JSON
 * sidecar pattern SweepService uses for its watermark state. Keyed by
 * `<agent>\0<sessionId>` (NUL-separated) so a project chat and a scratch chat can
 * never collide — a NUL can occur in neither an agent name (`keeper-<slug>` /
 * `scratch`) nor a UUID. Only starred entries are stored (an unstar deletes the
 * key), keeping the file compact. Unlike ArchiveStore there is NO lifecycle event
 * — starring fires no hooks.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "star-state.json";
/** Separator in a storage key; a NUL can't occur in an agent name or a UUID. */
const KEY_SEP = "\u0000";

/** Compose the storage key for an (agent, session) pair. */
function keyOf(agent: string, sessionId: string): string {
  return `${agent}${KEY_SEP}${sessionId}`;
}

export class StarStore {
  private readonly stateFile: string;
  /** In-memory set of starred keys (loaded once, written through on change). */
  private starred: Set<string> | null = null;
  /**
   * The in-flight load, cached so concurrent first-callers share ONE read.
   * Caching only the resolved `starred` set would let several toggles that begin
   * before the first `fs.readFile` resolves each build their own set and race on
   * the assignment — a lost update (last writer wins, dropping the others' keys).
   */
  private loadPromise: Promise<Set<string>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted set (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Set<string>> {
    if (this.starred) return Promise.resolve(this.starred);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        let keys: string[] = [];
        try {
          const raw = await fs.readFile(this.stateFile, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === "string");
        } catch {
          /* missing or unreadable — start empty */
        }
        this.starred = new Set(keys);
        return this.starred;
      })();
    }
    return this.loadPromise;
  }

  /** Whether a chat is starred. Non-throwing: any load error reads as false. */
  async isStarred(agent: string, sessionId: string): Promise<boolean> {
    const set = await this.ensureLoaded().catch(() => new Set<string>());
    return set.has(keyOf(agent, sessionId));
  }

  /**
   * Set (or clear) a chat's starred flag, persisting the change. Idempotent.
   * Returns whether the flag actually CHANGED, mirroring `ArchiveStore.setArchived`.
   */
  async setStarred(agent: string, sessionId: string, starred: boolean): Promise<boolean> {
    const set = await this.ensureLoaded();
    const key = keyOf(agent, sessionId);
    if (starred === set.has(key)) return false; // no-op — avoid a needless write
    if (starred) set.add(key);
    else set.delete(key);
    await this.persist(set);
    return true;
  }

  /** Write-through, serialised so overlapping toggles can't corrupt the file. */
  private persist(set: Set<string>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const json = JSON.stringify([...set], null, 2);
      await fs.writeFile(this.stateFile, json, "utf8").catch(() => undefined);
    });
    return this.writing;
  }
}
