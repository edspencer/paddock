/**
 * Keeper-chat recovery re-drive — the double-dispatch guard (issue #352).
 *
 * The recovery nudge (manual Layer 2 `chat:continue`, and Layer 3 auto re-drive)
 * resumes a still-alive keeper session. Under session-mode `chatSession(resume)` a
 * SECOND resume of a session that already has a live turn INTERRUPTS the first, so
 * one nudge gets swallowed (the "first message swallowed" symptom, #350/#347). The
 * fix: `injectRecoveryNudge` is single-flight and yields to any in-flight turn
 * (`hub.isRunning`), so a Continue click (or auto re-drive) fired at a busy session
 * is refused rather than racing the live turn.
 *
 * Runs through the REAL app + fake claude on a single socket. The fake replies to
 * the fixed {@link RECOVERY_NUDGE} with the default `Acknowledged: …` echo, so a
 * fired re-drive is detectable as a user message carrying the nudge text.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import { RECOVERY_NUDGE } from "../../src/ws.js";

const SLUG = "recover-proj";
const isComplete = (sessionId?: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === SLUG &&
  (sessionId ? e.payload?.sessionId === sessionId : typeof e.payload?.sessionId === "string");

/** A recovery nudge is unmistakable in the transcript by its "[Paddock recovery]" lead. */
const isNudge = (text: string) => text.includes("[Paddock recovery]");

describe("integration: recovery re-drive double-dispatch guard (#352)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp({
      script: {
        "start turn": "First reply.",
        "another turn": "Second reply.",
        // The fake echoes any unscripted prompt (incl. RECOVERY_NUDGE) as
        // "Acknowledged: …", which is all we need to detect a fired nudge.
      },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Recover Proj" } });
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
    const body = res.json() as
      | { messages?: Array<{ role: string; content: string }> }
      | Array<{ role: string; content: string }>;
    const msgs = Array.isArray(body) ? body : (body.messages ?? []);
    return msgs.filter((m) => m.role === "user").map((m) => m.content);
  }

  /** Poll the transcript until `pred` holds over its user messages, or time out. */
  async function waitForUsers(
    sessionId: string,
    pred: (users: string[]) => boolean,
    timeoutMs = 10_000,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const users = await userMessages(sessionId);
      if (pred(users)) return users;
      if (Date.now() >= deadline) return users;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("a Continue fired at an IDLE session injects exactly one recovery nudge", async () => {
    const m1 = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
    const sessionId = (await ws.waitFor(isComplete(), { from: m1 })).payload?.sessionId as string;
    expect(sessionId).toBeTruthy();

    // Session is idle → the recovery re-drive runs. It's injected via startAgentTurn
    // with no origin socket, so its frames only reach hub-subscribed sockets — assert
    // via the transcript rather than a WS frame on this (unsubscribed) socket.
    ws.send({ type: "chat:continue", payload: { projectSlug: SLUG, sessionId } });
    const users = await waitForUsers(sessionId, (u) => u.some(isNudge));
    expect(users.filter(isNudge)).toHaveLength(1);
  });

  it("a Continue fired while a turn is RUNNING is refused (no swallowed double-dispatch)", async () => {
    // Hold a turn open with an in-flight slow tool so the session is provably busy.
    process.env.PADDOCK_FAKE_SLOWTOOL_MS = "1200";
    try {
      const m1 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
      const sessionId = (await ws.waitFor(isComplete(), { from: m1 })).payload?.sessionId as string;

      // Start a slow turn on the known session.
      const m2 = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: SLUG, sessionId, message: "[[SLOWTOOL]] another turn" },
      });
      // Wait until it is visibly running (its in-flight tool row started).
      await ws.waitFor((e) => e.type === "chat:tool_start" && e.payload?.sessionId === sessionId, {
        from: m2,
      });

      // Fire Continue WHILE the turn runs — the guard must refuse it (resuming now
      // would interrupt-swallow the live turn). It produces no nudge turn.
      ws.send({ type: "chat:continue", payload: { projectSlug: SLUG, sessionId } });

      // The slow turn completes on its own.
      await ws.waitFor(isComplete(sessionId), { from: m2 });

      // A sentinel turn proves nothing else slipped in behind the refused Continue.
      const m3 = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId, message: "another turn" } });
      await ws.waitFor(isComplete(sessionId), { from: m3 });

      // The refused Continue injected NO recovery nudge.
      expect((await userMessages(sessionId)).filter(isNudge)).toHaveLength(0);
    } finally {
      delete process.env.PADDOCK_FAKE_SLOWTOOL_MS;
    }
  });
});
