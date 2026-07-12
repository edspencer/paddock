/**
 * The chat DTO carries `lastTurnCompletedAt` (issue #160) — the ISO timestamp of
 * the last turn the agent FINISHED, sourced cheaply from herdctl's job-metadata
 * records (NOT the transcript mtime, which also ticks on the user's own sends).
 * It's the server signal behind the unread affordance (and reused per-project by
 * #161). Runs a REAL turn so a completed job record with session_id + finished_at
 * exists, then asserts both chat-list endpoints surface it.
 *
 * Each test uses its own project to avoid a curation sweep racing the keeper turn
 * on a shared chat dir (see chat-names.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

describe("integration: chat DTO exposes lastTurnCompletedAt (issue #160)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  async function freshProject(): Promise<string> {
    const name = `Unread ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  it("populates lastTurnCompletedAt after a turn completes (both chat endpoints)", async () => {
    const slug = await freshProject();
    const before = Date.now();
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "hello there" },
    });
    const complete = await ws.waitFor(isComplete(slug), { from: mark });
    const sessionId = complete.payload!.sessionId as string;

    // GET /chats
    const listChat = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })
    )
      .json()
      .chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(listChat).toBeTruthy();
    expect(typeof listChat.lastTurnCompletedAt).toBe("string");
    const ts = Date.parse(listChat.lastTurnCompletedAt);
    expect(Number.isFinite(ts)).toBe(true);
    // The completion time is around when the turn ran (allow generous slack).
    expect(ts).toBeGreaterThanOrEqual(before - 60_000);

    // GET /api/projects/:slug (enriched detail) carries it too.
    const detailChat = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}` }))
      .json()
      .chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(typeof detailChat.lastTurnCompletedAt).toBe("string");
  });
});
