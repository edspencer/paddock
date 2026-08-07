/**
 * QueuedMessageStore — a Paddock-side sidecar for per-chat queued messages (#197).
 *
 * The message queue (#91) lets users stack a follow-up to auto-send when the
 * current turn finishes. In PR #204, the queued text lived only in component-local
 * React state, so closing the browser before the turn completed silently dropped it.
 *
 * This store persists queued messages server-side so they survive browser close,
 * page reload, and server restart — enabling true server-driven auto-send.
 *
 * Clones the ReadStateStore pattern: a lightweight, write-through, serialised,
 * corruption-tolerant JSON sidecar in the data dir, storing a `key -> queued text`
 * map (persisted as a plain JSON object). Keyed by `agent \0 sessionId` (NUL-separated).
 *
 * When a turn completes, the server checks for a queued message, auto-sends it as
 * the next message, and deletes the stored entry. The web client receives a
 * `chat:queued_flushed` frame to clear its localStorage.
 *
 * ## One slot, many contributors (#629)
 *
 * The slot is per CHAT, not per client — a chat has one "next message", the same
 * model the composer renders. It used to be a bare overwrite, so a second client
 * queueing on the same chat silently destroyed the first client's text (and the
 * first client's transcript then rendered a user bubble nobody there had typed).
 *
 * The slot now holds an ordered list of {@link QueuedPart}s: one per contributing
 * client queue, identified by that client's opaque queue id. A client updating ITS
 * OWN part replaces it in place (an edit/append — #245's stable identity); a
 * DIFFERENT client's queue appends a new part. `text` is the joined result and
 * stays the thing that gets sent, so nothing downstream — nor an older reader of
 * this file — needs to know about parts.
 *
 * The parts double as the drain's dedup ledger. A client that never saw the
 * `chat:queued_flushed` clear (it is broadcast un-buffered) re-asserts its own
 * (id, text) on reload; matching that against the parts actually flushed is what
 * lets the drain tell a stale re-assert from a genuinely new message WITHOUT
 * comparing wall clocks (#736). See `drainQueue` in ws.ts.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "queued-message.json";
/** Separator in a storage key; a NUL can't occur in an agent name or a UUID. */
const KEY_SEP = "\u0000";

/** Compose the storage key for an (agent, session) pair. */
function keyOf(agent: string, sessionId: string): string {
  return `${agent}${KEY_SEP}${sessionId}`;
}

/** Joiner between parts — the same separator the composer uses when appending. */
const PART_SEP = "\n";

/**
 * One client queue's contribution to a chat's queued message.
 *
 * `id` is an OPAQUE identity minted by the client that owns that queue (a uuid;
 * the WS layer folds a legacy client's enqueue timestamp into one). It is compared
 * only for EQUALITY — never ordered — so a client with a skewed clock can't poison
 * anything (#736).
 */
export interface QueuedPart {
  id: string;
  text: string;
}

/** A queued message awaiting auto-send. */
export interface QueuedMessage {
  /** What actually gets sent: every part's text, joined. */
  text: string;
  /** SERVER-stamped enqueue time. Informational — never load-bearing (#736). */
  createdAtMs: number;
  /**
   * The contributing client queues, in arrival order. Absent on an entry written
   * by an older server; readers treat that as a single anonymous part.
   */
  parts?: QueuedPart[];
}

/** The parts of an entry, synthesising one for a legacy entry that predates them. */
export function partsOf(m: QueuedMessage): QueuedPart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  return [{ id: `legacy:${m.createdAtMs}`, text: m.text }];
}

/** Join parts into an entry, dropping blanks; null when nothing is left. */
function fromParts(parts: QueuedPart[], createdAtMs: number): QueuedMessage | null {
  const kept = parts.filter((p) => p.text.trim().length > 0);
  if (kept.length === 0) return null;
  return { text: kept.map((p) => p.text).join(PART_SEP), createdAtMs, parts: kept };
}

export class QueuedMessageStore {
  private readonly stateFile: string;
  /** In-memory map of key -> QueuedMessage (loaded once, written through on change). */
  private state: Map<string, QueuedMessage> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted map (lazily; tolerant of a missing/corrupt file). */
  private async ensureLoaded(): Promise<Map<string, QueuedMessage>> {
    if (this.state) return this.state;
    const map = new Map<string, QueuedMessage>();
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      // A plain JSON object `{ [key]: QueuedMessage }` — NOT an array.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (
            v &&
            typeof v === "object" &&
            typeof (v as Record<string, unknown>).text === "string" &&
            typeof (v as Record<string, unknown>).createdAtMs === "number"
          ) {
            const entry = v as QueuedMessage;
            // `parts` is optional (an older server wrote entries without it) and
            // corruption-tolerant like everything else here: a malformed parts
            // array is dropped, leaving a legacy single-part entry, not a throw.
            const raw = (v as Record<string, unknown>).parts;
            const parts = Array.isArray(raw)
              ? raw.filter(
                  (p): p is QueuedPart =>
                    Boolean(p) &&
                    typeof p === "object" &&
                    typeof (p as QueuedPart).id === "string" &&
                    typeof (p as QueuedPart).text === "string",
                )
              : [];
            map.set(k, parts.length > 0 ? { ...entry, parts } : { text: entry.text, createdAtMs: entry.createdAtMs });
          }
        }
      }
    } catch {
      /* missing or unreadable — start empty */
    }
    this.state = map;
    return this.state;
  }

  /**
   * Retrieve a queued message for a chat, or `null` if none / unavailable.
   * Non-throwing: any load error reads as null.
   */
  async get(agent: string, sessionId: string): Promise<QueuedMessage | null> {
    const map = await this.ensureLoaded().catch(() => new Map<string, QueuedMessage>());
    return map.get(keyOf(agent, sessionId)) ?? null;
  }

  /**
   * Atomically read AND remove a chat's queued message (#245). Returns the entry
   * (or null if none). The read+delete happen without an intervening `await`, so
   * two concurrent drains — e.g. a turn-completion drain and an idle `set_queue`
   * drain — can never both observe the same message and double-send it: whichever
   * `take()` runs first gets it, the other gets null. Non-throwing.
   */
  async take(agent: string, sessionId: string): Promise<QueuedMessage | null> {
    const map = await this.ensureLoaded().catch(() => null);
    if (!map) return null;
    const key = keyOf(agent, sessionId);
    const v = map.get(key);
    if (!v) return null;
    map.delete(key);
    await this.persist(map);
    return v;
  }

  /**
   * Store (or clear, when `message` is null) a queued message for a chat.
   * Setting `null` deletes the key, keeping the file compact.
   */
  async set(agent: string, sessionId: string, message: QueuedMessage | null): Promise<void> {
    const map = await this.ensureLoaded();
    const key = keyOf(agent, sessionId);
    if (message === null) {
      map.delete(key);
    } else {
      map.set(key, message);
    }
    await this.persist(map);
  }

  /**
   * Merge one client queue's text into a chat's single slot (#629), returning the
   * resulting entry. The read-modify-write happens with no intervening `await`
   * after the load, so two clients queueing at once can't lose one another's text
   * the way the old unconditional `set` overwrite did.
   *
   * `part.id` decides which it is:
   *  - it matches a part already in the slot ⇒ the SAME client queue, updated in
   *    place (an edit or an append keeps its id — #245 stable identity);
   *  - it doesn't ⇒ a DIFFERENT client's queue, appended as a new part.
   *
   * `nowMs` stamps a fresh slot's `createdAtMs` SERVER-side; an existing slot keeps
   * the one it has. The client's clock never enters the store (#736).
   */
  async upsert(
    agent: string,
    sessionId: string,
    part: QueuedPart,
    nowMs: number,
  ): Promise<QueuedMessage | null> {
    const map = await this.ensureLoaded();
    const key = keyOf(agent, sessionId);
    const current = map.get(key) ?? null;
    const parts = current ? [...partsOf(current)] : [];
    const at = parts.findIndex((p) => p.id === part.id);
    if (at >= 0) parts[at] = part;
    else parts.push(part);
    const next = fromParts(parts, current?.createdAtMs ?? nowMs);
    if (next) map.set(key, next);
    else map.delete(key);
    await this.persist(map);
    return next;
  }

  /** Write-through, serialised so overlapping writes can't corrupt the file. */
  private persist(map: Map<string, QueuedMessage>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const obj: Record<string, QueuedMessage> = {};
      for (const [k, v] of map) obj[k] = v;
      const json = JSON.stringify(obj, null, 2);
      await fs.writeFile(this.stateFile, json, "utf8").catch(() => undefined);
    });
    return this.writing;
  }
}
