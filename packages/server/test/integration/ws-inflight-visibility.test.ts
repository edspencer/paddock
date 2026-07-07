/**
 * In-flight chat visibility (issue #100).
 *
 * A brand-new chat used to be invisible in the project sidebar until its first
 * keeper turn's `claude -p` process exited: herdctl writes the resolved
 * `session_id` into a run's job record only on completion, so while the first
 * turn runs the session is unattributed and `getAgentSessions` filters it out of
 * `listSessions`.
 *
 * The fix attributes the session to its keeper the moment its id first streams
 * back (`HerdctlService.attributeRunningSession`, called from ws.ts), so the chat
 * lists mid-turn. Here we drive it end-to-end against the REAL FleetManager + CLI
 * runtime: the fake `claude` streams its reply then HANGS (never writes a result
 * line), so the turn stays running with no natural completion — and we assert the
 * chat is already in `GET /chats` while that turn is still live, then cancel.
 *
 * Each test uses its own project to avoid the cross-test sweep race (see
 * ws-reattach.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsEvent } from "../helpers/ws.js";

describe("integration: in-flight chat visibility (issue #100)", () => {
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
    const name = `Inflight ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  const chatIds = async (slug: string): Promise<string[]> => {
    const body = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })
    ).json();
    return (body.chats as Array<{ sessionId: string }>).map((c) => c.sessionId);
  };

  it("lists a new chat in the sidebar WHILE its first turn is still running", async () => {
    const slug = await freshProject();
    const ws = await connectWs(port);
    try {
      // Before any turn, the project has no chats.
      expect(await chatIds(slug)).toHaveLength(0);

      const mark = ws.mark();
      // [[HANG]] streams the reply (so the session id resolves) then blocks
      // without finishing — the turn keeps running until we interrupt it.
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "start a long job [[HANG]]" },
      });

      // Wait until the turn is live and its session id is known (running:true is
      // broadcast only after the id resolves — and, with the fix, only after the
      // session has been attributed to the keeper).
      const running = await ws.waitFor(
        (e: WsEvent) =>
          e.type === "chat:active" &&
          e.payload?.projectSlug === slug &&
          e.payload?.running === true &&
          typeof e.payload?.sessionId === "string" &&
          typeof e.payload?.jobId === "string",
        { from: mark },
      );
      const sid = running.payload!.sessionId as string;
      const jobId = running.payload!.jobId as string;

      // The turn has NOT completed on its own (the fake never wrote a result line).
      expect(
        ws.events
          .slice(mark)
          .some((e) => e.type === "chat:complete" && e.payload?.projectSlug === slug),
      ).toBe(false);

      // The crux of #100: the chat is discoverable in the sidebar list RIGHT NOW,
      // mid-turn — not only after the turn completes.
      expect(await chatIds(slug)).toContain(sid);

      // Clean up: interrupt the hanging turn.
      const cancelMark = ws.mark();
      ws.send({ type: "chat:cancel", payload: { jobId } });
      await ws.waitFor(
        (e: WsEvent) => e.type === "chat:complete" && e.payload?.projectSlug === slug,
        { from: cancelMark, timeoutMs: 15_000 },
      );

      // And it remains listed after the turn ends (herdctl's own completion record
      // reconciles to the same session id / keeper — no duplicate, no disappearance).
      expect(await chatIds(slug)).toContain(sid);
    } finally {
      ws.close();
    }
  });
});
