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

/** Joiner when a second client's queue is merged in — what the composer uses. */
const MERGE_SEP = "\n";
/** How many (id, text) identities one slot remembers. Bounds the sidecar entry. */
const MAX_KNOWN = 24;
/**
 * How many attachments one slot can hold (#728). The composer caps a single
 * message at 10 by default, but the slot is shared and merges additively, so two
 * devices could otherwise stack refs into the sidecar without bound. Well above
 * any real queued follow-up; the excess is dropped rather than persisted.
 */
const MAX_SLOT_ATTACHMENTS = 20;

/**
 * One identity a chat's queued message has been known by.
 *
 * `id` is OPAQUE and compared only for EQUALITY — never ordered — so a client with
 * a skewed clock can't poison anything (#736). Two kinds of id land here: the one a
 * CLIENT sent with its `chat:set_queue`, and the slot VERSION the server minted in
 * response and broadcast back. A client re-asserting a queue on reload sends one of
 * the two, which is exactly what makes the drain able to recognise it (see
 * `drainQueue` in ws.ts).
 */
export interface QueuedPart {
  id: string;
  text: string;
}

/**
 * A composer attachment staged on the slot (#728) — the same lightweight ref the
 * `chat:send` path carries. The bytes live in the AttachmentStore; only the id,
 * filename and kind travel with the queued message.
 */
export interface QueuedAttachment {
  id: string;
  filename: string;
  kind?: string;
}

/** A queued message awaiting auto-send. */
export interface QueuedMessage {
  /**
   * The slot's full text — what gets sent. May be `""` when the slot holds only
   * attachments (#728: an attachment-only message is valid, #328).
   */
  text: string;
  /** SERVER-stamped enqueue time. Informational — never load-bearing (#736). */
  createdAtMs: number;
  /**
   * The slot's current VERSION, minted on every write and broadcast to every
   * attached client. A client echoes back the version it last saw, which is how
   * the server can tell "this client is editing the slot it can see" from "this
   * client composed a queue of its own, not knowing about the other one" (#629).
   */
  id?: string;
  /**
   * Every (id, text) this slot has been known by — the dedup ledger. Absent on an
   * entry written by an older server; readers treat that as one legacy identity.
   */
  parts?: QueuedPart[];
  /**
   * Files staged in the composer that ride this message when it drains (#728).
   * Merged as a UNION BY ID so a write can only ever add: a client re-asserting
   * its queue after a reload has an empty tray by then, and must not be able to
   * wipe the files off the shared slot.
   */
  attachments?: QueuedAttachment[];
}

/**
 * Union two attachment lists by id, preserving order and preferring the entry
 * already on the slot (its filename/kind is the one every client has been shown).
 * Bounded by {@link MAX_SLOT_ATTACHMENTS}.
 */
export function unionAttachments(
  current: QueuedAttachment[] | undefined,
  incoming: QueuedAttachment[] | undefined,
): QueuedAttachment[] {
  const out: QueuedAttachment[] = [];
  const seen = new Set<string>();
  for (const a of [...(current ?? []), ...(incoming ?? [])]) {
    if (!a || typeof a.id !== "string" || !a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a.kind === undefined ? { id: a.id, filename: a.filename } : { ...a });
    if (out.length >= MAX_SLOT_ATTACHMENTS) break;
  }
  return out;
}

/** Narrow a parsed value to a well-formed attachment list (dropping junk). */
function sanitizeAttachments(v: unknown): QueuedAttachment[] {
  if (!Array.isArray(v)) return [];
  const out: QueuedAttachment[] = [];
  for (const a of v) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) continue;
    if (typeof o.filename !== "string" || !o.filename) continue;
    out.push({
      id: o.id,
      filename: o.filename,
      ...(typeof o.kind === "string" ? { kind: o.kind } : {}),
    });
  }
  return out;
}

/** Does this slot hold anything worth sending? Text, attachments, or both. */
export function hasQueuedContent(m: QueuedMessage | null | undefined): boolean {
  if (!m) return false;
  return m.text.length > 0 || (m.attachments?.length ?? 0) > 0;
}

/**
 * Fold a write from a client that ISN'T on the slot's current version into the
 * slot's text.
 *
 * Usually that client is simply appending to its own queue: it holds text the slot
 * already contains and has added a line to the end of it. That is the ordinary
 * single-client append — the composer keeps one queue id across an append (#245),
 * and an older client sends only its enqueue `ts`, so neither ever carries the
 * current version. It also covers the plain race of appending faster than the
 * broadcast round trip. In every one of those, the client's text EXTENDS something
 * the slot already holds, so we substitute in place rather than appending — or the
 * client's own earlier text would appear twice.
 *
 * Otherwise the client queued without knowing what was already there (a second
 * device), and its text is appended so neither message is lost (#629).
 */
function mergeInto(current: string, known: QueuedPart[], incoming: string): string {
  // The most specific thing the incoming text extends — longest first, since a
  // queue that has been appended to is known by every prefix it has passed through.
  const extended = known
    .filter((p) => p.text.length > 0 && incoming.startsWith(`${p.text}${MERGE_SEP}`))
    .sort((a, b) => b.text.length - a.text.length)[0];
  const at = extended ? current.indexOf(extended.text) : -1;
  if (at < 0) return `${current}${MERGE_SEP}${incoming}`;
  // Splice rather than String.replace: the texts are user prose and `$&`-style
  // patterns in a replacement string would be interpreted.
  return current.slice(0, at) + incoming + current.slice(at + extended!.text.length);
}

/** The identities of an entry, synthesising one for a legacy entry without any. */
export function partsOf(m: QueuedMessage): QueuedPart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  return [{ id: m.id ?? `legacy:${m.createdAtMs}`, text: m.text }];
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
            const id = typeof (v as Record<string, unknown>).id === "string" ? entry.id : undefined;
            // Same tolerance for the staged attachments (#728): malformed entries
            // are dropped, never thrown on — a corrupt sidecar must not be able to
            // stop the queue loading.
            const attachments = sanitizeAttachments((v as Record<string, unknown>).attachments);
            map.set(k, {
              text: entry.text,
              createdAtMs: entry.createdAtMs,
              ...(id ? { id } : {}),
              ...(parts.length > 0 ? { parts } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
            });
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
   * Write one client's queue into a chat's single slot, MERGING rather than
   * overwriting (#629), and return the resulting entry. The read-modify-write
   * happens with no `await` between the load and the mutation, so two clients
   * queueing at once can't lose one another's text the way the old unconditional
   * `set` overwrite did.
   *
   * `incoming.id` is the identity the client is writing under — either the slot
   * VERSION it last saw (broadcast to it via `chat:queued_state`) or, if it has
   * never seen one, its own queue id. That is what distinguishes the two cases:
   *
   *  - **it matches the current version** ⇒ the client can see the slot as it is
   *    now, so its text IS the whole slot: replace. This covers the ordinary
   *    single-client edit/append (#245 stable identity) and any client that has
   *    caught up with a merge.
   *  - **it doesn't** ⇒ the client composed this queue without knowing the
   *    slot's current contents (a second device, or a tab that missed the
   *    broadcast): APPEND, so neither message is lost.
   *
   * A write whose text the slot has already been known by is a re-assert — a
   * reconnecting client pushing its stored copy — and is a no-op, so reconnecting
   * can't duplicate text into the slot.
   *
   * `nowMs` stamps a fresh slot's `createdAtMs` SERVER-side; an existing slot keeps
   * the one it has. The client's clock never enters the store (#736).
   */
  async upsert(
    agent: string,
    sessionId: string,
    incoming: QueuedPart & { attachments?: QueuedAttachment[] },
    nowMs: number,
    mintVersion: () => string,
  ): Promise<QueuedMessage | null> {
    const map = await this.ensureLoaded();
    const key = keyOf(agent, sessionId);
    const current = map.get(key) ?? null;
    // Attachments merge additively and independently of the text (#728): a write
    // can add files, never remove them. Computed first so an attachments-only
    // write — a valid message with no prose (#328) — has something to write even
    // though every text rule below leaves the text alone.
    const attachments = unionAttachments(current?.attachments, incoming.attachments);
    const gainedAttachments = attachments.length > (current?.attachments?.length ?? 0);
    const hasText = incoming.text.trim().length > 0;
    if (!hasText && !gainedAttachments) return current;
    const known = current ? partsOf(current) : [];
    // Already folded in under some identity ⇒ a re-assert, not new text. Still
    // worth writing if it brought new files with it.
    if (hasText && known.some((p) => p.text === incoming.text) && !gainedAttachments) {
      return current;
    }
    const textIsNew = hasText && !known.some((p) => p.text === incoming.text);
    const text = !current
      ? incoming.text
      : !textIsNew
        ? // Nothing new to say — an attachments-only write, or a re-assert that
          // brought files. The slot's prose is untouched.
          current.text
        : incoming.id === current.id
          ? // The client can see the slot as it stands, so its text IS the slot.
            incoming.text
          : mergeInto(current.text, known, incoming.text);
    const version = mintVersion();
    // Remember BOTH identities this write creates: what the client sent (which it
    // will re-assert on reload) and the version we hand back (which it will
    // re-assert once it adopts the broadcast). Either one reaching a later drain
    // has to be recognisable as already-flushed.
    // An attachments-only write contributes no text, so it contributes no identity
    // to remember either — an empty-text part would match nothing and only crowd
    // the ledger. The slot version is always recorded.
    const parts = [
      ...known,
      ...(hasText ? [{ id: incoming.id, text: incoming.text }] : []),
      { id: version, text },
    ].slice(-MAX_KNOWN);
    const next: QueuedMessage = {
      text,
      createdAtMs: current?.createdAtMs ?? nowMs,
      id: version,
      parts,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    map.set(key, next);
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
