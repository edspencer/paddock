/**
 * Server-authoritative queued-message auto-send (#245). The server — not the
 * client — drains a persisted queued message and sends it as the next turn,
 * both (a) when a turn completes and (b) immediately when a queue is set for an
 * IDLE session (a queue delivered late, e.g. over the reconnect outbox, after the
 * turn it was meant to follow already ended — the reported stranding bug). Runs
 * through the REAL app + fake claude on a single socket.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

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
});

/** Index of a received event, for use as a `waitFor` baseline. */
function flushedIndex(ws: WsClient, e: WsEvent): number {
  return ws.events.indexOf(e);
}
