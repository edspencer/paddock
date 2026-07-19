/**
 * Keeper-chat recovery ENGINE — Layer 3 (automatic re-drive) for issue #301.
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 * Phase 0 (recovery-config.ts) defined the config surface and Phase 1 (Layer 2)
 * shipped the manual "Continue" button. This module is Layer 3: it AUTOMATICALLY
 * unsticks a keeper whose background task was killed at the turn boundary, with no
 * human in the loop — the same nudge a human sends by hand (or clicks Continue for),
 * fired on its own.
 *
 * ── How it detects a hang (approach A — post-turn transcript tail) ────────────
 * The one thing we can rely on (see edspencer/herdctl#374) is that herdctl keeps
 * the session ALIVE at the turn boundary and the transcript is the source of truth.
 * So after a SESSION-mode keeper turn completes, {@link RecoveryEngine.armWatch}
 * tails that session's transcript JSONL for a bounded window:
 *
 *   1. A COMPLETED background task emits a follow-up that WAKES the keeper — more
 *      `assistant` entries append. A KILLED/STOPPED task writes a terminated
 *      `<task-notification>` (a `user` entry) that wakes NOTHING — no assistant
 *      entry follows it.
 *   2. So the hung signature is: the tail ends (logically) with a terminated
 *      task-notification and NO `assistant` activity after it. That's exactly what
 *      {@link detectHang} computes by reducing the appended entries in order.
 *   3. The kill lands ~2–8s AFTER the turn ends, so the watch polls for
 *      `debounceMs + KILL_GRACE_MS`, and only fires once the notification has sat
 *      un-answered for the full `debounceMs` quiet window — a keeper that wakes
 *      itself inside that window resets the pending state and is never poked.
 *
 * ── Guards (issue #301) ───────────────────────────────────────────────────────
 *   - Only fires when the resolved `recovery.autoReDrive` (per-project override
 *     else instance default) is ON — Layer 3 is opt-in.
 *   - Per-session `{ lastNudgeAt, retryCount }`: a wedged keeper is re-driven at
 *     most `maxRetries` times, then left alone (no poke-loop).
 *   - `debounceMs`: never fires until the notification has been quiet that long.
 *   - A HUMAN message ({@link RecoveryEngine.onHumanMessage}) clears the session's
 *     entry, so a genuinely-new later hang re-arms fresh.
 *
 * The engine is deliberately narrow + injectable (clock, scheduler, transcript
 * reader) so the timing-sensitive orchestration is unit-testable without real
 * timers or a real filesystem — same discipline as the sidecar-store modules.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { projectChatsDir } from "./transcripts.js";
import { isTerminatedTaskStatus, resolveRecoveryConfig, type RecoveryConfig } from "./recovery-config.js";
import type { Project } from "./projects.js";

/**
 * The kinds of transcript entry the hang detector cares about. Everything that
 * isn't a keeper `assistant` turn or a terminated `<task-notification>` (system
 * lines, attachments, queue-operations, tool_result user turns, clean/running
 * notifications, …) is `other` and doesn't move the pending state.
 */
export type TailEvent = "assistant" | "terminated-notification" | "other";

/** A minimal structural view of one parsed transcript JSONL entry. */
interface TranscriptEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** Flatten a transcript message `content` (string, or an array of blocks) to text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const blk = b as { type?: string; text?: unknown };
      return blk?.type === "text" && typeof blk.text === "string" ? blk.text : "";
    })
    .join("");
}

/** Extract a `<task-notification>` `<status>` value, or undefined. */
function notificationStatus(text: string): string | undefined {
  return /<status>([\s\S]*?)<\/status>/.exec(text)?.[1];
}

/**
 * Classify one already-parsed transcript entry. A keeper reply is `assistant`; a
 * `user` entry whose content is a `<task-notification>` with a terminated
 * (killed/stopped) status is `terminated-notification`; everything else is
 * `other`. Note a COMPLETED/running notification is `other` — only a terminated
 * one denotes the turn-boundary kill this recovers from.
 */
export function classifyEntry(entry: TranscriptEntry): TailEvent {
  if (entry.type === "assistant") return "assistant";
  if (entry.type === "user") {
    const text = contentText(entry.message?.content);
    if (text.includes("<task-notification>") && isTerminatedTaskStatus(notificationStatus(text))) {
      return "terminated-notification";
    }
  }
  return "other";
}

/** Classify one raw JSONL line (unparseable/blank → `other`). */
export function classifyLine(line: string): TailEvent {
  const trimmed = line.trim();
  if (!trimmed) return "other";
  try {
    return classifyEntry(JSON.parse(trimmed) as TranscriptEntry);
  } catch {
    return "other";
  }
}

/**
 * Reduce an ordered stream of tail events to whether the transcript currently ends
 * (logically) with an un-answered terminated task-notification — the hung
 * signature. An `assistant` entry clears any pending notification (the keeper
 * woke); a terminated notification sets it; `other` entries are inert. True iff a
 * terminated notification is still pending after the last event.
 */
export function detectHang(events: Iterable<TailEvent>): boolean {
  let pending = false;
  for (const ev of events) {
    if (ev === "assistant") pending = false;
    else if (ev === "terminated-notification") pending = true;
  }
  return pending;
}

/** A scheduled-timer handle — opaque; produced by `setTimer`, passed to `clearTimer`. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Appended-transcript reader result: the new text and the file's current size. */
export interface TranscriptTail {
  /** UTF-8 text appended since the requested offset (may be empty). */
  text: string;
  /** The file's current size in bytes (the next offset to read from). */
  size: number;
}

/** Injectable primitives so the timing-sensitive watch is deterministically testable. */
export interface RecoveryEngineDeps {
  /** Resolve the recovery config for a dispatch — instance default here; the engine
   *  layers the per-project override on top via {@link resolveRecoveryConfig}. */
  cfg: { recovery: RecoveryConfig };
  /** Look up the target project (for its `.chats/` dir + `recovery` override). Throws
   *  for an unknown/deleted project — the engine treats that as "nothing to recover". */
  getProject: (slug: string) => Promise<Project>;
  /** Inject the recovery nudge into the still-alive session (Layer 2's exact path:
   *  `startAgentTurn({ resume, prompt: RECOVERY_NUDGE, sender: { kind: "recovery" } })`). */
  reDrive: (project: Project, sessionId: string) => Promise<void>;
  /** Wall clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Schedule a one-shot timer. Default `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Cancel a scheduled timer. Default `clearTimeout`. */
  clearTimer?: (h: TimerHandle) => void;
  /** Read the transcript bytes appended since `offset`. Default reads `<dir>/.chats/<id>.jsonl`. */
  readTail?: (file: string, offset: number) => Promise<TranscriptTail>;
  /** Poll cadence (ms) while watching. Default {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Extra window (ms) beyond `debounceMs` to allow the kill to land. Default {@link DEFAULT_KILL_GRACE_MS}. */
  killGraceMs?: number;
  /** Optional structured-log sink for observability; default no-op. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Default poll cadence — brisk enough to catch the kill+debounce, cheap enough to ignore. */
export const DEFAULT_POLL_MS = 750;
/**
 * How long past `debounceMs` we keep watching for the kill to land. herdctl#374's
 * teardown fires ~2–8s after the turn boundary, so the notification can appear late;
 * this grace ensures its full `debounceMs` quiet window still fits inside the watch.
 */
export const DEFAULT_KILL_GRACE_MS = 12_000;

/** Per-session recovery bookkeeping (issue #301 guards). */
interface SessionGuard {
  /** Wall-clock ms of the last auto re-drive we fired for this session. */
  lastNudgeAt: number;
  /** How many auto re-drives we've fired for this session since the last human message. */
  retryCount: number;
}

/** One live transcript watch. */
interface Watch {
  timer: TimerHandle | null;
  cancelled: boolean;
}

/**
 * Read the transcript bytes appended since `offset` using a single positioned read
 * (not a whole-file slurp), so tailing a large transcript stays cheap. A missing
 * file yields no new text at the same offset (the turn simply never wrote one).
 */
async function defaultReadTail(file: string, offset: number): Promise<TranscriptTail> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    fh = await fsp.open(file, "r");
    const { size } = await fh.stat();
    if (size <= offset) return { text: "", size };
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, offset);
    return { text: buf.toString("utf8"), size };
  } catch {
    return { text: "", size: offset };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Layer 3 automatic-recovery engine (issue #301). Arm a post-turn transcript watch
 * after each session-mode keeper turn; if a killed-at-turn-boundary notification
 * appears with no keeper response, auto-inject a recovery nudge — guarded by
 * debounce + a per-session retry cap, and cleared when a human next messages.
 */
export class RecoveryEngine {
  private readonly deps: RecoveryEngineDeps;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;
  private readonly readTail: (file: string, offset: number) => Promise<TranscriptTail>;
  private readonly pollMs: number;
  private readonly killGraceMs: number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  /** Per-session retry/debounce bookkeeping — cleared on a human message. */
  private readonly guards = new Map<string, SessionGuard>();
  /** In-flight watches keyed by session id — re-arming or a human message cancels one. */
  private readonly watches = new Map<string, Watch>();

  constructor(deps: RecoveryEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
    this.readTail = deps.readTail ?? defaultReadTail;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * Arm (or re-arm) a post-turn watch for a just-completed SESSION-mode keeper turn.
   * No-op unless Layer 3 (`autoReDrive`) is on for this project and the session still
   * has retries left. Re-arming cancels any prior watch for the same session. Safe to
   * call fire-and-forget; never throws (a lookup/IO failure just declines to watch).
   */
  armWatch(input: { slug: string; sessionId: string }): void {
    void this.armWatchAsync(input).catch((err) => {
      this.log("recovery: armWatch failed", { err: String(err), ...input });
    });
  }

  private async armWatchAsync({ slug, sessionId }: { slug: string; sessionId: string }): Promise<void> {
    let project: Project;
    try {
      project = await this.deps.getProject(slug);
    } catch {
      return; // unknown/deleted project — nothing to recover
    }
    const recovery = resolveRecoveryConfig(project.recovery, this.deps.cfg.recovery);
    if (!recovery.autoReDrive) return; // Layer 3 opt-in only

    // The retry cap gates ARMING (a fresh session defaults to 0 re-drives so far).
    // Because each armed watch fires at most once, gating arm on
    // `retryCount >= maxRetries` bounds total auto re-drives to exactly maxRetries —
    // and `maxRetries: 0` therefore disables auto-recovery entirely (never arms),
    // even for a session with no prior guard.
    const retryCount = this.guards.get(sessionId)?.retryCount ?? 0;
    if (retryCount >= recovery.maxRetries) {
      // Cap reached since the last human message (or maxRetries is 0) — leave it be.
      this.log("recovery: retry cap reached, not arming", {
        slug,
        sessionId,
        retryCount,
        maxRetries: recovery.maxRetries,
      });
      return;
    }

    // Re-arming supersedes any prior watch for this session.
    this.cancelWatch(sessionId);

    const file = path.join(projectChatsDir(project.dir), `${sessionId}.jsonl`);
    const baseline = await this.readTail(file, 0);
    // Start reading from the current EOF so we only see entries appended AFTER this
    // turn (the kill's notification), never a stale notification from earlier.
    let offset = baseline.size;
    let carry = "";
    let pending = false;
    let notifiedAt: number | null = null;
    const deadline = this.now() + recovery.debounceMs + this.killGraceMs;

    const watch: Watch = { timer: null, cancelled: false };
    this.watches.set(sessionId, watch);

    const tick = async (): Promise<void> => {
      if (watch.cancelled) return;
      let tail: TranscriptTail;
      try {
        tail = await this.readTail(file, offset);
      } catch {
        tail = { text: "", size: offset };
      }
      if (watch.cancelled) return;
      offset = tail.size;
      const combined = carry + tail.text;
      const lines = combined.split("\n");
      // The last element is an incomplete (unterminated) line — hold it for next read.
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const ev = classifyLine(line);
        if (ev === "assistant") {
          pending = false;
          notifiedAt = null;
        } else if (ev === "terminated-notification" && !pending) {
          pending = true;
          notifiedAt = this.now();
        }
      }

      const t = this.now();
      if (pending && notifiedAt !== null && t - notifiedAt >= recovery.debounceMs) {
        // Hung: a terminated notification has sat un-answered for the full debounce.
        this.cancelWatch(sessionId);
        await this.fireReDrive(project, sessionId, recovery);
        return;
      }
      if (t >= deadline) {
        // The turn ended cleanly (no kill) or the keeper woke — stop watching.
        this.cancelWatch(sessionId);
        return;
      }
      if (!watch.cancelled) watch.timer = this.setTimer(() => void tick(), this.pollMs);
    };

    watch.timer = this.setTimer(() => void tick(), this.pollMs);
  }

  /**
   * Fire one automatic re-drive: bump the session's retry bookkeeping first (so a
   * re-drive that itself hangs can't exceed the cap), then inject the recovery nudge
   * via the shared Layer 2 path. A failed inject is logged, not thrown.
   */
  private async fireReDrive(project: Project, sessionId: string, recovery: RecoveryConfig): Promise<void> {
    const guard = this.guards.get(sessionId) ?? { lastNudgeAt: 0, retryCount: 0 };
    guard.retryCount += 1;
    guard.lastNudgeAt = this.now();
    this.guards.set(sessionId, guard);
    this.log("recovery: auto re-driving hung keeper", {
      slug: project.slug,
      sessionId,
      retryCount: guard.retryCount,
      maxRetries: recovery.maxRetries,
    });
    try {
      await this.deps.reDrive(project, sessionId);
    } catch (err) {
      this.log("recovery: auto re-drive inject failed", { sessionId, err: String(err) });
    }
  }

  /**
   * A human just messaged this session — clear its retry/debounce bookkeeping and
   * cancel any in-flight watch, so a genuinely-new later hang is recovered fresh
   * (the retry cap counts auto re-drives BETWEEN human messages).
   */
  onHumanMessage(sessionId: string): void {
    this.guards.delete(sessionId);
    this.cancelWatch(sessionId);
  }

  /** Cancel the in-flight watch for a session, if any (idempotent). */
  private cancelWatch(sessionId: string): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    w.cancelled = true;
    if (w.timer !== null) this.clearTimer(w.timer);
    this.watches.delete(sessionId);
  }

  /** Cancel every in-flight watch (e.g. on shutdown). */
  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.cancelWatch(id);
  }

  /** Test/inspection helper: the current retry count for a session (0 if untracked). */
  retryCountFor(sessionId: string): number {
    return this.guards.get(sessionId)?.retryCount ?? 0;
  }

  /** Test/inspection helper: whether a watch is currently armed for a session. */
  isWatching(sessionId: string): boolean {
    return this.watches.has(sessionId);
  }
}
