/**
 * MessageProvenanceStore — a Paddock-side sidecar recording WHO injected each
 * machine-added turn into a chat's transcript (issue #290). This is the
 * per-MESSAGE analog of {@link RunProvenanceStore} (A1/#261), which records how a
 * whole CHAT was created. As chats reliably inject messages into one another —
 * `send_message` (a spawned child reporting back), scheduled fires, spawned-chat
 * kickoffs — a transcript can interleave turns a HUMAN typed with turns a MACHINE
 * added, and in the UI they look identical. This store lets the web attribute the
 * machine-added ones ("↩ sent by <chat>", "⏰ scheduled by <name>").
 *
 * WHY a content-keyed sidecar (not a per-message uuid map): the injected user
 * turn's transcript `uuid` is minted by Claude Code when it writes the JSONL line,
 * so Paddock never sees it at injection time. But Paddock DOES know the exact
 * prompt string it injected, and that string lands verbatim as the user message's
 * content. So we record, per target session, an ORDERED list of injection markers
 * carrying the sender + the injected content; at DTO-build time we walk the parsed
 * messages and greedily match each machine-injected user message to the next
 * unconsumed marker (see {@link applyMessageProvenance}). Injections into one
 * session are serialised (herdctl keeper concurrency + same-session resume), and
 * the transcript preserves order, so the in-order join is stable. A human-typed
 * message won't match a pending marker's content, so it stays unlabelled (the
 * default).
 *
 * Shape + durability mirror the other sidecars exactly: a `sessionId ->
 * InjectedMarker[]` map persisted as a plain JSON object, lazy-loaded (with the
 * in-flight load promise cached so concurrent first-callers can't lose an update),
 * write-through, serialised, corruption-tolerant, `0o600`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "message-provenance.json";

/**
 * The longest injected-content prefix we persist per marker. Bounds sidecar size
 * for a large `promptFile`-driven schedule while keeping ordinary short kickoffs
 * matched exactly. Beyond this the match falls back to prefix equality (a full
 * transcript content that STARTS WITH the stored prefix), which is unambiguous
 * enough given the in-order consumption.
 */
const MAX_CONTENT = 8192;

/**
 * WHO caused a machine-injected turn. A human-typed message carries NO sender
 * (absence = human, the quiet default), so this type only enumerates the machine
 * sources. Mirrors the web's `MessageSender` (packages/web/src/lib/types.ts).
 *
 *  - `chat`     — another chat `send_message`d / forked / created this turn; carries
 *                 the sending chat's project + sessionId (for a deep link) + the
 *                 display name it had at injection time.
 *  - `schedule` — a schedule fire injected it; carries the schedule's name.
 *  - `hook`     — an event hook fired it (Epic G / G1); carries the hook's name (and
 *                 project) so a hook chat's kickoff turn is attributable.
 *  - `recovery` — Paddock's keeper-chat recovery nudged this turn (issue #301):
 *                 a human clicked "Continue" on a killed-background-task
 *                 affordance (Layer 2), or Layer 3 auto re-drove the hung keeper.
 *  - `agent`    — a machine turn with no more specific identity (fallback).
 */
export type MessageSender =
  | { kind: "chat"; project: string; sessionId: string; name?: string }
  | { kind: "schedule"; name: string; project?: string }
  | { kind: "hook"; name: string; project?: string }
  | { kind: "recovery" }
  | { kind: "agent" };

/** One recorded injection: its sender + the (possibly truncated) injected content. */
export interface InjectedMarker {
  sender: MessageSender;
  /** The injected prompt, trimmed and capped to {@link MAX_CONTENT}. */
  content: string;
  /** True when `content` was capped — the join then prefix-matches instead of ==. */
  truncated?: boolean;
}

/** A session id we're willing to key on — mirrors RunProvenanceStore's guard. */
function isSafeId(sessionId: string): boolean {
  return typeof sessionId === "string" && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

const SENDER_KINDS = new Set(["chat", "schedule", "hook", "recovery", "agent"]);

/** Validate + normalise an untrusted value into a MessageSender, or null. */
function coerceSender(value: unknown): MessageSender | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.kind !== "string" || !SENDER_KINDS.has(o.kind)) return null;
  if (o.kind === "chat") {
    if (typeof o.project !== "string" || typeof o.sessionId !== "string") return null;
    return {
      kind: "chat",
      project: o.project,
      sessionId: o.sessionId,
      ...(typeof o.name === "string" ? { name: o.name } : {}),
    };
  }
  if (o.kind === "schedule") {
    if (typeof o.name !== "string") return null;
    return {
      kind: "schedule",
      name: o.name,
      ...(typeof o.project === "string" ? { project: o.project } : {}),
    };
  }
  if (o.kind === "hook") {
    if (typeof o.name !== "string") return null;
    return {
      kind: "hook",
      name: o.name,
      ...(typeof o.project === "string" ? { project: o.project } : {}),
    };
  }
  if (o.kind === "recovery") return { kind: "recovery" };
  return { kind: "agent" };
}

/** Validate + normalise an untrusted value into an InjectedMarker, or null. */
function coerceMarker(value: unknown): InjectedMarker | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const sender = coerceSender(o.sender);
  if (!sender) return null;
  if (typeof o.content !== "string") return null;
  return { sender, content: o.content, ...(o.truncated === true ? { truncated: true } : {}) };
}

/** Normalise + cap injected content for storage; also used at match time. */
function normaliseContent(content: string): { content: string; truncated: boolean } {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_CONTENT) return { content: trimmed, truncated: false };
  return { content: trimmed.slice(0, MAX_CONTENT), truncated: true };
}

export class MessageProvenanceStore {
  private readonly stateFile: string;
  /** In-memory map of sessionId -> ordered injection markers (loaded once, written through). */
  private state: Map<string, InjectedMarker[]> | null = null;
  /** The in-flight load, cached so concurrent first-callers share ONE read (see RunProvenanceStore). */
  private loadPromise: Promise<Map<string, InjectedMarker[]>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted map (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Map<string, InjectedMarker[]>> {
    if (this.state) return Promise.resolve(this.state);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const map = new Map<string, InjectedMarker[]>();
        try {
          const raw = await fs.readFile(this.stateFile, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (!Array.isArray(v)) continue;
              const markers = v.map(coerceMarker).filter((m): m is InjectedMarker => m !== null);
              if (markers.length) map.set(k, markers);
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

  /** This chat's ordered injection markers, or [] if none. Non-throwing. */
  async list(sessionId: string): Promise<InjectedMarker[]> {
    if (!isSafeId(sessionId)) return [];
    const map = await this.ensureLoaded().catch(() => new Map<string, InjectedMarker[]>());
    return map.get(sessionId) ?? [];
  }

  /**
   * Append one injection marker for `sessionId`. Order is significant — the join
   * consumes markers in the order they were recorded — so this only ever appends.
   * A blank/unsafe session id or malformed sender is ignored (best effort; the
   * turn still runs, it just won't be attributed).
   */
  async record(sessionId: string, sender: MessageSender, content: string): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const s = coerceSender(sender);
    if (!s) return;
    const { content: capped, truncated } = normaliseContent(content);
    const marker: InjectedMarker = { sender: s, content: capped, ...(truncated ? { truncated: true } : {}) };
    const map = await this.ensureLoaded();
    const list = map.get(sessionId);
    if (list) list.push(marker);
    else map.set(sessionId, [marker]);
    await this.persist(map);
  }

  /** Write-through, serialised so overlapping records can't corrupt the file. */
  private persist(map: Map<string, InjectedMarker[]>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const obj: Record<string, InjectedMarker[]> = {};
      for (const [k, v] of map) obj[k] = v;
      const json = JSON.stringify(obj, null, 2);
      await fs.writeFile(this.stateFile, json, { encoding: "utf8", mode: 0o600 }).catch(
        () => undefined,
      );
    });
    return this.writing;
  }
}

/** True when a message is a plain user text turn (a candidate injected turn). */
function isPlainUserText(m: { role: string; content: string; toolCall?: unknown }): boolean {
  if (m.role !== "user" || m.toolCall) return false;
  // A background `<task-notification>` is a harness-injected user line, not a
  // send_message/schedule injection — never attribute it to a sender.
  return !m.content.trimStart().startsWith("<task-notification>");
}

/** Does a parsed message's content satisfy a marker (exact, or prefix if capped)? */
function matchesMarker(content: string, marker: InjectedMarker): boolean {
  const trimmed = content.trim();
  return marker.truncated ? trimmed.startsWith(marker.content) : trimmed === marker.content;
}

/**
 * Attach `sender` to each machine-injected user message by joining the parsed
 * transcript against this session's ordered injection markers (issue #290).
 *
 * The join is greedy and in-order: a pointer walks the markers; for each plain
 * user-text message we test it against the NEXT unconsumed marker, and on a match
 * attach that sender and advance the pointer. A message that doesn't match the
 * pending marker is treated as human-typed (left unlabelled) WITHOUT advancing the
 * pointer, so a later injected message can still claim the marker. Order alignment
 * holds because injections into a session are serialised and the transcript
 * preserves order. Returns the input untouched when there are no markers.
 */
export function applyMessageProvenance<
  T extends { role: string; content: string; toolCall?: unknown },
>(messages: T[], markers: InjectedMarker[]): (T & { sender?: MessageSender })[] {
  if (markers.length === 0) return messages;
  let i = 0;
  return messages.map((m) => {
    if (i >= markers.length || !isPlainUserText(m)) return m;
    if (matchesMarker(m.content, markers[i])) {
      const sender = markers[i].sender;
      i++;
      return { ...m, sender };
    }
    return m;
  });
}
