/**
 * SessionHub unit coverage (issue #54) — the session-scoped fan-out + re-attach
 * primitive, exercised without a real WebSocket via a tiny fake socket.
 */
import { describe, it, expect, vi } from "vitest";
import { SessionHub, COMPLETED_TTL_MS, type HubSocket } from "../../src/session-hub.js";

/** A minimal in-memory HubSocket that records the frames written to it. */
class FakeSocket implements HubSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  kill(): void {
    this.readyState = 3; // CLOSED
  }
  types(): string[] {
    return this.sent.map((m) => m.type);
  }
  seqs(): number[] {
    return this.sent.map((m) => m.payload.seq as number);
  }
}

const frame = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  payload: { projectSlug: "p", sessionId: "s1", jobId: "j1", ...extra },
});

describe("SessionHub", () => {
  it("stamps a per-turn monotonic seq on every emitted frame", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const turn = hub.startTurn("p", origin, "s1");
    turn.emit(frame("chat:response", { chunk: "a" }));
    turn.emit(frame("chat:response", { chunk: "b" }));
    turn.emit(frame("chat:message_boundary"));
    expect(origin.seqs()).toEqual([0, 1, 2]);
    expect(origin.sent[0].payload.chunk).toBe("a");
  });

  it("fans a turn's frames out to origin + every subscribed socket, skipping dead ones", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const other = new FakeSocket();
    const dead = new FakeSocket();
    const turn = hub.startTurn("p", origin, "s1");
    hub.subscribe("s1", other);
    hub.subscribe("s1", dead);
    dead.kill();

    turn.emit(frame("chat:response", { chunk: "hi" }));

    expect(origin.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(1);
    expect(other.sent[0].payload.chunk).toBe("hi");
    expect(dead.sent).toHaveLength(0); // not OPEN → skipped, not queued forever
  });

  it("supports a client-less turn (null origin) without throwing, and fans out to a late subscriber (Paddock#111)", () => {
    const hub = new SessionHub();
    // A scheduler-fired wake starts a turn with NO origin socket.
    const turn = hub.startTurn("p", null, "s1");
    // Emitting must not throw despite the absent origin (frames are still buffered).
    expect(() => turn.emit(frame("chat:response", { chunk: "woke" }))).not.toThrow();
    // A client that attaches mid-turn still receives subsequent frames.
    const late = new FakeSocket();
    hub.subscribe("s1", late);
    turn.emit(frame("chat:response", { chunk: "more" }));
    expect(late.sent.map((m) => m.payload.chunk)).toEqual(["more"]);
    turn.end();
  });

  it("re-broadcasts active state with the jobId the instant setJobId runs, arming Stop before any content frame (Paddock#111)", () => {
    const hub = new SessionHub();
    const seen: Array<{ running: boolean; jobId: string | null }> = [];
    hub.onActive = (info) => seen.push({ running: info.running, jobId: info.jobId });
    // A resumed chat: session id known at startTurn → an initial active fires
    // with jobId still null (the job isn't created yet).
    const turn = hub.startTurn("p", new FakeSocket(), "s1");
    expect(seen).toEqual([{ running: true, jobId: null }]);
    // The moment the job id resolves, a fresh active frame carries it — so the
    // client can arm Stop without waiting for the first content frame.
    turn.setJobId("job-42");
    expect(seen[seen.length - 1]).toEqual({ running: true, jobId: "job-42" });
  });

  it("re-attaches a reconnected socket and replays exactly the missed gap", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const turn = hub.startTurn("p", origin, "s1");
    turn.emit(frame("chat:response", { chunk: "0" })); // seq 0
    turn.emit(frame("chat:response", { chunk: "1" })); // seq 1
    turn.emit(frame("chat:response", { chunk: "2" })); // seq 2

    // A client that applied through seq 1 reconnects on a new socket.
    const reconnected = new FakeSocket();
    const res = hub.attach("s1", reconnected, { wantReplay: true, afterSeq: 1 });
    expect(res).toEqual({ status: "replayed", frames: 1 });
    expect(reconnected.seqs()).toEqual([2]); // only the gap, no duplicates

    // And future frames now fan out to the reconnected socket too.
    turn.emit(frame("chat:response", { chunk: "3" }));
    expect(reconnected.seqs()).toEqual([2, 3]);
  });

  it("a fresh attach (wantReplay:false) gets no replay but does receive future frames", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const turn = hub.startTurn("p", origin, "s1");
    turn.emit(frame("chat:response", { chunk: "0" }));

    const fresh = new FakeSocket();
    const res = hub.attach("s1", fresh, { wantReplay: false, afterSeq: -1 });
    expect(res).toEqual({ status: "none" });
    expect(fresh.sent).toHaveLength(0); // no replay → no duplication with transcript hydration

    turn.emit(frame("chat:response", { chunk: "1" }));
    expect(fresh.seqs()).toEqual([1]);
  });

  it("attach to a session with no active turn is a no-op (status none)", () => {
    const hub = new SessionHub();
    const s = new FakeSocket();
    expect(hub.attach("nope", s, { wantReplay: true, afterSeq: -1 })).toEqual({ status: "none" });
  });

  it("retains a just-completed turn's buffer so an end-of-turn reconnect gets the tail", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const turn = hub.startTurn("p", origin, "s1");
    turn.emit(frame("chat:response", { chunk: "x" }));
    turn.emit(frame("chat:complete", { success: true }));
    turn.end();

    // Reconnect having applied nothing → replays the whole (completed) turn incl. complete.
    const late = new FakeSocket();
    const res = hub.attach("s1", late, { wantReplay: true, afterSeq: -1 });
    expect(res).toEqual({ status: "replayed", frames: 2 });
    expect(late.types()).toEqual(["chat:response", "chat:complete"]);
  });

  it("evicts a completed turn after the retention TTL", () => {
    vi.useFakeTimers();
    try {
      const hub = new SessionHub();
      const turn = hub.startTurn("p", new FakeSocket(), "s1");
      turn.emit(frame("chat:complete", { success: true }));
      turn.end();
      expect(hub.isRunning("s1")).toBe(false);
      vi.advanceTimersByTime(COMPLETED_TTL_MS + 1);
      const s = new FakeSocket();
      expect(hub.attach("s1", s, { wantReplay: true, afterSeq: -1 })).toEqual({ status: "none" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the client to resync when the requested gap has been trimmed", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const turn = hub.startTurn("p", origin, "s1");
    // Overflow the bounded buffer so the earliest frames are dropped.
    for (let i = 0; i < 4100; i++) turn.emit(frame("chat:response", { chunk: String(i) }));

    const s = new FakeSocket();
    const res = hub.attach("s1", s, { wantReplay: true, afterSeq: -1 });
    expect(res).toEqual({ status: "resync", projectSlug: "p" });
    expect(s.sent).toHaveLength(0);
  });

  it("registers a resumed turn immediately, evicting a prior retained turn for the session", () => {
    const hub = new SessionHub();
    const t1 = hub.startTurn("p", new FakeSocket(), "s1");
    t1.emit(frame("chat:complete", { success: true }));
    t1.end(); // retained

    // A new turn on the same (resumed) session registers at once and supersedes it.
    const t2origin = new FakeSocket();
    const t2 = hub.startTurn("p", t2origin, "s1");
    t2.emit(frame("chat:response", { chunk: "new" })); // seq 0 of the new turn

    const s = new FakeSocket();
    const res = hub.attach("s1", s, { wantReplay: true, afterSeq: -1 });
    expect(res).toEqual({ status: "replayed", frames: 1 });
    expect(s.sent[0].payload.chunk).toBe("new"); // the NEW turn, not the retained one
  });

  it("unsubscribeSocket stops future fan-out to that socket", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const other = new FakeSocket();
    const turn = hub.startTurn("p", origin, "s1");
    hub.subscribe("s1", other);
    turn.emit(frame("chat:response", { chunk: "0" }));
    expect(other.sent).toHaveLength(1);

    hub.unsubscribeSocket(other);
    turn.emit(frame("chat:response", { chunk: "1" }));
    expect(other.sent).toHaveLength(1); // no new frame
    expect(origin.sent).toHaveLength(2);
  });

  it("tracks running state and clears it on end", () => {
    const hub = new SessionHub();
    const turn = hub.startTurn("p", new FakeSocket(), "s1");
    expect(hub.isRunning("s1")).toBe(true);
    turn.end();
    expect(hub.isRunning("s1")).toBe(false);
  });

  // --- active-turn signal (issues #52/#53) --------------------------------

  it("fires onActive(true) when the session id is known and onActive(false) on end", () => {
    const hub = new SessionHub();
    const events: Array<[string, boolean, string | null]> = [];
    hub.onActive = (info) => events.push([info.sessionId, info.running, info.jobId]);

    const turn = hub.startTurn("p", new FakeSocket(), "s1"); // registered → active true (jobId not yet known)
    turn.setJobId("j1"); // → active true again, now carrying the jobId (arms Stop early, Paddock#111)
    turn.end(); // → active false

    expect(events).toEqual([
      ["s1", true, null],
      ["s1", true, "j1"],
      ["s1", false, "j1"],
    ]);
  });

  it("defers onActive(true) for a new chat until its session id arrives", () => {
    const hub = new SessionHub();
    const running: boolean[] = [];
    hub.onActive = (info) => running.push(info.running);

    const turn = hub.startTurn("p", new FakeSocket()); // no session yet → no signal
    expect(running).toEqual([]);
    turn.setSession("s9"); // now visible as running
    expect(running).toEqual([true]);
  });

  it("exposes activeInfo + runningSessions while running, cleared on end", () => {
    const hub = new SessionHub();
    const turn = hub.startTurn("p", new FakeSocket(), "s1");
    turn.setJobId("j1");
    expect(hub.activeInfo("s1")).toEqual({
      sessionId: "s1",
      projectSlug: "p",
      jobId: "j1",
      running: true,
    });
    expect(hub.runningSessions().map((r) => r.sessionId)).toEqual(["s1"]);

    turn.end();
    expect(hub.activeInfo("s1")).toBeNull();
    expect(hub.runningSessions()).toEqual([]);
  });

  it("broadcast() sends a one-off frame to origin + subscribers, skipping dead (#245)", () => {
    const hub = new SessionHub();
    const origin = new FakeSocket();
    const reconnected = new FakeSocket();
    const dead = new FakeSocket();
    hub.startTurn("p", origin, "s1"); // registers origin under s1
    hub.subscribe("s1", reconnected);
    hub.subscribe("s1", dead);
    dead.kill();

    hub.broadcast("s1", {
      type: "chat:queued_flushed",
      payload: { projectSlug: "p", sessionId: "s1", text: "hi" },
    });

    expect(origin.types()).toEqual(["chat:queued_flushed"]);
    expect(reconnected.types()).toEqual(["chat:queued_flushed"]);
    expect(reconnected.sent[0].payload.text).toBe("hi");
    expect(dead.sent).toHaveLength(0);
  });

  it("broadcast() reaches a socket that reconnected after the origin died (#245)", () => {
    // The reported bug's shape: the origin socket is gone; a new socket attached.
    const hub = new SessionHub();
    const origin = new FakeSocket();
    hub.startTurn("p", origin, "s1");
    origin.kill();
    const reconnected = new FakeSocket();
    hub.subscribe("s1", reconnected);

    hub.broadcast("s1", {
      type: "chat:queued_flushed",
      payload: { projectSlug: "p", sessionId: "s1" },
    });

    expect(origin.sent).toHaveLength(0); // dead
    expect(reconnected.types()).toEqual(["chat:queued_flushed"]); // still reached
  });
});
