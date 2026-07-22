/**
 * Regression oracle for issue #397 — the auto-recovery self-interrupt.
 *
 * ── The bug (ground truth: paddock chat 164c7f89… @ 2026-07-22T21:24) ──────────
 * With Layer-3 auto re-drive ON, a keeper backgrounds a task, ends its turn, the
 * runtime kills the task ~8s later, the engine detects the `killed`
 * <task-notification> and auto-fires the recovery nudge — but the auto-recovery
 * turn is INTERRUPTED (`[Request interrupted by user]`) ~2s in and produces zero
 * output. A human "Continue" ~90s later works only because the session is finally
 * idle.
 *
 * ── Root cause ────────────────────────────────────────────────────────────────
 * When a turn ends with a still-running background task, herdctl's SessionReaper
 * KEEPS the SDK subprocess alive (keepAlive), and after the task set drains it
 * holds the session open for a further ~15s re-invocation grace window. During
 * that whole stretch `reaper.isSessionLive` is TRUE. Meanwhile Paddock drives
 * every session-mode turn — including the recovery re-drive — as a FRESH
 * `openChatSession(resume)` = a NEW `claude` subprocess resuming the same session
 * id. So the re-drive spins up a SECOND process resuming a session the reaper
 * still holds live → two `claude` processes on one session id → the SDK resolves
 * the collision by interrupting the in-flight turn.
 *
 * The #352 double-dispatch guard checks `isBusy = hub.isRunning`, which only sees
 * turns PADDOCK itself started. The reaper-kept-alive subprocess is invisible to
 * Paddock's hub, so `isBusy` returns FALSE and the guard waves the re-drive
 * through. That blind spot is the defect.
 *
 * ── The fix (this PR) ─────────────────────────────────────────────────────────
 *   1. Thread the reaper's true liveness into the fire guard as `sdkSessionLive`
 *      (wired in prod to `getSessionLifecycle()?.reaper.isSessionLive`). Fire only
 *      when NEITHER the hub nor the reaper is live.
 *   2. DEFER rather than stand down permanently: the reaper reaps silently (no
 *      turn completes, so nothing re-arms a watch), so a permanent stand-down
 *      leaves the user stuck. Instead re-check on a settle poll and fire exactly
 *      once the session is genuinely idle — bounded by a settle window so a
 *      session that never releases can't retry forever.
 *
 * These tests drive the REAL RecoveryEngine and replay the REAL transcript kill
 * signature (a `queue-operation` enqueue of a `killed` notification), modelling
 * the box: `isBusy` (hub) === false while the herdctl session is genuinely live.
 */
import { describe, it, expect, vi } from "vitest";
import { RecoveryEngine, type TranscriptTail, type TimerHandle } from "../../src/recovery.js";
import { DEFAULT_RECOVERY, type RecoveryConfig } from "../../src/recovery-config.js";
import type { Project } from "../../src/projects.js";

// --- deterministic virtual-clock scheduler (same pattern as recovery.test.ts) --
class FakeScheduler {
  time = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  now = (): number => this.time;
  setTimer = (fn: () => void, ms: number): TimerHandle => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + ms, fn });
    return id as unknown as TimerHandle;
  };
  clearTimer = (h: TimerHandle): void => {
    this.timers = this.timers.filter((t) => (t.id as unknown as TimerHandle) !== h);
  };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const next = due[0];
      this.timers = this.timers.filter((t) => t.id !== next.id);
      this.time = next.at;
      next.fn();
      await drain();
    }
    this.time = target;
  }
}
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

class FakeTranscript {
  content = "";
  append(...lines: string[]): void {
    this.content += lines.map((l) => l + "\n").join("");
  }
  readTail = async (_f: string, offset: number): Promise<TranscriptTail> => {
    const buf = Buffer.from(this.content, "utf8");
    return { text: offset >= buf.length ? "" : buf.subarray(offset).toString("utf8"), size: buf.length };
  };
  fileSize = async (): Promise<number> => Buffer.byteLength(this.content, "utf8");
}

const assistantLine = (t = "started a bg task") =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: t } });
/** The exact production kill signature: a queue-operation enqueue of a killed notif. */
const queueOpKill = () =>
  JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content:
      "<task-notification>\n<task-id>bsg1lnwol</task-id>\n<status>killed</status>\n<summary>CI wait</summary>\n</task-notification>",
  });

const makeProject = (): Project =>
  ({ name: "Rec", slug: "rec", dir: "/tmp/rec", workingDir: "/tmp/rec", model: "claude-opus-4-8" } as unknown as Project);

/**
 * Build an engine modelling the real box at fire time.
 *  - `hubRunning()` — hub.isRunning (what the #352 guard checks).
 *  - `reaperLive()` — reaper.isSessionLive (the TRUE liveness #397 threads in).
 * `wireReaperProbe: false` models the SHIPPED (pre-fix) engine, where the reaper's
 * liveness is unobservable — exactly what Test A demonstrates.
 */
function makeEngine(opts: {
  hubRunning?: () => boolean;
  reaperLive?: () => boolean;
  wireReaperProbe?: boolean;
}) {
  const sched = new FakeScheduler();
  const tx = new FakeTranscript();
  const resolved: RecoveryConfig = {
    ...DEFAULT_RECOVERY,
    autoReDrive: true,
    surfaceKilledTask: true,
    debounceMs: 100,
    maxRetries: 1,
  };
  const reDrive = vi.fn(async () => undefined);
  const surface = vi.fn();
  const isBusy = vi.fn((_s: string) => opts.hubRunning?.() ?? false);
  const sdkSessionLive = vi.fn((_s: string) => opts.reaperLive?.() ?? false);
  const engine = new RecoveryEngine({
    cfg: { recovery: resolved },
    getProject: vi.fn(async () => makeProject()),
    reDrive,
    surface,
    isBusy,
    ...(opts.wireReaperProbe ? { sdkSessionLive } : {}),
    now: sched.now,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    readTail: tx.readTail,
    fileSize: tx.fileSize,
    pollMs: 10,
    killGraceMs: 200,
    settlePollMs: 50,
    settleWindowMs: 2000,
  } as never);
  return { engine, sched, tx, reDrive, surface, isBusy, sdkSessionLive };
}

/** Arm the watch and land the real kill signature; caller advances the clock. */
async function armAndKill(h: ReturnType<typeof makeEngine>): Promise<void> {
  h.tx.append(assistantLine());
  h.engine.armWatch({ slug: "rec", sessionId: "164c7f89" });
  await drain();
  h.tx.append(queueOpKill());
}

describe("#397: auto-recovery must not fire a competing resume into a reaper-live session", () => {
  it("A) documents the bug: without the reaper probe wired, an idle hub fires despite a reaper-live session", async () => {
    // The SHIPPED engine only sees the hub. The reaper is holding the SDK
    // subprocess alive (reaperLive=true) but that is unobservable to the guard,
    // so it fires — the competing resume the SDK then interrupts.
    const h = makeEngine({ hubRunning: () => false, reaperLive: () => true, wireReaperProbe: false });
    await armAndKill(h);
    await h.sched.advance(200);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.isBusy).toHaveBeenCalled();
  });

  it("B) with the reaper probe wired, a still-live session does NOT fire (no competing resume, no interrupt)", async () => {
    // Reaper stays live for the whole (short) window: the engine must defer, not
    // fire — no re-drive, no surface, no retry burned.
    const h = makeEngine({ hubRunning: () => false, reaperLive: () => true, wireReaperProbe: true });
    await armAndKill(h);
    await h.sched.advance(400);
    expect(h.sdkSessionLive).toHaveBeenCalledWith("164c7f89");
    expect(h.reDrive).not.toHaveBeenCalled();
    expect(h.surface).not.toHaveBeenCalled();
    expect(h.engine.retryCountFor("164c7f89")).toBe(0);
  });

  it("C) a genuinely-idle hang (hub + reaper both idle) still recovers immediately", async () => {
    const h = makeEngine({ hubRunning: () => false, reaperLive: () => false, wireReaperProbe: true });
    await armAndKill(h);
    await h.sched.advance(200);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.surface).toHaveBeenCalledTimes(1);
    expect(h.engine.retryCountFor("164c7f89")).toBe(1);
  });

  it("D) DEFER-AND-RETRY: once the reaper reaps, the deferred nudge fires exactly once", async () => {
    // The heart of #397's fix. Reaper live at detection → defer. When the reaper
    // reaps (isSessionLive→false) the deferred nudge fires cleanly — exactly once,
    // and never a second time even as the clock runs well past.
    let reaperLive = true;
    const h = makeEngine({ hubRunning: () => false, reaperLive: () => reaperLive, wireReaperProbe: true });
    await armAndKill(h);

    // Detection fires, but the reaper is still holding the session live → deferred.
    await h.sched.advance(300);
    expect(h.reDrive).not.toHaveBeenCalled();
    expect(h.surface).not.toHaveBeenCalled();
    expect(h.engine.isWatching("164c7f89")).toBe(true); // a settle retry is armed

    // The reaper finally reaps the killed-task subprocess — the session is now idle.
    reaperLive = false;
    await h.sched.advance(100); // next settle poll (~50ms cadence) lands the nudge
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.surface).toHaveBeenCalledTimes(1);
    expect(h.engine.retryCountFor("164c7f89")).toBe(1);

    // No double-fire as time marches on, and the settle watch is cleaned up.
    await h.sched.advance(2000);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.engine.isWatching("164c7f89")).toBe(false);
  });

  it("D2) defers through a live HUB turn too, then fires once it completes", async () => {
    // Same defer path via the #352 hub signal: a live turn (human/queue/prior
    // nudge) blocks the fire; once it completes the deferred nudge lands once.
    let hubRunning = true;
    const h = makeEngine({ hubRunning: () => hubRunning, reaperLive: () => false, wireReaperProbe: true });
    await armAndKill(h);
    await h.sched.advance(300);
    expect(h.reDrive).not.toHaveBeenCalled();

    hubRunning = false;
    await h.sched.advance(100);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.engine.retryCountFor("164c7f89")).toBe(1);
  });

  it("E) BOUNDED: a session the reaper never releases stands down at the settle deadline (no forever-loop)", async () => {
    const h = makeEngine({ hubRunning: () => false, reaperLive: () => true, wireReaperProbe: true });
    await armAndKill(h);
    // Advance well past the 2000ms settle window: it must give up, never fire.
    await h.sched.advance(3000);
    expect(h.reDrive).not.toHaveBeenCalled();
    expect(h.surface).not.toHaveBeenCalled();
    expect(h.engine.retryCountFor("164c7f89")).toBe(0);
    expect(h.engine.isWatching("164c7f89")).toBe(false); // no lingering retry timer
  });

  it("F) a human message during the defer cancels the pending retry (no late nudge)", async () => {
    let reaperLive = true;
    const h = makeEngine({ hubRunning: () => false, reaperLive: () => reaperLive, wireReaperProbe: true });
    await armAndKill(h);
    await h.sched.advance(300);
    expect(h.engine.isWatching("164c7f89")).toBe(true);

    // The human steps in themselves — the deferred auto-nudge must NOT also fire.
    h.engine.onHumanMessage("164c7f89");
    expect(h.engine.isWatching("164c7f89")).toBe(false);
    reaperLive = false;
    await h.sched.advance(2000);
    expect(h.reDrive).not.toHaveBeenCalled();
  });
});
