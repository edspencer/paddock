/**
 * ArchiveStore — a Paddock-side sidecar for the per-chat "archived" flag (#95).
 *
 * Archiving files a finished chat away into a collapsible "Archived" section
 * without touching its transcript, so it stays fully openable/resumable/forkable
 * — the flag is purely presentational metadata.
 *
 * The natural home for this is @herdctl/core's SessionMetadataStore (the same
 * layer that persists custom chat names), whose schema already reserves room for
 * a future `archived` field. Until that ships upstream, Paddock keeps its own
 * tiny JSON sidecar in the data dir — the exact same pattern SweepService uses
 * for its watermark state. Keyed by `<agent>\0<sessionId>` (NUL-separated) so a
 * project chat and a scratch chat can never collide — a NUL can occur in neither
 * an agent name (`keeper-<slug>` / `scratch`) nor a UUID. Only archived entries
 * are stored (an unarchive deletes the key), keeping the file compact.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "archive-state.json";
/** Separator in a storage key; a NUL can't occur in an agent name or a UUID. */
const KEY_SEP = "\u0000";

/** Compose the storage key for an (agent, session) pair. */
function keyOf(agent: string, sessionId: string): string {
  return `${agent}${KEY_SEP}${sessionId}`;
}

export class ArchiveStore {
  private readonly stateFile: string;
  /** In-memory set of archived keys (loaded once, written through on change). */
  private archived: Set<string> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted set (lazily; tolerant of a missing/corrupt file). */
  private async ensureLoaded(): Promise<Set<string>> {
    if (this.archived) return this.archived;
    let keys: string[] = [];
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === "string");
    } catch {
      /* missing or unreadable — start empty */
    }
    this.archived = new Set(keys);
    return this.archived;
  }

  /** Whether a chat is archived. Non-throwing: any load error reads as false. */
  async isArchived(agent: string, sessionId: string): Promise<boolean> {
    const set = await this.ensureLoaded().catch(() => new Set<string>());
    return set.has(keyOf(agent, sessionId));
  }

  /** Set (or clear) a chat's archived flag, persisting the change. Idempotent. */
  async setArchived(agent: string, sessionId: string, archived: boolean): Promise<void> {
    const set = await this.ensureLoaded();
    const key = keyOf(agent, sessionId);
    if (archived === set.has(key)) return; // no-op — avoid a needless write
    if (archived) set.add(key);
    else set.delete(key);
    await this.persist(set);
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
