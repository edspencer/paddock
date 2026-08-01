/**
 * A FOREGROUND sub-agent must not scatter its steps into the parent transcript.
 *
 * Under SDK streaming mode a synchronous `Task` streams its nested steps INLINE
 * on the PRIMARY turn stream, each tagged `parent_tool_use_id` (isSidechain).
 * Only the background sink filtered those, on the belief — recorded in a comment
 * and since disproved live — that herdctl routed a foreground Task's steps to a
 * separate sidechain session that "never" reached the main stream. It does, so
 * every step of a foreground sub-agent rendered TWICE: once inside the sub-agent
 * card (correct, via the subagents endpoint) and once as a top-level row of the
 * parent (wrong).
 *
 * The bug was live-only — a reload re-derives from history, which has always
 * filtered sidechain steps — so it healed on refresh and read as a stream glitch.
 * That is exactly why this test asserts over WS FRAMES rather than the persisted
 * transcript: the persisted view was never broken.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SLUG = "sidechain-proj";

const isComplete = (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === SLUG;

describe("integration: a foreground sub-agent's sidechain steps never render top-level", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp({ script: {} });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Sidechain Proj" },
    });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("emits the Task card but no frame for the sub-agent's nested steps", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: SLUG, sessionId: null, message: "[[SUBAGENT]] go" },
    });
    await ws.waitFor(isComplete, { from: mark });

    const toolFrames = ws.events
      .slice(mark)
      .filter((e) => e.type === "chat:tool_start" || e.type === "chat:tool_call");

    // The launching Task itself is main-lane and MUST still render.
    const taskFrames = toolFrames.filter((e) => e.payload?.toolName === "Task");
    expect(taskFrames.length).toBeGreaterThan(0);

    // Its nested steps must not appear as top-level rows. The fake names them
    // `Read` with a marker file_path, so any leak is unambiguous.
    const leaked = toolFrames.filter(
      (e) =>
        e.payload?.toolName === "Read" ||
        JSON.stringify(e.payload ?? {}).includes("SIDECHAIN_STEP_"),
    );
    expect(leaked).toEqual([]);
  });
});
