/**
 * ChatVerdictStore — a Paddock-side sidecar for each chat's latest post-turn
 * verdict: does the chat look "finished", or "could continue" (`chat-judge.ts`)?
 *
 * Same tiny JSON sidecar pattern as {@link import("./star.js").StarStore}, keyed by
 * `<agent>\0<sessionId>` (NUL-separated, so chats under different agents can never
 * collide). Unlike the star set this holds a record per key, so the file is an
 * object rather than an array. One verdict per chat: a new one replaces the old.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "chat-verdict.json";
/** Separator in a storage key; a NUL can't occur in an agent name or a UUID. */
const KEY_SEP = "\u0000";

/** The two answers the judge may give. */
export const CHAT_VERDICTS = ["finished", "could-continue"] as const;
export type ChatVerdictKind = (typeof CHAT_VERDICTS)[number];

/** Cap on a stored reason, in characters. The judge is asked for far less. */
export const VERDICT_REASON_MAX = 120;

/** One stored verdict. */
export interface ChatVerdict {
  verdict: ChatVerdictKind;
  /** The judge's one-line reason, at most {@link VERDICT_REASON_MAX} chars. */
  reason: string;
  /**
   * The completion this verdict judged: the chat's `lastMessageAt` when the judge
   * ran (see `last-activity.ts`), the same value the chat DTO's `updatedAt` reads.
   * That is what lets the list drop a verdict a later message has outdated.
   */
  turnCompletedAt: string;
  /** ISO time the judge ran. */
  judgedAt: string;
  /** The model that judged. */
  model: string;
}

/** The verdict as the chat DTO and the `chat:verdict` frame carry it. */
export type ChatVerdictDto = Omit<ChatVerdict, "model">;

/** Compose the storage key for an (agent, session) pair. */
function keyOf(agent: string, sessionId: string): string {
  return `${agent}${KEY_SEP}${sessionId}`;
}

/** Narrow an untrusted value (a hand-edited file) to a {@link ChatVerdict}. */
function isChatVerdict(v: unknown): v is ChatVerdict {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.verdict === "string" &&
    (CHAT_VERDICTS as readonly string[]).includes(o.verdict) &&
    typeof o.reason === "string" &&
    typeof o.turnCompletedAt === "string" &&
    typeof o.judgedAt === "string" &&
    typeof o.model === "string"
  );
}

export class ChatVerdictStore {
  private readonly stateFile: string;
  /** In-memory map of key → verdict (loaded once, written through on change). */
  private verdicts: Map<string, ChatVerdict> | null = null;
  /** The in-flight load, shared by concurrent first callers (see StarStore). */
  private loadPromise: Promise<Map<string, ChatVerdict>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted map (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Map<string, ChatVerdict>> {
    if (this.verdicts) return Promise.resolve(this.verdicts);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const map = new Map<string, ChatVerdict>();
        try {
          const raw = await fs.readFile(this.stateFile, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) if (isChatVerdict(v)) map.set(k, v);
          }
        } catch {
          /* missing or unreadable — start empty */
        }
        this.verdicts = map;
        return map;
      })();
    }
    return this.loadPromise;
  }

  /** A chat's stored verdict. Non-throwing: any load error reads as none. */
  async get(agent: string, sessionId: string): Promise<ChatVerdict | undefined> {
    const map = await this.ensureLoaded().catch(() => new Map<string, ChatVerdict>());
    return map.get(keyOf(agent, sessionId));
  }

  /** Store (replace) a chat's verdict. */
  async set(agent: string, sessionId: string, verdict: ChatVerdict): Promise<void> {
    const map = await this.ensureLoaded();
    map.set(keyOf(agent, sessionId), verdict);
    await this.persist(map);
  }

  /** Forget a chat's verdict (chat delete). Returns whether one was stored. */
  async forget(agent: string, sessionId: string): Promise<boolean> {
    const map = await this.ensureLoaded();
    if (!map.delete(keyOf(agent, sessionId))) return false;
    await this.persist(map);
    return true;
  }

  /** Write-through, serialised so overlapping writes can't corrupt the file. */
  private persist(map: Map<string, ChatVerdict>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const json = JSON.stringify(Object.fromEntries(map), null, 2);
      await fs.writeFile(this.stateFile, json, "utf8").catch(() => undefined);
    });
    return this.writing;
  }
}

/** The wire shape of a stored verdict (drops `model`, which no client reads). */
export function toVerdictDto(v: ChatVerdict): ChatVerdictDto {
  return {
    verdict: v.verdict,
    reason: v.reason,
    turnCompletedAt: v.turnCompletedAt,
    judgedAt: v.judgedAt,
  };
}

/**
 * The verdict a chat list should show, or `undefined` when there is none or it
 * is out of date.
 *
 * A verdict is current when it judged the chat's last message: its
 * `turnCompletedAt` equals the chat's `lastMessageAt`. A chat with no datable
 * last message cannot be checked, so its verdict is shown as stored. A chat
 * whose last message is newer than the judged one has had a turn since; its
 * verdict is withheld until the judge catches up (it runs after every turn).
 */
export function currentVerdict(
  v: ChatVerdict | undefined,
  lastMessageAt: string | undefined,
): ChatVerdictDto | undefined {
  if (!v) return undefined;
  if (lastMessageAt !== undefined && lastMessageAt !== v.turnCompletedAt) return undefined;
  return toVerdictDto(v);
}

/** The `verdictOf` resolver shape `buildProjectChats` takes. */
export type VerdictResolver = (s: {
  sessionId: string;
  lastMessageAt?: string;
}) => Promise<ChatVerdictDto | undefined>;

/**
 * Build the `verdictOf` resolver for `buildProjectChats`: the keeper's stored
 * verdict for each listed chat, filtered by {@link currentVerdict}. `undefined`
 * when no store is wired (tests that predate verdicts).
 */
export function makeVerdictResolver(
  store: Pick<ChatVerdictStore, "get"> | undefined,
  keeper: string,
): VerdictResolver | undefined {
  if (!store) return undefined;
  return async (s) => currentVerdict(await store.get(keeper, s.sessionId), s.lastMessageAt);
}
