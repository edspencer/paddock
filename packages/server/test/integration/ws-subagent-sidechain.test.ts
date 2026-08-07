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
 * The first fix (#595) was made on the belief that this was LIVE-ONLY — that a
 * reload re-derives from history, which "has always filtered sidechain steps". It
 * never did (#727). `@herdctl/core` treats `isSidechain` as a whole-SESSION
 * property and drops the per-line marker from the `ChatMessage` it returns, so a
 * sidechain line written into a MAIN transcript came back out of `/messages` as a
 * first-class top-level row — three tool rows where only the `Task` card belongs,
 * rendered as SIBLINGS of the card rather than inside it.
 *
 * Asserting the invariant over WS frames alone is precisely how that shipped, so
 * this file asserts it on BOTH paths: the live frames, and the rehydrated
 * `/messages` payload the same chat serves after a reload.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SLUG = "sidechain-proj";

const isComplete = (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === SLUG;

interface HistoryRow {
  role: string;
  content: string;
  toolCall?: { toolName: string; toolUseId?: string; hasSubagent?: boolean };
}

describe("integration: a foreground sub-agent's sidechain steps never render top-level", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let sessionId: string;
  /** Index of the first WS event belonging to the one `[[SUBAGENT]]` turn. */
  let turnMark: number;

  beforeAll(async () => {
    t = await startTestApp({ script: {} });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Sidechain Proj" },
    });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);

    turnMark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: SLUG, sessionId: null, message: "[[SUBAGENT]] go" },
    });
    const complete = await ws.waitFor(isComplete, { from: turnMark });
    sessionId = complete.payload?.sessionId as string;
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("emits the Task card but no frame for the sub-agent's nested steps", () => {
    const toolFrames = ws.events
      .slice(turnMark)
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

  it("serves the same shape on rehydration: the Task row, no sidechain rows (#727)", async () => {
    expect(sessionId).toBeTruthy();
    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${SLUG}/chats/${sessionId}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const messages: HistoryRow[] = res.json().messages;

    // The launching Task survives the reload — this is the card the steps live in.
    const tasks = messages.filter((m) => m.toolCall?.toolName === "Task");
    expect(tasks.length).toBe(1);

    // …and its nested steps do not, on either the tool name or the marker text.
    const leaked = messages.filter(
      (m) => m.toolCall?.toolName === "Read" || JSON.stringify(m).includes("SIDECHAIN_STEP_"),
    );
    expect(leaked.map((m) => `${m.role}/${m.toolCall?.toolName ?? "-"}`)).toEqual([]);
  });
});
