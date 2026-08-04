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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";
import type { RuntimeSession } from "@herdctl/core";

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

/**
 * Stop on a SLASH-COMMAND turn (#632).
 *
 * A `/compact` turn was permanently un-stoppable: `onChatCommand` hardcoded
 * `jobId: null` in its routing, so no id ever reached the client (its Stop is
 * guarded by `if (meta.jobId)`), and `runCommand` never registered its session in
 * `liveSessions`, so even a hand-supplied id had nothing to interrupt.
 *
 * Unlike the `chat:send` tests above, this path cannot use the fake `claude`:
 * `runCommand` goes through `openChatSession`, which in @herdctl/core ALWAYS runs
 * on the SDK runtime (control requests like `interrupt()` exist nowhere else), so
 * the CLI stand-in on PATH is never spawned and `[[HANG]]` never runs. We
 * therefore stub `openChatSession` with a session that streams a line and then
 * hangs — the RuntimeSession-level equivalent of `[[HANG]]` — and drive
 * everything else (ws.ts, HerdctlService.runCommand, HerdctlService.cancel, the
 * hub) for real.
 */
describe("integration: WS cancel on a slash-command turn (#632)", () => {
  let t: TestApp;
  let port: number;
  let ws: Awaited<ReturnType<typeof connectWs>>;
  let spy: ReturnType<typeof vi.spyOn>;
  let n = 0;

  /**
   * A RuntimeSession that streams one assistant message and then blocks without a
   * terminal `result` — the turn stays running until `interrupt()` releases it,
   * exactly as the fake CLI's `[[HANG]]` does for a batch turn.
   */
  function hangingSession(sessionId: string) {
    const calls = { interrupt: 0, close: 0, sent: [] as string[] };
    let release: () => void = () => {};
    const interrupted = new Promise<void>((r) => {
      release = r;
    });
    async function* messages(): AsyncGenerator<unknown> {
      yield {
        type: "assistant",
        session_id: sessionId,
        message: { model: "opus", content: [{ type: "text", text: "Compacting…" }] },
      };
      await interrupted;
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionId,
        result: "[Request interrupted by user]",
      };
    }
    const session = {
      messages: messages(),
      send: async (text: string) => {
        calls.sent.push(text);
      },
      interrupt: async () => {
        calls.interrupt++;
        release();
      },
      listCommands: async () => [],
      setModel: async () => {},
      close: async () => {
        calls.close++;
      },
    } as unknown as RuntimeSession;
    return { session, calls };
  }

  /** Fire a `/compact` and wait until its turn is visibly streaming. */
  async function startCommandTurn() {
    const sessionId = `cmd-sess-${++n}`;
    const fake = hangingSession(sessionId);
    spy.mockResolvedValue(fake.session as never);
    const mark = ws.mark();
    ws.send({
      type: "chat:command",
      payload: { projectSlug: "cmd-stop", command: "/compact", sessionId },
    });
    await ws.waitFor(
      (e: WsEvent) => e.type === "chat:response" && e.payload?.sessionId === sessionId,
      { from: mark },
    );
    // The jobId, if any, is pushed on chat:active the moment the turn is opened —
    // i.e. strictly before the first streamed frame above.
    const armed = ws.events
      .slice(mark)
      .find((e) => typeof e.payload?.jobId === "string" && e.payload?.sessionId === sessionId);
    return { sessionId, fake, mark, jobId: armed?.payload?.jobId as string | undefined };
  }

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Cmd Stop" } });
    spy = vi.spyOn(t.herdctl.manager, "openChatSession");
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    spy?.mockRestore();
    await t.teardown();
  });

  it("arms Stop: a slash-command turn emits a real jobId", async () => {
    const { jobId } = await startCommandTurn();
    // Pre-#632 every frame of a command turn carried `jobId: null`, so the client's
    // `if (meta.jobId)` guard swallowed the click and Stop never sent anything.
    expect(jobId, "no frame of the slash-command turn carried a jobId").toBeTruthy();
  });

  it("Stop actually cancels: chat:cancel interrupts the live session and ends the turn", async () => {
    const { sessionId, fake, jobId } = await startCommandTurn();
    expect(jobId, "no frame of the slash-command turn carried a jobId").toBeTruthy();

    // The hanging turn has NOT ended on its own.
    expect(fake.calls.interrupt).toBe(0);

    const cancelMark = ws.mark();
    ws.send({ type: "chat:cancel", payload: { jobId } });

    // The real cancel routing reaches the real session, and the turn terminates.
    await ws.waitFor(
      (e: WsEvent) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: cancelMark, timeoutMs: 15_000 },
    );
    expect(fake.calls.interrupt).toBe(1);
    await ws.waitFor(
      (e: WsEvent) =>
        e.type === "chat:active" && e.payload?.sessionId === sessionId && e.payload?.running === false,
      { from: cancelMark, timeoutMs: 15_000 },
    );
  });

  it("does not leak: the registration is dropped once the command turn ends", async () => {
    const { sessionId, fake, jobId } = await startCommandTurn();
    const cancelMark = ws.mark();
    ws.send({ type: "chat:cancel", payload: { jobId } });
    await ws.waitFor(
      (e: WsEvent) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: cancelMark, timeoutMs: 15_000 },
    );
    expect(fake.calls.close).toBe(1);

    // A second Stop on the finished turn must no longer resolve to that session —
    // the entry was removed alongside the close, mirroring chatSession.
    expect(await t.herdctl.cancel(jobId as string)).toBe(false);
    expect(fake.calls.interrupt).toBe(1);
  });
});
