/**
 * UnreadStore — a Paddock-side sidecar for the per-chat, per-user MANUAL "unread"
 * override (#458).
 *
 * The unread affordance (#160) is normally DERIVED: a chat reads as unread when
 * the agent finished a turn (`lastTurnCompletedAt`) more recently than the user
 * last viewed it (`ReadStateStore` `lastSeen`). This store adds an explicit,
 * user-driven override on top of that derivation: "mark this chat unread" so it
 * resurfaces its cue the next time you come back to the list — the email-client
 * pattern. It cannot be expressed by pushing `lastSeen` backwards, because that
 * value is deliberately MONOTONIC (see {@link ReadStateStore}); it needs its own
 * flag.
 *
 * Shape/pattern is a near-verbatim copy of {@link StarStore} — a tiny JSON
 * sidecar in the data dir, write-through, serialised, corruption-tolerant, only
 * storing the SET keys (an unread=false clears the key) so the file stays compact.
 * The one difference is KEYING: like read-state (and unlike star/archive, which
 * are shared) the override is PER USER — "I haven't dealt with this yet" is
 * personal — so it reuses {@link keyOf} from read-state:
 *   - Real identity (trusted-header / jwt): `username \0 agent \0 sessionId`
 *   - No user (`none` mode / anonymous):     `agent \0 sessionId` (shared bucket)
 *
 * Written `0o600` (like read-state) — low-sensitivity personal metadata (which
 * chats you flagged to revisit), but no reason for it to be world-readable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { keyOf } from "./read-state.js";

const STATE_FILE = "unread-state.json";

export class UnreadStore {
  private readonly stateFile: string;
  /** In-memory set of manually-unread keys (loaded once, written through on change). */
  private marked: Set<string> | null = null;
  /**
   * The in-flight load, cached so concurrent first-callers share ONE read — same
   * lost-update guard as {@link StarStore} / {@link ReadStateStore}.
   */
  private loadPromise: Promise<Set<string>> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted set (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<Set<string>> {
    if (this.marked) return Promise.resolve(this.marked);
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
        this.marked = new Set(keys);
        return this.marked;
      })();
    }
    return this.loadPromise;
  }

  /**
   * Whether this user has manually flagged this chat unread. Non-throwing: any
   * load error reads as false. Pass `null` for `username` to read the shared bucket.
   */
  async isUnread(username: string | null, agent: string, sessionId: string): Promise<boolean> {
    const set = await this.ensureLoaded().catch(() => new Set<string>());
    return set.has(keyOf(username, agent, sessionId));
  }

  /**
   * Set (or clear) this user's manual-unread flag for this chat, persisting the
   * change. Idempotent. Returns whether the flag actually CHANGED, mirroring
   * `StarStore.setStarred`. Pass `null` for `username` to write the shared bucket.
   */
  async setUnread(
    username: string | null,
    agent: string,
    sessionId: string,
    unread: boolean,
  ): Promise<boolean> {
    const set = await this.ensureLoaded();
    const key = keyOf(username, agent, sessionId);
    if (unread === set.has(key)) return false; // no-op — avoid a needless write
    if (unread) set.add(key);
    else set.delete(key);
    await this.persist(set);
    return true;
  }

  /**
   * Set (or clear) this user's manual-unread flag for MANY chats in ONE write
   * (#508) — the subtree "mark read / mark unread" action. Same single-persist
   * rationale as `ArchiveStore.setManyArchived`: a client-side loop over a
   * 21-chat family can half-succeed and leave the family in two different states.
   * Returns the ids whose flag actually changed.
   */
  async setManyUnread(
    username: string | null,
    agent: string,
    sessionIds: readonly string[],
    unread: boolean,
  ): Promise<string[]> {
    const set = await this.ensureLoaded();
    const changed: string[] = [];
    for (const sessionId of sessionIds) {
      const key = keyOf(username, agent, sessionId);
      if (unread === set.has(key)) continue; // already in the target state
      if (unread) set.add(key);
      else set.delete(key);
      changed.push(sessionId);
    }
    if (changed.length) await this.persist(set);
    return changed;
  }

  /** Write-through, serialised so overlapping toggles can't corrupt the file. */
  private persist(set: Set<string>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const json = JSON.stringify([...set], null, 2);
      await fs.writeFile(this.stateFile, json, { encoding: "utf8", mode: 0o600 }).catch(
        () => undefined,
      );
    });
    return this.writing;
  }
}
