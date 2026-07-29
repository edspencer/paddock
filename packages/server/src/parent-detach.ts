/**
 * ParentDetachStore — a Paddock-side sidecar recording which chats the user has
 * explicitly DETACHED from their parent (#508).
 *
 * The nested chat list (#485) draws a chat under its parent, and that edge is
 * resolved in two tiers (see `makeParentResolver`): the RECORDED
 * `RunProvenance.parentSessionId`, and — for chats created before that field
 * existed — an edge INFERRED from who injected the kickoff message. Detach
 * therefore cannot be implemented by clearing the recorded edge: the inference
 * tier would simply re-derive the old parent on the next page load. It needs an
 * explicit, persisted "this chat is a root, whatever the tiers say" sentinel that
 * is checked AHEAD of both.
 *
 * That sentinel lives here rather than on {@link RunProvenance}, which #508
 * suggested. Provenance is documented — and implemented — as write-once creation
 * metadata: "stamped once, at creation, and NEVER clobbered by a later turn".
 * Detach is a user decision made long after creation, and a chat with no recorded
 * provenance at all (every pre-#485 chat, i.e. exactly the population whose parent
 * is inferred) would have needed an `origin`/`depth` fabricated for it just to
 * carry the flag — which would then show a "spawned" badge the chat never earned.
 * A separate flag keeps provenance honest and detach cheap.
 *
 * Shape/pattern is a near-verbatim copy of {@link ArchiveStore} — a tiny JSON
 * array sidecar in the data dir, lazy-loaded, write-through, serialised,
 * corruption-tolerant. Keyed by `<agent>\0<sessionId>` (NUL-separated) like
 * archive/star, and SHARED rather than per-user: detaching restructures the list
 * everyone sees, so it is not personal state the way read/unread is.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "parent-detach.json";
/** Separator in a storage key; a NUL can't occur in an agent name or a UUID. */
const KEY_SEP = "\u0000";

/** Compose the storage key for an (agent, session) pair. */
function keyOf(agent: string, sessionId: string): string {
  return `${agent}${KEY_SEP}${sessionId}`;
}

export class ParentDetachStore {
  private readonly stateFile: string;
  /** In-memory set of detached keys (loaded once, written through on change). */
  private detached: Set<string> | null = null;
  /**
   * The in-flight load, cached so concurrent first-callers share ONE read — the
   * same lost-update guard {@link ArchiveStore} carries.
   */
  private loadPromise: Promise<Set<string>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted set (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Set<string>> {
    if (this.detached) return Promise.resolve(this.detached);
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
        this.detached = new Set(keys);
        return this.detached;
      })();
    }
    return this.loadPromise;
  }

  /**
   * Has this chat been detached from its parent? Non-throwing: any load error
   * reads as false, so a corrupt sidecar degrades to "nesting as recorded"
   * rather than flattening the whole list.
   */
  async isDetached(agent: string, sessionId: string): Promise<boolean> {
    const set = await this.ensureLoaded().catch(() => new Set<string>());
    return set.has(keyOf(agent, sessionId));
  }

  /**
   * Set (or clear) a chat's detached flag, persisting the change. Idempotent;
   * returns whether the flag actually CHANGED. Clearing it re-exposes whatever
   * the two resolver tiers say — which is what makes re-attach free: nothing was
   * ever destroyed, only overridden.
   */
  async setDetached(agent: string, sessionId: string, detached: boolean): Promise<boolean> {
    const set = await this.ensureLoaded();
    const key = keyOf(agent, sessionId);
    if (detached === set.has(key)) return false; // no-op — avoid a needless write
    if (detached) set.add(key);
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
