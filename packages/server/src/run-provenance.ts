/**
 * RunProvenanceStore — a Paddock-side sidecar recording HOW each chat was
 * created: its provenance `origin` (human / scheduled / spawned) and its spawn
 * `depth` within a fan-out tree. This is the FOUNDATION marker for the
 * Events / Schedules / Config initiative (issue #261 / design decisions DD-3,
 * DD-6). Later tickets read it:
 *   - #262 reads a chat's `depth` to gate whether it may spawn children (the
 *     fork-bomb bound: inject the self-MCP write tools iff depth < maxSpawnDepth).
 *   - #267 reads a chat's `origin` to badge it (human / scheduled / spawned) in
 *     the chat list.
 *
 * This ticket (A1) only CARRIES and PERSISTS the marker — nothing gates on it
 * yet, and spawn behaviour is unchanged.
 *
 * Shape: a `sessionId -> { origin, depth }` map persisted as a plain JSON object
 * — the exact ArchiveStore / ReadStateStore sidecar pattern (lazy-loaded,
 * write-through, serialised, corruption-tolerant, `0o600`). Provenance is
 * low-sensitivity but there's no reason for it to be world-readable.
 *
 * Semantics: provenance describes how a chat was CREATED, so it is stamped once —
 * at creation — and is NEVER clobbered by a later turn. Resuming, waking, or
 * `send_message`-ing an existing chat leaves its recorded provenance intact.
 * Callers use {@link RunProvenanceStore.stamp} at the point they create a chat and
 * {@link RunProvenanceStore.stampIfAbsent} on paths that may resume an
 * already-known chat (e.g. a scheduler wake), so an established marker can't be
 * overwritten.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "run-provenance.json";

/**
 * Every origin, as VALUES — the single source of truth for both the type and the
 * runtime allowlist {@link coerce} validates against.
 *
 * Declared this way round on purpose (#588). It used to be a hand-written union
 * with a separate `readonly TurnOrigin[]` list, and `readonly TurnOrigin[]` only
 * asserts that each element IS an origin — never that every origin is an
 * element. So when the union grew, the allowlist silently lagged: `coerce()`
 * returned null for the new member, and every chat carrying it lost BOTH its
 * badge and its parent edge on read, with no error anywhere. Deriving the type
 * from the list makes that impossible rather than merely documented.
 */
export const ORIGINS = ["human", "scheduled", "spawned", "hook", "adopted"] as const;

/**
 * How a turn/chat came to exist — the provenance dimension #267 badges on.
 *
 * `adopted` (#588) is the odd one out: the chat was not created by Paddock at
 * all. It is a terminal `claude` session the user ran themselves and later
 * imported, so it has no creating turn, no parent, and nothing ever "ran" it
 * here. It is therefore a ROOT and it is ATTENDED — see `ORIGIN_IS_ROOT` in
 * ./chat-dto.ts and `ORIGIN_IS_UNATTENDED` in ./runs.ts, both of which are
 * `Record<TurnOrigin, boolean>` so that adding a member here forces a
 * DECISION at each of them instead of a silent fallthrough.
 */
export type TurnOrigin = (typeof ORIGINS)[number];

/** A chat's provenance marker: how it was created + how deep in a spawn tree. */
export interface RunProvenance {
  origin: TurnOrigin;
  /** Spawn hops from the human/scheduled root (0 = root). #262 gates on this. */
  depth: number;
  /**
   * The chat that CREATED this one — the parent edge the nested chat list draws.
   * `depth` alone says a chat was spawned and how deep, but never BY WHOM, so the
   * list could badge a child yet not file it under its parent.
   *
   * Absent for roots, for chats created before this field existed, and for the
   * external `/mcp` transport (no calling chat). Historical chats are backfilled
   * at read time from MessageProvenanceStore — see `parentChat()` there.
   */
  parentSessionId?: string;
  /** The parent's project slug — a parent can live in ANOTHER project. */
  parentProject?: string;
}

/** A reference to the chat that created another one. */
export interface ParentChatRef {
  project: string;
  sessionId: string;
}

/** The root of any chat tree a human starts: origin `human`, depth 0. */
export const HUMAN_ROOT: RunProvenance = { origin: "human", depth: 0 };

/**
 * A schedule-fired chat: origin `scheduled`, depth 0. A cron is a root trigger,
 * exactly like a human — there is no scheduler wired yet (that's Epic D), but the
 * marker path accepts it now.
 */
export const SCHEDULED_ROOT: RunProvenance = { origin: "scheduled", depth: 0 };

/**
 * An IMPORTED terminal chat (#588): origin `adopted`, depth 0.
 *
 * Depth 0 because the session was never spawned by anything in this instance —
 * the user ran it themselves in a terminal and Paddock only adopted the
 * transcript. Stamped with `stampIfAbsent`, never `stamp`: if a chat somehow
 * already carries a marker, whatever created it here knows more about its
 * origin than the import does.
 */
export const ADOPTED_ROOT: RunProvenance = { origin: "adopted", depth: 0 };

/**
 * The provenance a child inherits when `parent` spawns it via a self-MCP write
 * tool: origin becomes `spawned` and depth is one deeper. So a fan-out tree's
 * depth is always the number of spawn hops from its human/scheduled root, which
 * is exactly what #262 bounds with `maxSpawnDepth`.
 */
export function childOf(parent: RunProvenance, parentRef?: ParentChatRef | null): RunProvenance {
  return {
    origin: "spawned",
    depth: parent.depth + 1,
    // Record WHICH chat spawned it, when the caller knows. Optional so every
    // existing `childOf(p)` call site stays correct (just without the edge).
    ...(parentRef?.sessionId
      ? { parentSessionId: parentRef.sessionId, parentProject: parentRef.project }
      : {}),
  };
}

function isOrigin(v: unknown): v is TurnOrigin {
  return typeof v === "string" && (ORIGINS as readonly string[]).includes(v);
}

/** A session id we're willing to key on — mirrors attributeRunningSession's guard. */
function isSafeId(sessionId: string): boolean {
  return typeof sessionId === "string" && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

/** Validate + normalize an untrusted value into a RunProvenance, or null. */
function coerce(value: unknown): RunProvenance | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (!isOrigin(o.origin)) return null;
  const depth = o.depth;
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth < 0) return null;
  // The parent edge is optional and only carried when BOTH halves survive
  // validation — a session id without its project can't be resolved to a chat.
  const parentSessionId =
    typeof o.parentSessionId === "string" && isSafeId(o.parentSessionId)
      ? o.parentSessionId
      : undefined;
  const parentProject = typeof o.parentProject === "string" ? o.parentProject : undefined;
  return {
    origin: o.origin,
    depth: Math.floor(depth),
    // `parentProject` is a workspace key; `""` is the ROOT workspace, not
    // "missing". Test for presence, not truthiness, or a root chat's children
    // lose their recorded parent edge on every parse.
    ...(parentSessionId && parentProject !== undefined
      ? { parentSessionId, parentProject }
      : {}),
  };
}

export class RunProvenanceStore {
  private readonly stateFile: string;
  /** In-memory map of sessionId -> provenance (loaded once, written through). */
  private state: Map<string, RunProvenance> | null = null;
  /**
   * The in-flight load, cached so concurrent first-callers share ONE read.
   * Caching only the resolved `state` would let several stamps that begin before
   * the first `fs.readFile` resolves each build their own map and race on the
   * assignment — a lost update (last writer's map wins, dropping the others'
   * keys). Reachable when a keeper spawns several children right after startup.
   */
  private loadPromise: Promise<Map<string, RunProvenance>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted map (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Map<string, RunProvenance>> {
    if (this.state) return Promise.resolve(this.state);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const map = new Map<string, RunProvenance>();
        try {
          const raw = await fs.readFile(this.stateFile, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              const p = coerce(v);
              if (p) map.set(k, p);
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

  /** This chat's recorded provenance, or undefined if none. Non-throwing. */
  async get(sessionId: string): Promise<RunProvenance | undefined> {
    const map = await this.ensureLoaded().catch(() => new Map<string, RunProvenance>());
    return map.get(sessionId);
  }

  /**
   * Record a chat's provenance. Idempotent (a repeat of the same marker is a
   * no-op), and a blank/unsafe session id or malformed marker is ignored. Callers
   * stamp a chat when they CREATE it, so this is a fresh key in practice; it does
   * overwrite if called again (unlike {@link stampIfAbsent}).
   */
  async stamp(sessionId: string, provenance: RunProvenance): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const p = coerce(provenance);
    if (!p) return;
    const map = await this.ensureLoaded();
    const prev = map.get(sessionId);
    if (prev && prev.origin === p.origin && prev.depth === p.depth) return; // no-op
    map.set(sessionId, p);
    await this.persist(map);
  }

  /**
   * Record provenance ONLY if this chat has none yet — never clobbers an existing
   * marker. Used on resume/wake paths (a scheduler wake resumes a chat that may
   * already have been created by a human or a spawn), so its creation provenance
   * survives.
   */
  async stampIfAbsent(sessionId: string, provenance: RunProvenance): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const map = await this.ensureLoaded();
    if (map.has(sessionId)) return;
    await this.stamp(sessionId, provenance);
  }

  /**
   * Forget a chat's provenance (#660).
   *
   * The inverse of {@link stamp}, for the one case where a chat's creation is
   * itself undone: undoing a native-chat import releases the adoption and deletes
   * the copy, and a marker left behind would badge a LATER import of the same
   * session as belonging to the one that was undone. Returns silently when there
   * was nothing recorded, so an undo of a partially-stamped import is not an
   * error.
   */
  async clear(sessionId: string): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const map = await this.ensureLoaded();
    if (!map.delete(sessionId)) return;
    await this.persist(map);
  }

  /** Write-through, serialised so overlapping stamps can't corrupt the file. */
  private persist(map: Map<string, RunProvenance>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const obj: Record<string, RunProvenance> = {};
      for (const [k, v] of map) obj[k] = v;
      const json = JSON.stringify(obj, null, 2);
      await fs.writeFile(this.stateFile, json, { encoding: "utf8", mode: 0o600 }).catch(
        () => undefined,
      );
    });
    return this.writing;
  }
}
