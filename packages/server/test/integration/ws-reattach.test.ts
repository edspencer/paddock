/**
 * WS session re-attach + replay (issue #54). Proves a turn's stream is no longer
 * bound to the socket that started it: a DIFFERENT socket can `chat:subscribe` to
 * the session and be replayed the turn's frames — the mechanism that lets a
 * client whose socket dropped mid-turn reconnect and resume seamlessly instead
 * of stalling until a manual reload.
 *
 * Deterministic proxy for a mid-turn drop: a just-completed turn's buffer is
 * retained briefly, so we run a turn on socket A, then attach socket B and assert
 * it receives the replay (incl. the terminal chat:complete). The exact mid-turn
 * gap semantics are covered by session-hub.test.ts.
 *
 * Each test uses its OWN project so the post-turn curation sweep (which writes a
 * fresh transcript into the project's chat dir) can't race the next test's keeper
 * turn on a shared dir — the known cross-test sweep race noted in ws.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

describe("integration: WS session re-attach + replay (issue #54)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    // Large sweep interval so a prior turn's curation never fires during a test.
    t = await startTestApp({
      script: { "Hello there": "Hi! I am the fake keeper." },
      sweepIntervalMs: 600_000,
    });
    ({ port } = await listen(t.app));
  });
  afterAll(async () => {
    await t.teardown();
  });

  /** Create a fresh, uniquely-named project and return its slug. */
  async function freshProject(): Promise<string> {
    const name = `Reattach ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  /** Run one full turn on `ws` and return the session id + the frame seqs it saw. */
  async function runTurn(ws: WsClient, slug: string, sessionId: string | null, message: string) {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId, message } });
    const complete = await ws.waitFor(isComplete(slug), { from: mark });
    const seqs = ws.events
      .slice(mark)
      .filter((e) => e.type.startsWith("chat:") && typeof e.payload?.seq === "number")
      .map((e) => e.payload!.seq as number);
    return { sessionId: complete.payload!.sessionId as string, seqs };
  }

  it("stamps a monotonic seq on the turn's frames", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      const { seqs } = await runTurn(ws, slug, null, "Hello there");
      expect(seqs.length).toBeGreaterThan(0);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // strictly increasing
      expect(seqs[0]).toBe(0);
    } finally {
      ws.close();
    }
  });

  it("a second socket can re-attach to the session and be replayed the whole turn", async () => {
    const slug = await freshProject();
    const a = await connectWs(port);
    let b: WsClient | undefined;
    try {
      const { sessionId } = await runTurn(a, slug, null, "Hello there");

      // A fresh socket (as after a reconnect) attaches and asks to replay from the start.
      b = await connectWs(port);
      const mark = b.mark();
      b.send({
        type: "chat:subscribe",
        payload: { projectSlug: slug, sessionId, wantReplay: true, lastSeq: -1 },
      });

      const complete = await b.waitFor(
        (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
        { from: mark },
      );
      expect(complete.payload?.success).toBe(true);
      // The assistant text was replayed too, not just the terminal frame.
      expect(b.responseText(mark)).toContain("Hi! I am the fake keeper.");
    } finally {
      a.close();
      b?.close();
    }
  });

  it("replays ONLY the gap after the client's lastSeq (no duplicates)", async () => {
    const slug = await freshProject();
    const a = await connectWs(port);
    let b: WsClient | undefined;
    try {
      const { sessionId, seqs } = await runTurn(a, slug, null, "Hello there");
      const maxSeq = Math.max(...seqs);
      const lastApplied = maxSeq - 1; // pretend everything but the final frame was applied

      b = await connectWs(port);
      const mark = b.mark();
      b.send({
        type: "chat:subscribe",
        payload: { projectSlug: slug, sessionId, wantReplay: true, lastSeq: lastApplied },
      });
      await b.waitFor(
        (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
        { from: mark },
      );
      const replayedSeqs = b.events
        .slice(mark)
        .filter((e) => typeof e.payload?.seq === "number")
        .map((e) => e.payload!.seq as number);
      expect(replayedSeqs).toEqual([maxSeq]); // exactly the gap, nothing already-applied
    } finally {
      a.close();
      b?.close();
    }
  });

  it("a future-only attach (wantReplay:false) gets no replay and never errors", async () => {
    const slug = await freshProject();
    const a = await connectWs(port);
    let b: WsClient | undefined;
    try {
      const { sessionId } = await runTurn(a, slug, null, "Hello there");
      b = await connectWs(port);
      const mark = b.mark();
      b.send({
        type: "chat:subscribe",
        payload: { projectSlug: slug, sessionId, wantReplay: false, lastSeq: -1 },
      });
      b.send({ type: "ping" });
      const pong = await b.waitFor((e) => e.type === "pong", { from: mark });
      expect(pong.type).toBe("pong");
      const replayed = b.events.slice(mark).filter((e) => e.type.startsWith("chat:"));
      expect(replayed).toHaveLength(0);
    } finally {
      a.close();
      b?.close();
    }
  });

  it("rejects a chat:subscribe with no sessionId (Unknown message)", async () => {
    const ws = await connectWs(port);
    try {
      const mark = ws.mark();
      ws.send({ type: "chat:subscribe", payload: { projectSlug: "whatever" } });
      const err = await ws.waitFor((e) => e.type === "chat:error", { from: mark });
      expect(err.payload?.error).toBe("Unknown message");
    } finally {
      ws.close();
    }
  });
});
