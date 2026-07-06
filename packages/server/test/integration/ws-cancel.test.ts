/**
 * WS cancel / Stop button (herdctl cancelJob interrupt).
 *
 * The chat "Stop" button sends `chat:cancel { jobId }`, which the server routes
 * to herdctl's `cancelJob`. Before @herdctl/core@5.14.1 that only rewrote the
 * job's status file while the agent kept running — so Stop did nothing and the
 * composer stayed locked. With the fix, cancelJob aborts the live run, `trigger()`
 * returns, and the server emits the terminal `chat:complete` that unlocks the UI.
 *
 * Here we drive it end-to-end against the REAL FleetManager + CLI runtime: the
 * fake `claude` streams an assistant line and then HANGS (never writes its result
 * line), so the turn stays running with no natural completion. We then send
 * `chat:cancel` and assert a terminal `chat:complete` arrives — proving the turn
 * was genuinely interrupted rather than left running.
 *
 * Each test uses its own project to avoid the cross-test sweep race (see
 * ws-reattach.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";

describe("integration: WS cancel interrupts a running turn (Stop button)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    ({ port } = await listen(t.app));
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<string> {
    const name = `Cancel ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  it("emits a terminal chat:complete after chat:cancel of a hanging turn", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      const mark = ws.mark();
      // [[HANG]] makes the fake stream its reply then block without finishing —
      // the turn keeps running until it is interrupted.
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "hold the line [[HANG]]" },
      });

      // The turn is live and streaming; capture the cancellable jobId off a frame.
      const streamed = await ws.waitFor(
        (e: WsEvent) =>
          (e.type === "chat:response" || e.type === "chat:active") &&
          e.payload?.projectSlug === slug &&
          typeof e.payload?.jobId === "string",
        { from: mark },
      );
      const jobId = streamed.payload!.jobId as string;

      // The hanging turn has NOT completed on its own (no result line was written).
      expect(
        ws.events
          .slice(mark)
          .some((e) => e.type === "chat:complete" && e.payload?.projectSlug === slug),
      ).toBe(false);

      // Click Stop.
      const cancelMark = ws.mark();
      ws.send({ type: "chat:cancel", payload: { jobId } });

      // The turn is actually interrupted: a terminal chat:complete arrives. Without
      // the herdctl fix this never fires (the process would keep hanging).
      const complete = await ws.waitFor(
        (e: WsEvent) => e.type === "chat:complete" && e.payload?.projectSlug === slug,
        { from: cancelMark, timeoutMs: 15_000 },
      );
      expect(complete.payload?.success).toBe(false);
    } finally {
      ws.close();
    }
  });

  it("flips the chat:active signal to running:false on cancel", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      const mark = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "wait here [[HANG]]" },
      });

      const running = await ws.waitFor(
        (e: WsEvent) =>
          e.type === "chat:active" &&
          e.payload?.projectSlug === slug &&
          e.payload?.running === true &&
          typeof e.payload?.jobId === "string",
        { from: mark },
      );
      const jobId = running.payload!.jobId as string;
      const sid = running.payload!.sessionId as string;

      const cancelMark = ws.mark();
      ws.send({ type: "chat:cancel", payload: { jobId } });

      const stopped = await ws.waitFor(
        (e: WsEvent) =>
          e.type === "chat:active" &&
          e.payload?.sessionId === sid &&
          e.payload?.running === false,
        { from: cancelMark, timeoutMs: 15_000 },
      );
      expect(stopped.payload?.running).toBe(false);
    } finally {
      ws.close();
    }
  });
});
