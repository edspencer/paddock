/**
 * WS active-turn signal (issues #52/#53). The server broadcasts a `chat:active`
 * frame when a session's turn starts and stops, so clients can restore the Stop
 * button (#52) and drive the in-chat + sidebar streaming indicators (#53). Here
 * we assert an end-to-end turn emits both transitions to a connected socket.
 *
 * Each test uses its own project to avoid the cross-test sweep race (see
 * ws-reattach.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";

describe("integration: WS active-turn signal (issues #52/#53)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({
      script: { "Hello there": "Hi! I am the fake keeper." },
      sweepIntervalMs: 600_000,
    });
    ({ port } = await listen(t.app));
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function freshProject(): Promise<string> {
    const name = `Active ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  const active = (slug: string, running: boolean) => (e: WsEvent) =>
    e.type === "chat:active" &&
    e.payload?.projectSlug === slug &&
    e.payload?.running === running &&
    typeof e.payload?.sessionId === "string";

  it("broadcasts chat:active running:true then running:false across a turn", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      const mark = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "Hello there" } });

      const started = await ws.waitFor(active(slug, true), { from: mark });
      const sid = started.payload!.sessionId as string;

      const stopped = await ws.waitFor(
        (e) => active(slug, false)(e) && e.payload?.sessionId === sid,
        { from: mark },
      );
      expect(stopped.payload?.sessionId).toBe(sid);
      // The running:true came before running:false.
      const idxTrue = ws.events.findIndex(
        (e) => e.type === "chat:active" && e.payload?.sessionId === sid && e.payload?.running === true,
      );
      const idxFalse = ws.events.findIndex(
        (e) => e.type === "chat:active" && e.payload?.sessionId === sid && e.payload?.running === false,
      );
      expect(idxTrue).toBeGreaterThanOrEqual(mark);
      expect(idxFalse).toBeGreaterThan(idxTrue);
    } finally {
      ws.close();
    }
  });

  it("a socket connecting AFTER a turn has ended gets no running snapshot for it", async () => {
    const slug = await freshProject();
    const a = await connectWs(port);
    try {
      const mark = a.mark();
      a.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "Hello there" } });
      await a.waitFor(active(slug, false), { from: mark }); // turn fully done

      // A fresh socket sees no active sessions (nothing is running now).
      const b = await connectWs(port);
      try {
        const bMark = b.mark();
        b.send({ type: "ping" });
        await b.waitFor((e) => e.type === "pong", { from: bMark });
        const actives = b.events.slice(bMark).filter((e) => e.type === "chat:active");
        expect(actives).toHaveLength(0);
      } finally {
        b.close();
      }
    } finally {
      a.close();
    }
  });
});
