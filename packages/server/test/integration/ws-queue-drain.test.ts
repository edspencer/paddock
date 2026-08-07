/**
 * Server-authoritative queued-message auto-send (#245). The server — not the
 * client — drains a persisted queued message and sends it as the next turn,
 * both (a) when a turn completes and (b) immediately when a queue is set for an
 * IDLE session (a queue delivered late, e.g. over the reconnect outbox, after the
 * turn it was meant to follow already ended — the reported stranding bug). Runs
 * through the REAL app + fake claude on a single socket.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import type { RuntimeSession } from "@herdctl/core";

const SLUG = "queue-proj";
const isComplete = (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === SLUG && typeof e.payload?.sessionId === "string";
const isFlushed = (e: WsEvent) => e.type === "chat:queued_flushed" && e.payload?.projectSlug === SLUG;

describe("integration: server-authoritative queued-message drain (#245)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp({
      script: {
        "start turn": "First reply.",
        "drain me": "Handled the queued follow-up.",
        "sentinel": "Sentinel reply.",
        "slow turn": "Slow reply.",
        "after slow": "Handled the after-slow queue.",
        "from the fast clock": "Handled the skewed queue.",
        "must not vanish": "Handled the correctly-clocked queue.",
        "from tab A\nfrom tab B": "Handled both tabs' queues.",
        "line one\nline two": "Handled the appended queue.",
      },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Queue Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  async function userMessages(sessionId: string): Promise<string[]> {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${SLUG}/chats/${sessionId}/messages`,
    });
    const body = res.json() as { messages?: Array<{ role: string; content: string }> } | Array<{ role: string; content: string }>;
    const msgs = Array.isArray(body) ? body : (body.messages ?? []);
    return msgs.filter((m) => m.role === "user").map((m) => m.content);
  }

  it("accepts a chat:set_queue frame (regression: it used to be rejected as 'Unknown message')", async () => {
    // The isClientMessage validator had no chat:set_queue case until #245, so the
    // server dropped every one → the #197 store never persisted. Guard it: a valid
    // set_queue must NOT come back as a chat:error.
    const mark = ws.mark();
    // A CLEAR (text: null) — accepted + persisted-as-removed, with no drain side
    // effect (so it can't perturb the shared keeper's job queue for later tests).
    ws.send({
      type: "chat:set_queue",
      payload: { projectSlug: SLUG, sessionId: "probe-session", text: null, ts: 1 },
    });
    ws.send({ type: "ping" });
    const next = await ws.waitFor((e) => e.type === "pong" || e.type === "chat:error", { from: mark });
    expect(next.type).toBe("pong");
  });

  it("idle-drain: a queue SET while the session is idle is auto-sent (the reported fix)", async () => {
    // Turn 1 completes → the session is now idle.
    const m1 = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
    const c1 = await ws.waitFor(isComplete, { from: m1 });
    const sessionId = c1.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();

    // Now set a queue for the (idle) session — as a late reconnect-outbox delivery
    // would. The server must send it WITHOUT waiting for a completion that's over.
    const m2 = ws.mark();
    ws.send({
      type: "chat:set_queue",
      payload: { projectSlug: SLUG, sessionId, text: "drain me", ts: 1000 },
    });
    // The server signals the flush (carrying the text) AND runs the drained turn.
    const flushed = await ws.waitFor(isFlushed, { from: m2 });
    expect(flushed.payload?.text).toBe("drain me");
    await ws.waitFor(isComplete, { from: m2 });

    // The queued message was sent exactly once.
    const users = await userMessages(sessionId);
    expect(users.filter((m) => m === "drain me")).toHaveLength(1);
  });

  it("dedup: re-asserting an already-drained queue (same ts) clears but does NOT re-send", async () => {
    // Establish + drain a queue at ts=2000.
    const m1 = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
    const sessionId = (await ws.waitFor(isComplete, { from: m1 })).payload?.sessionId as string;

    const m2 = ws.mark();
    ws.send({ type: "chat:set_queue", payload: { projectSlug: SLUG, sessionId, text: "drain me", ts: 2000 } });
    await ws.waitFor(isFlushed, { from: m2 });
    await ws.waitFor(isComplete, { from: m2 });
    expect((await userMessages(sessionId)).filter((m) => m === "drain me")).toHaveLength(1);

    // A reloaded client re-asserts the SAME message (same ts). It must be cleared,
    // NOT sent a second time.
    const m3 = ws.mark();
    ws.send({ type: "chat:set_queue", payload: { projectSlug: SLUG, sessionId, text: "drain me", ts: 2000 } });
    const flushed = await ws.waitFor(isFlushed, { from: m3 });
    // The clear frame carries NO text (nothing was sent).
    expect(flushed.payload?.text).toBeUndefined();

    // Prove no extra turn slipped in: a fresh sentinel turn completes, and the
    // transcript still has exactly one "drain me".
    const m4 = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId, message: "sentinel" } });
    await ws.waitFor(isComplete, { from: m4 });
    expect((await userMessages(sessionId)).filter((m) => m === "drain me")).toHaveLength(1);
  });

  it("completion-drain: a queue set WHILE a turn runs is auto-sent once the turn ends", async () => {
    // Hold the first turn open with an in-flight tool so we can queue during it.
    process.env.PADDOCK_FAKE_SLOWTOOL_MS = "1200";
    try {
      const m1 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
      const sessionId = (await ws.waitFor(isComplete, { from: m1 })).payload?.sessionId as string;

      // Start a slow turn on the known session; queue a follow-up while it runs.
      const m2 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId, message: "[[SLOWTOOL]] slow turn" } });
      // Wait until the turn is visibly running (its in-flight tool row started).
      await ws.waitFor(
        (e) => e.type === "chat:tool_start" && e.payload?.sessionId === sessionId,
        { from: m2 },
      );
      // Queue while it's still running — held server-side, not drained yet.
      ws.send({ type: "chat:set_queue", payload: { projectSlug: SLUG, sessionId, text: "after slow", ts: 3000 } });

      // The slow turn completes, then the server drains the queued follow-up.
      const flushed = await ws.waitFor(isFlushed, { from: m2 });
      expect(flushed.payload?.text).toBe("after slow");
      await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, { from: flushedIndex(ws, flushed) });

      expect((await userMessages(sessionId)).filter((m) => m === "after slow")).toHaveLength(1);
    } finally {
      delete process.env.PADDOCK_FAKE_SLOWTOOL_MS;
    }
  });

  it("append at an ALREADY-FLUSHED ts is a distinct message, not a duplicate (#628)", async () => {
    // The client keeps ONE stable enqueue ts across an APPEND to an existing queue
    // (#245 identity), so a pane holding an already-drained queue — it never saw the
    // `chat:queued_flushed` clear, which is broadcast un-buffered — re-asserts the
    // same ts with LONGER text. Deduping on the ts alone made the server broadcast a
    // text-less clear and drop the appended text on the floor.
    process.env.PADDOCK_FAKE_SLOWTOOL_MS = "1200";
    try {
      const m1 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
      const sessionId = (await ws.waitFor(isComplete, { from: m1 })).payload?.sessionId as string;

      // Queue "alpha" at ts 7000 while idle → drained immediately, marking 7000 flushed.
      const m2 = ws.mark();
      ws.send({ type: "chat:set_queue", payload: { projectSlug: SLUG, sessionId, text: "alpha", ts: 7000 } });
      expect((await ws.waitFor(isFlushed, { from: m2 })).payload?.text).toBe("alpha");
      await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, { from: m2 });

      // Start another turn, then re-assert the SAME ts with the appended text.
      const m3 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId, message: "[[SLOWTOOL]] slow turn" } });
      await ws.waitFor((e) => e.type === "chat:tool_start" && e.payload?.sessionId === sessionId, { from: m3 });
      ws.send({ type: "chat:set_queue", payload: { projectSlug: SLUG, sessionId, text: "alpha\nbravo", ts: 7000 } });

      // Same ts, DIFFERENT text ⇒ a new message: the flush frame carries it and the
      // turn actually runs. Pre-fix the frame arrived with no text and nothing was sent.
      const flushed = await ws.waitFor(isFlushed, { from: m3 });
      expect(flushed.payload?.text).toBe("alpha\nbravo");
      await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, {
        from: flushedIndex(ws, flushed),
      });
      expect((await userMessages(sessionId)).filter((m) => m === "alpha\nbravo")).toHaveLength(1);

      // #245 stable identity still holds: re-asserting the SAME (ts, text) is a
      // duplicate — cleared without a second send.
      const m4 = ws.mark();
      ws.send({ type: "chat:set_queue", payload: { projectSlug: SLUG, sessionId, text: "alpha\nbravo", ts: 7000 } });
      expect((await ws.waitFor(isFlushed, { from: m4 })).payload?.text).toBeUndefined();
      const m5 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId, message: "sentinel" } });
      await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, { from: m5 });
      expect((await userMessages(sessionId)).filter((m) => m === "alpha\nbravo")).toHaveLength(1);
    } finally {
      delete process.env.PADDOCK_FAKE_SLOWTOOL_MS;
    }
  });

  it("a client with a FAST CLOCK does not destroy the next queued message (#736)", async () => {
    const m1 = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
    const sessionId = (await ws.waitFor(isComplete, { from: m1 })).payload?.sessionId as string;

    // A laptop whose clock is five minutes fast queues a message. It drains fine —
    // and (pre-fix) left the server's dedup marker five minutes in the future.
    const m2 = ws.mark();
    ws.send({
      type: "chat:set_queue",
      payload: { projectSlug: SLUG, sessionId, text: "from the fast clock", ts: Date.now() + 5 * 60_000 },
    });
    expect((await ws.waitFor(isFlushed, { from: m2 })).payload?.text).toBe("from the fast clock");
    await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, { from: m2 });

    // Now a correctly-clocked queue on the same chat. Pre-fix it was take()n,
    // compared against that future marker, classified "already flushed", deleted
    // from the sidecar and never sent — with the chip cleared and no error. And
    // then so was every message after it, until wall-clock time caught up. The ts
    // need not even come from this client: one fast laptop poisoned the chat for
    // everyone attached to it.
    const m3 = ws.mark();
    ws.send({
      type: "chat:set_queue",
      payload: { projectSlug: SLUG, sessionId, text: "must not vanish", ts: Date.now() },
    });
    const flushed = await ws.waitFor(isFlushed, { from: m3 });
    expect(flushed.payload?.text, "the queued message was silently destroyed").toBe("must not vanish");
    await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, {
      from: flushedIndex(ws, flushed),
    });
    expect((await userMessages(sessionId)).filter((m) => m === "must not vanish")).toHaveLength(1);
  });

  it("a second client's queue MERGES into the one slot instead of destroying the first's (#629)", async () => {
    process.env.PADDOCK_FAKE_SLOWTOOL_MS = "1500";
    const wsB = await connectWs(port);
    try {
      const m1 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
      const sessionId = (await ws.waitFor(isComplete, { from: m1 })).payload?.sessionId as string;

      // Two panes open on the same chat — two tabs, or a laptop and a phone.
      const subscribe = (c: WsClient) =>
        c.send({
          type: "chat:subscribe",
          payload: { projectSlug: SLUG, sessionId, wantReplay: false, lastSeq: -1 },
        });
      subscribe(ws);
      subscribe(wsB);

      const m2 = ws.mark();
      const mB = wsB.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: SLUG, sessionId, message: "[[SLOWTOOL]] slow turn" },
      });
      await ws.waitFor((e) => e.type === "chat:tool_start" && e.payload?.sessionId === sessionId, {
        from: m2,
      });

      // Tab A queues. The queue used to be written and never announced, so tab B
      // had no idea anything was queued at all.
      ws.send({
        type: "chat:set_queue",
        payload: { projectSlug: SLUG, sessionId, text: "from tab A", qid: "tab-a" },
      });
      const seenByB = await wsB.waitFor(
        (e) => e.type === "chat:queued_state" && e.payload?.sessionId === sessionId,
        { from: mB },
      );
      expect(seenByB.payload?.text, "tab A's queue was never announced to tab B").toBe("from tab A");

      // Tab B queues too. A plain `set` overwrote the slot here: tab A's message was
      // destroyed unrecoverably, its chip still showing, and when the drain fired,
      // tab A's own transcript rendered tab B's text as a user bubble A never typed.
      const mB2 = wsB.mark();
      wsB.send({
        type: "chat:set_queue",
        payload: { projectSlug: SLUG, sessionId, text: "from tab B", qid: "tab-b" },
      });
      const merged = await wsB.waitFor(
        (e) => e.type === "chat:queued_state" && e.payload?.sessionId === sessionId,
        { from: mB2 },
      );
      expect(merged.payload?.text, "tab A's queued message was overwritten").toBe(
        "from tab A\nfrom tab B",
      );

      // One slot, one flush, both messages — in the order they were queued.
      const flushed = await ws.waitFor(isFlushed, { from: m2 });
      expect(flushed.payload?.text).toBe("from tab A\nfrom tab B");
      await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, {
        from: flushedIndex(ws, flushed),
      });
      expect(await userMessages(sessionId)).toContain("from tab A\nfrom tab B");
    } finally {
      wsB.close();
      delete process.env.PADDOCK_FAKE_SLOWTOOL_MS;
    }
  });

  it("appending to a LIVE queue extends it in place, not behind a copy of itself", async () => {
    // The composer keeps ONE identity across an append (#245) and never carries
    // the slot version the server minted a moment earlier — an older client sends
    // only its `ts`, and even a current one can append faster than the broadcast
    // round trip. Merging that as a second contribution would queue "line
    // one\nline one\nline two".
    process.env.PADDOCK_FAKE_SLOWTOOL_MS = "1500";
    try {
      const m1 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
      const sessionId = (await ws.waitFor(isComplete, { from: m1 })).payload?.sessionId as string;

      const m2 = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: SLUG, sessionId, message: "[[SLOWTOOL]] slow turn" },
      });
      await ws.waitFor((e) => e.type === "chat:tool_start" && e.payload?.sessionId === sessionId, {
        from: m2,
      });

      ws.send({
        type: "chat:set_queue",
        payload: { projectSlug: SLUG, sessionId, text: "line one", qid: "one-pane" },
      });
      ws.send({
        type: "chat:set_queue",
        payload: { projectSlug: SLUG, sessionId, text: "line one\nline two", qid: "one-pane" },
      });

      const flushed = await ws.waitFor(isFlushed, { from: m2 });
      expect(flushed.payload?.text).toBe("line one\nline two");
      await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sessionId, {
        from: flushedIndex(ws, flushed),
      });
      expect((await userMessages(sessionId)).filter((m) => m === "line one\nline two")).toHaveLength(1);
    } finally {
      delete process.env.PADDOCK_FAKE_SLOWTOOL_MS;
    }
  });

  it("refuses an unbounded queued message rather than persisting it verbatim", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:set_queue",
      payload: { projectSlug: SLUG, sessionId: "size-probe", text: "x".repeat(200_000), qid: "big" },
    });
    const err = await ws.waitFor((e) => e.type === "chat:error", { from: mark });
    expect(String(err.payload?.error)).toMatch(/too long/i);
  });
});

/** Index of a received event, for use as a `waitFor` baseline. */
function flushedIndex(ws: WsClient, e: WsEvent): number {
  return ws.events.indexOf(e);
}

/**
 * #627: a queued message escapes on EVERY turn-ending path, not just a successful
 * `chat:send`.
 *
 * `drainQueue` used to be called from two places — the idle `set_queue` and the
 * completion of a `chat:send` turn. `onChatCommand`, `startAgentTurn` (triggers,
 * spawns, wakes, recovery) and the background sub-agent sink all end turns without
 * it, and a Stopped turn was deliberately skipped. So a message queued during any
 * of those was persisted and then STRANDED: the chip sat there, and the message
 * escaped only when some later `chat:send` completed — landing in the transcript
 * BEHIND a message the user typed minutes afterwards.
 *
 * The drain now hangs off the hub's turn-end hook, which every one of those paths
 * already goes through. Each test below asserts the flush arrives after ITS OWN
 * turn's completion — an early (idle) drain would fail the ordering assertion just
 * as a stranded one fails the wait.
 */
describe("integration: every turn-ending path drains the queue (#627)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  const TSLUG = "trig-queue";

  beforeAll(async () => {
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      script: {
        "queued during a trigger": "Handled the trigger-time queue.",
        "queued during a stopped turn": "Handled the stopped-turn queue.",
      },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Trig Queue" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("a TRIGGER turn drains the message queued while it ran", async () => {
    process.env.PADDOCK_FAKE_SLOWTOOL_MS = "2500";
    try {
      await t.app.inject({
        method: "PUT",
        url: `/api/projects/${TSLUG}/triggers/slowfire`,
        payload: {
          trigger: { type: "event", on: "onArchive" },
          run: { prompt: "TRIGGERTURN [[SLOWTOOL]] hold the turn open" },
        },
      });

      const mark = ws.mark();
      const fired = await t.app.inject({ method: "POST", url: `/api/projects/${TSLUG}/triggers/slowfire/run` });
      expect(fired.statusCode).toBe(202);
      const sessionId = fired.json().sessionId as string;
      expect(sessionId).toBeTruthy();

      // Watch the trigger's chat, exactly as a user with that pane open would.
      ws.send({
        type: "chat:subscribe",
        payload: { projectSlug: TSLUG, sessionId, wantReplay: false, lastSeq: -1 },
      });
      // Queue a follow-up while the trigger turn is still running. The `isRunning`
      // guard correctly holds it — nothing then picked it up.
      ws.send({
        type: "chat:set_queue",
        payload: { projectSlug: TSLUG, sessionId, text: "queued during a trigger", qid: "trig-q" },
      });

      // The trigger turn ends…
      const done = await ws.waitFor(
        (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
        { from: mark, timeoutMs: 20_000 },
      );
      // …and THAT is what flushes the queue. Baselined after the completion, so a
      // drain that had (wrongly) fired earlier would not satisfy this either.
      const flushed = await ws.waitFor(
        (e) => e.type === "chat:queued_flushed" && e.payload?.sessionId === sessionId,
        { from: ws.events.indexOf(done) + 1, timeoutMs: 20_000 },
      );
      expect(flushed.payload?.text).toBe("queued during a trigger");
    } finally {
      delete process.env.PADDOCK_FAKE_SLOWTOOL_MS;
    }
  });

  it("a STOPPED turn drains the message queued while it ran", async () => {
    // [[HANGTOOL]] emits an in-flight tool and then blocks forever, so the turn ends
    // only when the user clicks Stop — and, deliberately, it streams NO assistant
    // text first. That matters: the old drain gate (`effectiveSuccess`) is
    // reply-aware, so a Stop AFTER some prose had streamed drained anyway. The "a
    // Stop/failed turn holds the queue for the user" comment therefore only ever
    // described THIS case — a turn Stopped before it said anything — and holding it
    // did not keep the message safe: nothing drained it afterwards either, so it
    // waited for the next `chat:send` and landed behind whatever the user typed
    // next, with a stale chip above the composer in the meantime.
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: TSLUG, sessionId: null, message: "hold the line [[HANGTOOL]]" },
    });
    const streamed = await ws.waitFor(
      (e) =>
        e.type === "chat:tool_start" &&
        e.payload?.projectSlug === TSLUG &&
        typeof e.payload?.jobId === "string" &&
        typeof e.payload?.sessionId === "string",
      { from: mark },
    );
    const jobId = streamed.payload!.jobId as string;
    const sessionId = streamed.payload!.sessionId as string;

    ws.send({
      type: "chat:set_queue",
      payload: { projectSlug: TSLUG, sessionId, text: "queued during a stopped turn", qid: "stop-q" },
    });

    const cancelMark = ws.mark();
    ws.send({ type: "chat:cancel", payload: { jobId } });
    const done = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: cancelMark, timeoutMs: 20_000 },
    );
    const flushed = await ws.waitFor(
      (e) => e.type === "chat:queued_flushed" && e.payload?.sessionId === sessionId,
      { from: ws.events.indexOf(done) + 1, timeoutMs: 20_000 },
    );
    expect(flushed.payload?.text).toBe("queued during a stopped turn");
  });
});

/**
 * #627, slash-command path — and the drive-mode control for this whole file.
 *
 * `runCommand` goes through `openChatSession`, which in @herdctl/core ALWAYS runs
 * on the SDK (session) runtime: the fake `claude` on PATH is never spawned, so this
 * path cannot be driven by the CLI harness the rest of the suite pins. We stub the
 * RuntimeSession and drive everything above it for real — ws.ts, `onChatCommand`,
 * `consumeResumedTurn`, the hub, the store and the drain.
 *
 * That makes this test the one that exercises a SESSION-runtime turn ending, and
 * it drains identically to the batch turns above: the drain hangs off the hub's
 * turn-end hook, which sits above the runtime split, so both runtimes reach it
 * through the same `turn.end()`.
 */
describe("integration: a slash-command turn drains the queue when it ends (#627)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let spy: ReturnType<typeof vi.spyOn>;
  const CSLUG = "cmd-queue";

  /** A RuntimeSession that streams a line, then completes when `finish()` is called. */
  function heldSession(sessionId: string) {
    let finish: () => void = () => {};
    const held = new Promise<void>((r) => {
      finish = r;
    });
    async function* messages(): AsyncGenerator<unknown> {
      yield {
        type: "assistant",
        session_id: sessionId,
        message: { model: "opus", content: [{ type: "text", text: "Compacting…" }] },
      };
      await held;
      yield { type: "result", subtype: "success", session_id: sessionId, result: "done" };
    }
    const session = {
      messages: messages(),
      send: async () => {},
      interrupt: async () => {},
      listCommands: async () => [],
      setModel: async () => {},
      close: async () => {},
    } as unknown as RuntimeSession;
    return { session, finish: () => finish() };
  }

  beforeAll(async () => {
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      script: { "queued during a compact": "Handled the post-compact queue." },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Cmd Queue" } });
    spy = vi.spyOn(t.herdctl.manager, "openChatSession");
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    spy?.mockRestore();
    await t.teardown();
  });

  it("drains on the COMMAND turn's completion, not on some later chat:send", async () => {
    const sessionId = "cmd-queue-sess-1";
    const fake = heldSession(sessionId);
    spy.mockResolvedValue(fake.session as never);

    const mark = ws.mark();
    ws.send({
      type: "chat:command",
      payload: { projectSlug: CSLUG, command: "/compact", sessionId },
    });
    await ws.waitFor((e) => e.type === "chat:response" && e.payload?.sessionId === sessionId, {
      from: mark,
    });

    // `onChatCommand` opens a real hub turn, so `hub.isRunning` is true and the
    // queue is correctly held here. Pre-fix, nothing ever picked it back up: the
    // command handler ended its turn with no drain, and the message sat in
    // queued-message.json until a later `chat:send` flushed it out of order.
    ws.send({
      type: "chat:set_queue",
      payload: { projectSlug: CSLUG, sessionId, text: "queued during a compact", qid: "cmd-q" },
    });
    // Let it be seen before the turn ends (the set is a round trip over the socket).
    await ws.waitFor((e) => e.type === "chat:queued_state" && e.payload?.sessionId === sessionId, {
      from: mark,
    });

    fake.finish();
    const done = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: mark, timeoutMs: 20_000 },
    );
    const flushed = await ws.waitFor(
      (e) => e.type === "chat:queued_flushed" && e.payload?.sessionId === sessionId,
      { from: ws.events.indexOf(done) + 1, timeoutMs: 20_000 },
    );
    expect(flushed.payload?.text).toBe("queued during a compact");
  });
});
