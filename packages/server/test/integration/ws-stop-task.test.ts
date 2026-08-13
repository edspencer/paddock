/**
 * WS `chat:stop_task` — stopping ONE piece of background work (#848).
 *
 * End to end over a real socket: the wire validator, the handler, the registry
 * and the answer frame. Only the fleet's `stopTaskInSession` is stubbed, because
 * that is the boundary where the three outcomes are MADE — and because the fake
 * `claude` this suite drives runs the CLI runtime, which has no managed session
 * at all, so every real call would answer `gone`.
 *
 * The live task set is seeded by the fake claude's `[[BGTASK]]` directive, so
 * the rows being stopped are the same rows #604 produces in production.
 *
 * What each outcome must be true of, and why none of them may be collapsed:
 *
 *  - `stopping` — accepted. The row is NOT removed here; the SDK's own terminal
 *    notification does that. Removing it on the click would lie whenever the
 *    stop is refused.
 *  - `gone` — no live session, so no notification is ever coming. The server
 *    must drop the row itself or it hangs at `stopping…` forever.
 *  - `error` — the stop did NOT happen and the task is still running. Never
 *    laundered into a success.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";

describe("integration: WS chat:stop_task (#848)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({
      script: { "[[BGTASK]] go": "Kicked off some background work." },
      sweepIntervalMs: 600_000,
      env: { PADDOCK_FAKE_BGTASK_MS: "10000" },
    });
    ({ port } = await listen(t.app));
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<string> {
    const name = `Stoptask ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  const bgFrame = (slug: string) => (e: WsEvent) =>
    e.type === "chat:background" && e.payload?.projectSlug === slug;
  const resultFrame = (e: WsEvent) => e.type === "chat:stop_task_result";

  /** Point the fleet's per-task stop at `impl` for the duration of one test. */
  function stubStop(impl: (sessionId: string, taskId: string) => Promise<boolean>) {
    const fleet = (t.herdctl as unknown as { fleet: Record<string, unknown> }).fleet;
    const prev = fleet.stopTaskInSession;
    const spy = vi.fn(impl);
    fleet.stopTaskInSession = spy;
    return { spy, restore: () => void (fleet.stopTaskInSession = prev) };
  }

  /**
   * Start a turn that launches background work and return the socket plus the
   * live task set, so a test can stop a REAL row rather than an invented id.
   */
  async function withLiveTasks() {
    const slug = await freshProject();
    const ws = await connectWs(port);
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "[[BGTASK]] go" },
    });
    const frame = await ws.waitFor(
      (e) => bgFrame(slug)(e) && ((e.payload?.tasks as unknown[]) ?? []).length === 2,
      { timeoutMs: 20_000 },
    );
    const tasks = frame.payload!.tasks as {
      id: string;
      type: string;
      role: string;
      stoppable?: boolean;
    }[];
    return {
      slug,
      ws,
      sessionId: frame.payload!.sessionId as string,
      tasks,
      // The stop-flow tests target the SHELL: it is the one the server marks
      // stoppable, and it stays live for the whole PADDOCK_FAKE_BGTASK_MS
      // window — far longer than a round trip — so "is this row still listed"
      // is an assertion rather than a race.
      shell: tasks.find((x) => x.type === "local_bash")!,
      monitor: tasks.find((x) => x.type === "monitor_mcp")!,
    };
  }

  it("resolves `stoppable` per RAW type — monitor_mcp false, local_bash true", async () => {
    // The end-to-end version of the reason `stoppable` is on the wire at all.
    // Both these tasks collapse to roles a client renders, and `monitor_mcp` and
    // `monitor_ws` collapse to the SAME `monitor` role while only one of them is
    // killable — so this pair travelling with different `stoppable` values is
    // the property no amount of client-side label inspection could reproduce.
    //
    // Driven through the genuine CLI-frame → registry → WS path: since #849 the
    // fake `claude` emits the CLI's real discriminants, so this is not asserting
    // against a payload production cannot send.
    const { ws, tasks, shell, monitor } = await withLiveTasks();
    try {
      expect(tasks.length).toBe(2);
      expect(shell).toMatchObject({ type: "local_bash", role: "shell", stoppable: true });
      // The one task type the CLI has no kill strategy for.
      expect(monitor).toMatchObject({ type: "monitor_mcp", role: "monitor", stoppable: false });
    } finally {
      ws.close();
    }
  }, 40_000);

  it("answers `stopping` and LEAVES THE ROW in place for the SDK to evict", async () => {
    const { ws, sessionId, tasks, shell } = await withLiveTasks();
    const { spy, restore } = stubStop(async () => true);
    try {
      const taskId = shell.id;
      const mark = ws.mark();
      ws.send({ type: "chat:stop_task", payload: { sessionId, taskId } });

      const res = await ws.waitFor(resultFrame, { from: mark, timeoutMs: 20_000 });
      expect(res.payload).toMatchObject({ sessionId, taskId, outcome: "stopping" });
      expect(res.payload!.message).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(sessionId, taskId);

      // The row is still listed: acceptance is not completion, and pretending
      // otherwise is what would make a refused stop invisible.
      const after = ws.events
        .slice(mark)
        .filter((e) => e.type === "chat:background")
        .at(-1);
      const stillListed = ((after?.payload?.tasks ?? tasks) as { id: string }[]).some(
        (x) => x.id === taskId,
      );
      expect(stillListed).toBe(true);
    } finally {
      restore();
      ws.close();
    }
  }, 40_000);

  it("answers `gone` AND drops the row itself, since nothing will notify", async () => {
    const { slug, ws, sessionId, shell } = await withLiveTasks();
    const { restore } = stubStop(async () => false);
    try {
      const taskId = shell.id;
      const mark = ws.mark();
      ws.send({ type: "chat:stop_task", payload: { sessionId, taskId } });

      const res = await ws.waitFor(resultFrame, { from: mark, timeoutMs: 20_000 });
      expect(res.payload).toMatchObject({ sessionId, taskId, outcome: "gone" });

      // The row must leave on the server's own say-so — there is no live session
      // left to deliver a `task_notification`, so without this it hangs forever.
      const dropped = await ws.waitFor(
        (e) =>
          bgFrame(slug)(e) &&
          !((e.payload?.tasks ?? []) as { id: string }[]).some((x) => x.id === taskId),
        { from: mark, timeoutMs: 20_000 },
      );
      expect(dropped.payload!.tasks).toBeDefined();
    } finally {
      restore();
      ws.close();
    }
  }, 40_000);

  it("answers `error` with the reason, and KEEPS the row (it is still running)", async () => {
    const { slug, ws, sessionId, tasks, shell } = await withLiveTasks();
    const { restore } = stubStop(async () => {
      throw new Error("unsupported_type");
    });
    try {
      const taskId = shell.id;
      const mark = ws.mark();
      ws.send({ type: "chat:stop_task", payload: { sessionId, taskId } });

      const res = await ws.waitFor(resultFrame, { from: mark, timeoutMs: 20_000 });
      expect(res.payload).toMatchObject({ sessionId, taskId, outcome: "error" });
      expect(String(res.payload!.message)).toContain("unsupported_type");

      // Nothing was evicted: reporting a refusal as a removal is the one outcome
      // a stop button must never produce.
      const after = ws.events
        .slice(mark)
        .filter((e) => bgFrame(slug)(e))
        .at(-1);
      const stillListed = ((after?.payload?.tasks ?? tasks) as { id: string }[]).some(
        (x) => x.id === taskId,
      );
      expect(stillListed).toBe(true);
    } finally {
      restore();
      ws.close();
    }
  }, 40_000);

  it("answers `stopping` for a task that already finished, without erroring", async () => {
    // The idempotent race: the click landed after the task completed on its own.
    // The CLI turns `not_found` into a success, and so must we — the user's
    // intent is satisfied either way.
    const { ws, sessionId } = await withLiveTasks();
    const { restore } = stubStop(async () => true);
    try {
      const mark = ws.mark();
      ws.send({ type: "chat:stop_task", payload: { sessionId, taskId: "task_long_gone" } });
      const res = await ws.waitFor(resultFrame, { from: mark, timeoutMs: 20_000 });
      expect(res.payload).toMatchObject({ outcome: "stopping", taskId: "task_long_gone" });
    } finally {
      restore();
      ws.close();
    }
  }, 40_000);

  it("answers every request in a Stop-all fan-out, including the one that fails", async () => {
    // Partial failure must not read as total failure OR total success, so each
    // task gets its own independent answer.
    const { ws, sessionId, tasks, shell, monitor } = await withLiveTasks();
    // The realistic mix: the monitor is the one the CLI genuinely refuses.
    const doomed = monitor.id;
    const survivor = shell.id;
    const { restore } = stubStop(async (_s, taskId) => {
      if (taskId === doomed) throw new Error("unsupported_type");
      return true;
    });
    try {
      const mark = ws.mark();
      for (const task of tasks) {
        ws.send({ type: "chat:stop_task", payload: { sessionId, taskId: task.id } });
      }
      await ws.waitFor((e) => resultFrame(e) && e.payload?.taskId === doomed, {
        from: mark,
        timeoutMs: 20_000,
      });
      const results = ws.events.slice(mark).filter(resultFrame);
      expect(results).toHaveLength(tasks.length);
      const byId = new Map(results.map((r) => [r.payload!.taskId, r.payload!.outcome]));
      expect(byId.get(doomed)).toBe("error");
      expect(byId.get(survivor)).toBe("stopping");
    } finally {
      restore();
      ws.close();
    }
  }, 40_000);

  it("refuses a REAL monitor_mcp task with `error`, not a laundered success", async () => {
    // The `error` path aimed at the task type it actually happens to. The
    // rejection itself still comes from a stub, and cannot not: this suite drives
    // the CLI runtime, which opens no managed session at all, so an unstubbed
    // call answers `gone` for every task regardless of type. What IS real here is
    // the target — a task the wire says is `monitor_mcp` / `stoppable: false` —
    // and the assertion that a refusal survives the whole server path intact
    // rather than being rounded to a success.
    const { ws, sessionId, monitor } = await withLiveTasks();
    expect(monitor.stoppable).toBe(false);
    const { restore } = stubStop(async () => {
      throw new Error("unsupported_type");
    });
    try {
      const mark = ws.mark();
      ws.send({ type: "chat:stop_task", payload: { sessionId, taskId: monitor.id } });
      const res = await ws.waitFor(resultFrame, { from: mark, timeoutMs: 20_000 });
      expect(res.payload).toMatchObject({ taskId: monitor.id, outcome: "error" });
      expect(String(res.payload!.message)).toContain("unsupported_type");
    } finally {
      restore();
      ws.close();
    }
  }, 40_000);

  it("rejects a malformed frame instead of treating empty ids as a lookup miss", async () => {
    // An empty session id would reach the fleet as a miss and answer `gone` —
    // quietly telling the user that work which is still running has stopped.
    const ws = await connectWs(port);
    try {
      for (const payload of [
        { sessionId: "", taskId: "t1" },
        { sessionId: "s1", taskId: "" },
        { sessionId: "s1" },
        {},
      ]) {
        const mark = ws.mark();
        ws.send({ type: "chat:stop_task", payload });
        const err = await ws.waitFor((e) => e.type === "chat:error", {
          from: mark,
          timeoutMs: 10_000,
        });
        expect(err.payload!.error).toBe("Unknown message");
      }
    } finally {
      ws.close();
    }
  }, 40_000);
});
