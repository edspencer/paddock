/**
 * Unit tests for the Layer 3 keeper-chat recovery ENGINE (issue #301).
 *
 * Two halves:
 *  - The PURE hang-detection primitives (`classifyLine` / `detectHang`) — the
 *    transcript-tail logic that decides whether a keeper is hung, pinned exactly.
 *  - The `RecoveryEngine` orchestration, driven through an injected fake clock +
 *    scheduler + in-memory transcript so the debounce window, the retry cap, the
 *    "keeper woke itself" cancel, the autoReDrive gate and the human-message reset
 *    are all deterministic — no real timers, no real filesystem.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  classifyLine,
  detectHang,
  RecoveryEngine,
  type TranscriptTail,
  type TimerHandle,
} from "../../src/recovery.js";
import { DEFAULT_RECOVERY, type RecoveryConfig, type RecoveryOverride } from "../../src/recovery-config.js";
import type { Project } from "../../src/projects.js";

// --- transcript line builders (match the real .chats JSONL shapes) -----------

const assistantLine = (text = "working") =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: text } });
const notifLine = (status: string) =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: `<task-notification>\n<task-id>t1</task-id>\n<status>${status}</status>\n<summary>bg</summary>\n</task-notification>`,
    },
  });
const userLine = (text = "hello") =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });
const otherLine = () => JSON.stringify({ type: "system", subtype: "init" });

// ---------------------------------------------------------------------------
// Pure primitives
// ---------------------------------------------------------------------------

describe("classifyLine (#301)", () => {
  it("classifies an assistant turn", () => {
    expect(classifyLine(assistantLine())).toBe("assistant");
  });
  it.each(["killed", "stopped", "KILLED", "Stopped"])(
    "classifies a %s task-notification as terminated",
    (s) => {
      expect(classifyLine(notifLine(s))).toBe("terminated-notification");
    },
  );
  it.each(["completed", "running", "timed out"])(
    "classifies a %s task-notification as other (not terminated)",
    (s) => {
      expect(classifyLine(notifLine(s))).toBe("other");
    },
  );
  it("classifies a plain user message as other", () => {
    expect(classifyLine(userLine())).toBe("other");
  });
  it("classifies a system/attachment/blank/garbage line as other", () => {
    expect(classifyLine(otherLine())).toBe("other");
    expect(classifyLine("")).toBe("other");
    expect(classifyLine("   ")).toBe("other");
    expect(classifyLine("{not json")).toBe("other");
  });
  it("handles array content (text blocks) in a notification", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "<task-notification>\n<status>killed</status>\n</task-notification>" }],
      },
    });
    expect(classifyLine(line)).toBe("terminated-notification");
  });
});

describe("detectHang (#301)", () => {
  it("is false for an empty stream", () => {
    expect(detectHang([])).toBe(false);
  });
  it("is false when the turn ends in assistant activity", () => {
    expect(detectHang(["assistant", "other", "assistant"])).toBe(false);
  });
  it("is true when a terminated notification is the last meaningful event", () => {
    expect(detectHang(["assistant", "terminated-notification"])).toBe(true);
  });
  it("stays true across trailing other lines (system/attachment after the notif)", () => {
    expect(detectHang(["assistant", "terminated-notification", "other", "other"])).toBe(true);
  });
  it("is false when the keeper woke after the notification (assistant follows)", () => {
    expect(detectHang(["terminated-notification", "assistant"])).toBe(false);
  });
  it("re-arms on a second notification after a recovery reply", () => {
    // notif → assistant (recovered) → notif again (re-hung)
    expect(detectHang(["terminated-notification", "assistant", "terminated-notification"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine orchestration — fake clock + scheduler + in-memory transcript
// ---------------------------------------------------------------------------

/** A deterministic timer scheduler over a virtual clock. */
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

  /** Advance the virtual clock, firing due timers in order and draining microtasks. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    // Loop because a fired async tick schedules the next timer as it runs.
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

/** Flush enough microtask turns for an async tick body (readTail + reDrive awaits). */
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** A mutable in-memory transcript the test grows to simulate the runtime appending. */
class FakeTranscript {
  content = "";
  append(...lines: string[]): void {
    this.content += lines.map((l) => l + "\n").join("");
  }
  readTail = async (_file: string, offset: number): Promise<TranscriptTail> => {
    const buf = Buffer.from(this.content, "utf8");
    const size = buf.length;
    return { text: offset >= size ? "" : buf.subarray(offset).toString("utf8"), size };
  };
}

function makeProject(recovery?: RecoveryOverride): Project {
  return {
    name: "Rec",
    slug: "rec",
    dir: "/tmp/rec",
    workingDir: "/tmp/rec",
    model: "claude-opus-4-8",
    ...(recovery ? { recovery } : {}),
  } as unknown as Project;
}

interface Harness {
  engine: RecoveryEngine;
  sched: FakeScheduler;
  tx: FakeTranscript;
  reDrive: ReturnType<typeof vi.fn>;
  getProject: ReturnType<typeof vi.fn>;
}

function makeEngine(opts: {
  instance?: Partial<RecoveryConfig>;
  override?: RecoveryOverride;
  debounceMs?: number;
}): Harness {
  const sched = new FakeScheduler();
  const tx = new FakeTranscript();
  const instance: RecoveryConfig = {
    ...DEFAULT_RECOVERY,
    autoReDrive: true,
    debounceMs: opts.debounceMs ?? 100,
    maxRetries: 1,
    ...opts.instance,
  };
  const reDrive = vi.fn(async () => undefined);
  const getProject = vi.fn(async () => makeProject(opts.override));
  const engine = new RecoveryEngine({
    cfg: { recovery: instance },
    getProject,
    reDrive,
    now: sched.now,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    readTail: tx.readTail,
    pollMs: 10,
    killGraceMs: 200,
  });
  return { engine, sched, tx, reDrive, getProject };
}

describe("RecoveryEngine.armWatch (#301)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeEngine({ debounceMs: 100 });
  });

  it("auto re-drives a hung keeper once the killed notification sits past the debounce", async () => {
    // Seed a completed turn, arm the watch, then the runtime appends the killed notif.
    h.tx.append(userLine("go"), assistantLine("started a bg task"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    expect(h.engine.isWatching("s1")).toBe(true);

    // The kill lands after the turn (the ~2s-later teardown).
    h.tx.append(notifLine("killed"));
    // Not yet — debounce hasn't elapsed.
    await h.sched.advance(50);
    expect(h.reDrive).not.toHaveBeenCalled();

    // Past the debounce with no keeper reply → fire exactly one re-drive.
    await h.sched.advance(100);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.reDrive).toHaveBeenCalledWith(expect.objectContaining({ slug: "rec" }), "s1");
    expect(h.engine.retryCountFor("s1")).toBe(1);
    expect(h.engine.isWatching("s1")).toBe(false);
  });

  it("does NOT poke a keeper that wakes itself inside the debounce window", async () => {
    h.tx.append(assistantLine("done"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();

    h.tx.append(notifLine("killed"));
    await h.sched.advance(50); // within debounce
    // Keeper wakes on its own (a completed sibling task, or it just continues).
    h.tx.append(assistantLine("picking back up"));
    await h.sched.advance(300); // well past debounce + grace
    expect(h.reDrive).not.toHaveBeenCalled();
    expect(h.engine.isWatching("s1")).toBe(false); // watch expired cleanly
  });

  it("never fires for a clean turn with no killed notification", async () => {
    h.tx.append(assistantLine("all done, nothing backgrounded"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    await h.sched.advance(400); // past deadline
    expect(h.reDrive).not.toHaveBeenCalled();
    expect(h.engine.isWatching("s1")).toBe(false);
  });

  it("does not fire on a COMPLETED background task (only killed/stopped)", async () => {
    h.tx.append(assistantLine("started"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    h.tx.append(notifLine("completed"));
    await h.sched.advance(400);
    expect(h.reDrive).not.toHaveBeenCalled();
  });

  it("stops poking after the retry cap (a permanently-wedged keeper)", async () => {
    // First hang → one re-drive.
    h.tx.append(assistantLine("started"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    h.tx.append(notifLine("killed"));
    await h.sched.advance(150);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.engine.retryCountFor("s1")).toBe(1);

    // The re-drive turn also hangs; ws.ts re-arms on its completion. maxRetries=1 is
    // already reached, so arming is a no-op and no second poke fires.
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    expect(h.engine.isWatching("s1")).toBe(false);
    h.tx.append(notifLine("killed"));
    await h.sched.advance(400);
    expect(h.reDrive).toHaveBeenCalledTimes(1); // still just the one
  });

  it("honours a higher retry cap (fires up to maxRetries times)", async () => {
    const hh = makeEngine({ instance: { maxRetries: 2 }, debounceMs: 100 });
    hh.tx.append(assistantLine("started"));
    hh.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    hh.tx.append(notifLine("killed"));
    await hh.sched.advance(150);
    expect(hh.reDrive).toHaveBeenCalledTimes(1);

    hh.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    hh.tx.append(notifLine("killed"));
    await hh.sched.advance(150);
    expect(hh.reDrive).toHaveBeenCalledTimes(2);
    expect(hh.engine.retryCountFor("s1")).toBe(2);

    // Third arm is capped.
    hh.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    expect(hh.engine.isWatching("s1")).toBe(false);
  });

  it("maxRetries: 0 disables auto-recovery entirely (never arms, even for a fresh session)", async () => {
    const capped = makeEngine({ instance: { maxRetries: 0 } });
    capped.tx.append(assistantLine("started"));
    capped.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    // The cap gates arming — a fresh session with a 0 cap is never watched.
    expect(capped.engine.isWatching("s1")).toBe(false);
    capped.tx.append(notifLine("killed"));
    await capped.sched.advance(400);
    expect(capped.reDrive).not.toHaveBeenCalled();
  });

  it("does nothing when autoReDrive is OFF (Layer 3 opt-in)", async () => {
    const off = makeEngine({ instance: { autoReDrive: false } });
    off.tx.append(assistantLine("started"));
    off.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    expect(off.engine.isWatching("s1")).toBe(false);
    off.tx.append(notifLine("killed"));
    await off.sched.advance(400);
    expect(off.reDrive).not.toHaveBeenCalled();
  });

  it("lets a per-project override turn autoReDrive ON over an OFF instance default", async () => {
    const on = makeEngine({ instance: { autoReDrive: false }, override: { autoReDrive: true }, debounceMs: 100 });
    on.tx.append(assistantLine("started"));
    on.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    on.tx.append(notifLine("killed"));
    await on.sched.advance(150);
    expect(on.reDrive).toHaveBeenCalledTimes(1);
  });

  it("a human message clears the guard so a later hang re-arms fresh", async () => {
    h.tx.append(assistantLine("started"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    h.tx.append(notifLine("killed"));
    await h.sched.advance(150);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
    expect(h.engine.retryCountFor("s1")).toBe(1);

    // Human sends a message — reset the retry bookkeeping.
    h.engine.onHumanMessage("s1");
    expect(h.engine.retryCountFor("s1")).toBe(0);

    // A genuinely new later hang is recovered again.
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    h.tx.append(notifLine("killed"));
    await h.sched.advance(150);
    expect(h.reDrive).toHaveBeenCalledTimes(2);
  });

  it("onHumanMessage cancels an in-flight watch", async () => {
    h.tx.append(assistantLine("started"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    expect(h.engine.isWatching("s1")).toBe(true);
    h.engine.onHumanMessage("s1");
    expect(h.engine.isWatching("s1")).toBe(false);
    // A killed notif now goes unwatched (the human is back in the loop).
    h.tx.append(notifLine("killed"));
    await h.sched.advance(400);
    expect(h.reDrive).not.toHaveBeenCalled();
  });

  it("re-arming supersedes a prior watch (no double fire for one hang)", async () => {
    h.tx.append(assistantLine("started"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    // Re-arm before any kill (e.g. a spurious second completion) — only one watch lives.
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    await drain();
    expect(h.engine.isWatching("s1")).toBe(true);
    h.tx.append(notifLine("killed"));
    await h.sched.advance(150);
    expect(h.reDrive).toHaveBeenCalledTimes(1);
  });

  it("swallows an unknown/deleted project (getProject throws) without firing", async () => {
    h.getProject.mockRejectedValueOnce(new Error("no such project"));
    h.engine.armWatch({ slug: "gone", sessionId: "s1" });
    await drain();
    expect(h.engine.isWatching("s1")).toBe(false);
    expect(h.reDrive).not.toHaveBeenCalled();
  });

  it("stopAll cancels every live watch", async () => {
    h.tx.append(assistantLine("a"));
    h.engine.armWatch({ slug: "rec", sessionId: "s1" });
    h.engine.armWatch({ slug: "rec", sessionId: "s2" });
    await drain();
    expect(h.engine.isWatching("s1")).toBe(true);
    expect(h.engine.isWatching("s2")).toBe(true);
    h.engine.stopAll();
    expect(h.engine.isWatching("s1")).toBe(false);
    expect(h.engine.isWatching("s2")).toBe(false);
  });
});
