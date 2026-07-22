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
  /** Present on a `type:"queue-operation"` entry (`enqueue`/`dequeue`). */
  operation?: string;
  /** The payload of a `queue-operation` enqueue — for a killed background task
   *  this IS the `<task-notification>` (string, or an array of text blocks). #347 */
  content?: unknown;
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

/** True when `text` is a `<task-notification>` carrying a terminated (killed/
 *  stopped) status — the turn-boundary-kill signature this recovers from. */
function isTerminatedNotificationText(text: string): boolean {
  return text.includes("<task-notification>") && isTerminatedTaskStatus(notificationStatus(text));
}

/**
 * Classify one already-parsed transcript entry as the hang detector sees it.
 *
 * A terminated `<task-notification>` reaches the transcript in TWO shapes, and we
 * must catch both (issue #347):
 *   - As a materialised `type:"user"` entry — but that only appears once a LATER
 *     turn flushes the SDK's input queue, often tens of seconds after the kill.
 *   - At the moment of the kill, as a `type:"queue-operation"` `enqueue` whose
 *     `content` IS the notification. This is the one that lands inside the watch
 *     window; missing it (the original bug) let every real hang go undetected.
 *
 * A keeper reply is `assistant`; a killed/stopped notification in either shape is
 * `terminated-notification`; everything else (system lines, attachments, a
 * `dequeue`, a completed/running notification, plain user text) is `other`.
 */
export function classifyEntry(entry: TranscriptEntry): TailEvent {
  if (entry.type === "assistant") return "assistant";
  if (entry.type === "user" && isTerminatedNotificationText(contentText(entry.message?.content))) {
    return "terminated-notification";
  }
  // The kill's notification is delivered to the input queue as an `enqueue`
  // whose `content` is the `<task-notification>`; a `dequeue` carries no payload.
  if (entry.type === "queue-operation" && entry.operation === "enqueue") {
    if (isTerminatedNotificationText(contentText(entry.content))) return "terminated-notification";
  }
  return "other";
}

/** Extract a `<task-notification>` `<summary>` value (trimmed), or undefined. */
function notificationSummary(text: string): string | undefined {
  return /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() || undefined;
}

/** The notification payload carried by an entry, whichever shape it took: a
 *  `user` message's content, or a `queue-operation` enqueue's `content`. */
function notificationText(entry: TranscriptEntry): string {
  if (entry.type === "user") return contentText(entry.message?.content);
  if (entry.type === "queue-operation") return contentText(entry.content);
  return "";
}

/**
 * Parse one raw JSONL line into its {@link TailEvent} plus, for a terminated
 * notification, its human-readable `<summary>` (used by the live surface frame).
 * Unparseable/blank → `other`.
 */
export function parseTailLine(line: string): { event: TailEvent; summary?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { event: "other" };
  let entry: TranscriptEntry;
  try {
    entry = JSON.parse(trimmed) as TranscriptEntry;
  } catch {
    return { event: "other" };
  }
  const event = classifyEntry(entry);
  return event === "terminated-notification"
    ? { event, summary: notificationSummary(notificationText(entry)) }
    : { event };
}

/** Classify one raw JSONL line (unparseable/blank → `other`). */
export function classifyLine(line: string): TailEvent {
  return parseTailLine(line).event;
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
  /** Surface the detected kill to any attached client LIVE (Layer 2 `surfaceKilledTask`)
   *  so the "keeper is idle / Continue" affordance appears WITHOUT a refresh — the
   *  notification is otherwise trapped in the SDK input queue until the next turn
   *  flushes it (issue #347). `summary` is the notification's `<summary>`, if any.
   *  Default no-op (surfacing off). */
  surface?: (project: Project, sessionId: string, summary: string | undefined) => void;
  /**
   * Is a live turn ALREADY driving this session? (issue #352 — double-dispatch
   * guard.) When the watch decides a keeper is hung, something else may have begun
   * driving the same session in the meantime — a human message, a queued-message
   * drain, or a prior recovery nudge. Under session-mode `chatSession(resume)` a
   * SECOND resume interrupts the first, so an auto re-drive fired into a live turn
   * would be swallowed (the "first message swallowed" symptom, #350/#347). If this
   * reports the session busy, the engine DEFERS (see {@link sdkSessionLive}) rather
   * than firing — the keeper is not idle. Default: never busy (so the pure
   * unit-tested engine behaviour is unchanged).
   */
  isBusy?: (sessionId: string) => boolean;
  /**
   * Is a `claude` SUBPROCESS still alive on this session at the herdctl/SDK layer?
   * (issue #397.) {@link isBusy} only reflects turns PADDOCK's hub started, so it
   * is BLIND to a session herdctl's `SessionReaper` is keeping alive for a killed
   * background task (keepAlive) or holding through its ~15s re-invocation grace —
   * throughout which `reaper.isSessionLive` is TRUE. Auto re-drive resumes via a
   * FRESH `openChatSession` = a NEW subprocess on the same session id; firing while
   * a prior subprocess is still live spawns a COMPETING concurrent resume that the
   * SDK resolves by interrupting the in-flight turn (`[Request interrupted by
   * user]`) — the recovery turn then produces nothing and the user is still stuck.
   * Wired in prod to `getSessionLifecycle()?.reaper.isSessionLive(sessionId)`;
   * default `() => false` keeps the pure engine behaviour unchanged (batch mode /
   * no reaper). Treated as a busy signal ORed with {@link isBusy}; when EITHER is
   * set the engine DEFERS the fire (not a permanent stand-down — see {@link
   * DEFAULT_SETTLE_WINDOW_MS}) so the nudge lands exactly once, after the session
   * is genuinely idle (reaper reaped, hub not running).
   */
  sdkSessionLive?: (sessionId: string) => boolean;
  /** Wall clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Schedule a one-shot timer. Default `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Cancel a scheduled timer. Default `clearTimeout`. */
  clearTimer?: (h: TimerHandle) => void;
  /** Read the transcript bytes appended since `offset`. Default reads `<dir>/.chats/<id>.jsonl`. */
  readTail?: (file: string, offset: number) => Promise<TranscriptTail>;
  /**
   * Cheap current size (bytes) of the transcript, for the arm-time baseline — a
   * `stat`, NOT a full read. Called once per armed watch on EVERY session-mode
   * keeper turn, so it must not slurp the (multi-MB) transcript. A missing file
   * (turn wrote none yet) → 0. Default `fsp.stat(file).size`.
   */
  fileSize?: (file: string) => Promise<number>;
  /** Poll cadence (ms) while watching. Default {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Extra window (ms) beyond `debounceMs` to allow the kill to land. Default {@link DEFAULT_KILL_GRACE_MS}. */
  killGraceMs?: number;
  /**
   * Cadence (ms) at which a DEFERRED fire re-checks liveness while the session is
   * still held live by the hub or the reaper (issue #397). Default {@link
   * DEFAULT_SETTLE_POLL_MS}.
   */
  settlePollMs?: number;
  /**
   * Total budget (ms) to keep deferring a fire while the session stays live before
   * giving up, so a session the reaper never releases can't defer forever (issue
   * #397). Default {@link DEFAULT_SETTLE_WINDOW_MS}.
   */
  settleWindowMs?: number;
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
/**
 * Cadence (ms) at which a deferred fire re-checks whether the session has gone
 * idle (issue #397). Brisk enough to fire promptly once the reaper releases,
 * cheap enough to ignore.
 */
export const DEFAULT_SETTLE_POLL_MS = 1_000;
/**
 * How long (ms) the engine keeps DEFERRING an otherwise-ready fire while the
 * session is still live (hub or reaper) before standing down (issue #397). Must
 * comfortably exceed herdctl's `DEFAULT_REINVOCATION_GRACE_MS` (15s) — the reaper
 * holds a just-killed-task session live for that grace — plus margin, so the
 * deferred nudge lands once the reaper reaps rather than giving up early. Bounds
 * the defer so a session the reaper never releases can't retry forever.
 */
export const DEFAULT_SETTLE_WINDOW_MS = 30_000;

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
 * Cheap current size (bytes) of the transcript via `stat` — the arm-time baseline,
 * so we never slurp a multi-MB transcript just to learn where its EOF is. A missing
 * file (the turn wrote no transcript yet) → 0, so the watch starts from the top.
 */
async function defaultFileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
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
  private readonly fileSize: (file: string) => Promise<number>;
  private readonly pollMs: number;
  private readonly killGraceMs: number;
  private readonly settlePollMs: number;
  private readonly settleWindowMs: number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  private readonly surface: (project: Project, sessionId: string, summary: string | undefined) => void;
  private readonly isBusy: (sessionId: string) => boolean;
  private readonly sdkSessionLive: (sessionId: string) => boolean;

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
    this.fileSize = deps.fileSize ?? defaultFileSize;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.settlePollMs = deps.settlePollMs ?? DEFAULT_SETTLE_POLL_MS;
    this.settleWindowMs = deps.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;
    this.log = deps.log ?? (() => undefined);
    this.surface = deps.surface ?? (() => undefined);
    this.isBusy = deps.isBusy ?? (() => false);
    this.sdkSessionLive = deps.sdkSessionLive ?? (() => false);
  }

  /**
   * Arm (or re-arm) a post-turn watch for a just-completed SESSION-mode keeper turn.
   * No-op unless SOMETHING wants it for this project: Layer 2 `surfaceKilledTask`
   * (surface the kill live) or Layer 3 `autoReDrive` (auto re-drive, while the
   * session has retries left). Re-arming cancels any prior watch for the same
   * session. Safe to call fire-and-forget; never throws (a lookup/IO failure just
   * declines to watch).
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

    // Two independent actions can want this watch: Layer 2 `surfaceKilledTask`
    // (push the "keeper is idle" affordance live) and Layer 3 `autoReDrive`
    // (re-drive automatically). Re-drive is additionally bounded by the retry cap
    // — each armed watch fires at most once, so gating on `retryCount >= maxRetries`
    // bounds total auto re-drives to exactly maxRetries (and `maxRetries: 0`
    // disables it). Surfacing has no such cap: a re-drive that hangs again is a new
    // event worth showing. If neither wants in, don't arm at all.
    const retryCount = this.guards.get(sessionId)?.retryCount ?? 0;
    const wantSurface = recovery.surfaceKilledTask;
    const wantReDrive = recovery.autoReDrive && retryCount < recovery.maxRetries;
    if (!wantSurface && !wantReDrive) {
      this.log("recovery: nothing to arm (surface off, re-drive off or capped)", {
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
    // Baseline = the transcript's current EOF via a cheap `stat` (NOT a full read):
    // this runs on EVERY session-mode turn once autoReDrive is on, and transcripts
    // here are multi-MB. Start the tail from EOF so we only ever see entries appended
    // AFTER this turn (the kill's notification), never a stale one from earlier.
    let offset = await this.fileSize(file);
    let carry = "";
    let pending = false;
    let pendingSummary: string | undefined;
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
        const { event, summary } = parseTailLine(line);
        if (event === "assistant") {
          pending = false;
          pendingSummary = undefined;
          notifiedAt = null;
        } else if (event === "terminated-notification" && !pending) {
          pending = true;
          pendingSummary = summary;
          notifiedAt = this.now();
        }
      }

      const t = this.now();
      if (pending && notifiedAt !== null && t - notifiedAt >= recovery.debounceMs) {
        // Hung: a terminated notification has sat un-answered for the full debounce.
        this.cancelWatch(sessionId);
        await this.fire(project, sessionId, recovery, pendingSummary);
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
   * A detected turn-boundary kill is ready to recover — kick off the fire, giving
   * it a bounded {@link settleWindowMs} budget to wait out any still-live session.
   * See {@link fireWhenIdle} for the surface/re-drive actions and the defer guard.
   */
  private async fire(
    project: Project,
    sessionId: string,
    recovery: RecoveryConfig,
    summary: string | undefined,
  ): Promise<void> {
    await this.fireWhenIdle(project, sessionId, recovery, summary, this.now() + this.settleWindowMs);
  }

  /**
   * Handle a detected turn-boundary kill. Two independent, resolved-config-gated
   * actions, in order:
   *   1. `surfaceKilledTask` — push the kill to attached clients LIVE so the
   *      "keeper is idle / Continue" affordance appears without a refresh. Never
   *      throws; a bad sink can't wedge the engine.
   *   2. `autoReDrive` (under the retry cap) — bump the session's retry bookkeeping
   *      FIRST (so a re-drive that itself hangs can't exceed the cap), then inject
   *      the recovery nudge via the shared Layer 2 path. A failed inject is logged.
   *
   * Liveness guard + defer (issues #352 / #397). Two busy signals mean the session
   * is NOT idle and firing would collide with a live `claude` subprocess:
   *   - {@link isBusy} (hub) — a live turn PADDOCK itself started (a human message,
   *     a queued-message drain, or a prior recovery nudge).
   *   - {@link sdkSessionLive} (reaper) — a subprocess herdctl is keeping alive for
   *     the just-killed background task, or holding through its ~15s re-invocation
   *     grace. `isBusy` is BLIND to this, which is what let the auto re-drive fire a
   *     COMPETING resume and get interrupted (`[Request interrupted by user]`, #397).
   *
   * When EITHER is set we must NOT fire — but standing down *permanently* leaves
   * recovery incomplete: the reaper reaps SILENTLY (no turn completes, so nothing
   * re-arms a watch), and the user stays stuck. So instead we DEFER: re-check after
   * {@link settlePollMs} and fire exactly once the session is genuinely idle
   * (reaper reaped, hub not running). The deferral is bounded by
   * {@link settleWindowMs} so a session that never releases can't retry forever, and
   * is tracked in {@link watches} so a completing turn ({@link armWatch}) or a human
   * message ({@link onHumanMessage}) supersedes/cancels it — no double fire.
   */
  private async fireWhenIdle(
    project: Project,
    sessionId: string,
    recovery: RecoveryConfig,
    summary: string | undefined,
    settleDeadline: number,
  ): Promise<void> {
    const hubBusy = this.isBusy(sessionId);
    const reaperLive = this.sdkSessionLive(sessionId);
    if (hubBusy || reaperLive) {
      if (this.now() >= settleDeadline) {
        // The session never went idle within the settle budget — give up rather
        // than defer forever. A later genuine hang re-arms a fresh watch.
        this.log("recovery: session still live at settle deadline — standing down", {
          slug: project.slug,
          sessionId,
          hubBusy,
          reaperLive,
        });
        return;
      }
      // Defer: re-check liveness after the settle poll. Register as a watch so a
      // fresh armWatch (a completing turn) or a human message cancels this retry.
      const watch: Watch = { timer: null, cancelled: false };
      this.watches.set(sessionId, watch);
      watch.timer = this.setTimer(() => {
        if (watch.cancelled) return;
        // Drop this settle-watch from the map before re-attempting; fireWhenIdle
        // re-registers a fresh one if it still needs to defer.
        this.cancelWatch(sessionId);
        void this.fireWhenIdle(project, sessionId, recovery, summary, settleDeadline).catch((err) => {
          this.log("recovery: deferred fire failed", { sessionId, err: String(err) });
        });
      }, this.settlePollMs);
      this.log("recovery: session still live (hub or reaper) — deferring nudge until idle", {
        slug: project.slug,
        sessionId,
        hubBusy,
        reaperLive,
      });
      return;
    }
    if (recovery.surfaceKilledTask) {
      try {
        this.surface(project, sessionId, summary);
        this.log("recovery: surfaced killed task", { slug: project.slug, sessionId });
      } catch (err) {
        this.log("recovery: surface failed", { sessionId, err: String(err) });
      }
    }

    const retryCount = this.guards.get(sessionId)?.retryCount ?? 0;
    if (!recovery.autoReDrive || retryCount >= recovery.maxRetries) return;

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
