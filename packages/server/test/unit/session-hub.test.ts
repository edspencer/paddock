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
});
