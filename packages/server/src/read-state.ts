/**
 * ReadStateStore — a Paddock-side sidecar for per-chat "last seen" (read-state),
 * moving the unread affordance (#160/#161) off the browser's localStorage and
 * onto the server so it follows a user ACROSS DEVICES (#189).
 *
 * This clones the ArchiveStore pattern exactly — a lightweight, write-through,
 * serialised, corruption-tolerant JSON sidecar in the data dir — but stores a
 * `key -> lastSeenMs` MAP (persisted as a plain JSON object) rather than a set,
 * since read-state is a timestamp per chat, not a boolean flag.
 *
 * Keying — by user WHEN PRESENT, else a single shared bucket:
 *   - Real identity (trusted-header / jwt): `username \0 agent \0 sessionId`
 *   - No user (`none` mode / anonymous):     `agent \0 sessionId` (shared)
 * NUL-separated, same rationale as ArchiveStore: a NUL can occur in neither a
 * username, an agent name (`keeper-<slug>` / `scratch`), nor a UUID, so keys
 * can't collide — and a user-keyed entry can never alias the shared bucket.
 *
 * `setLastSeen` is MONOTONIC (only ever advances a chat's last-seen time): the
 * marker means "the most recent moment the user viewed this chat", so an older
 * timestamp is a no-op and never moves read-state backwards.
 *
 * The file is written `0o600` (like github-auth.json) — read-state is
 * low-sensitivity (which chats you viewed + when), but there's no reason for it
 * to be world-readable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "read-state.json";
/** Separator in a storage key; a NUL can't occur in a username, agent, or UUID. */
const KEY_SEP = "\u0000";

/**
 * Compose the storage key for a (user, agent, session) triple. A null/empty
 * username selects the SHARED bucket (no user segment) — so `none`-mode
 * deployments get cross-device continuity for free without a per-user segment,
 * and can never collide with a real user's entry.
 */
export function keyOf(username: string | null, agent: string, sessionId: string): string {
  return username
    ? `${username}${KEY_SEP}${agent}${KEY_SEP}${sessionId}`
    : `${agent}${KEY_SEP}${sessionId}`;
}

export class ReadStateStore {
  private readonly stateFile: string;
  /** In-memory map of key -> lastSeenMs (loaded once, written through on change). */
  private state: Map<string, number> | null = null;
  /**
   * The in-flight load, cached so concurrent first-callers share ONE read.
   * Caching only the resolved `state` would let several marks that begin before
   * the first `fs.readFile` resolves each build their own map and race on the
   * assignment — a lost update (last writer's map wins, dropping the others'
   * keys).
   */
  private loadPromise: Promise<Map<string, number>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted map (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Map<string, number>> {
    if (this.state) return Promise.resolve(this.state);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const map = new Map<string, number>();
        try {
          const raw = await fs.readFile(this.stateFile, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          // A plain JSON object `{ [key]: number }` — NOT an array (unlike Archive).
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof v === "number" && Number.isFinite(v)) map.set(k, v);
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

  /**
   * The epoch-ms moment this user last viewed this chat, or 0 if never seen /
   * unavailable. Non-throwing: any load error reads as 0. Pass `null` for
   * `username` to read the shared bucket.
   */
  async getLastSeen(username: string | null, agent: string, sessionId: string): Promise<number> {
    const map = await this.ensureLoaded().catch(() => new Map<string, number>());
    return map.get(keyOf(username, agent, sessionId)) ?? 0;
  }

  /**
   * Advance this chat's last-seen time to `whenMs` (monotonic: an older or equal
   * timestamp is a no-op, avoiding a needless write and never moving read-state
   * backwards). Pass `null` for `username` to write the shared bucket.
   */
  async setLastSeen(
    username: string | null,
    agent: string,
    sessionId: string,
    whenMs: number,
  ): Promise<void> {
    const map = await this.ensureLoaded();
    const key = keyOf(username, agent, sessionId);
    if (whenMs <= (map.get(key) ?? 0)) return; // monotonic — no-op
    map.set(key, whenMs);
    await this.persist(map);
  }

  /** Write-through, serialised so overlapping marks can't corrupt the file. */
  private persist(map: Map<string, number>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const obj: Record<string, number> = {};
      for (const [k, v] of map) obj[k] = v;
      const json = JSON.stringify(obj, null, 2);
      await fs.writeFile(this.stateFile, json, { encoding: "utf8", mode: 0o600 }).catch(
        () => undefined,
      );
    });
    return this.writing;
  }
}
