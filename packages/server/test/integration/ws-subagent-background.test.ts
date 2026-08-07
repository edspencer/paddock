/**
 * Harness test for the `[[BGSUBAGENT]]` fake directive.
 *
 * This asserts the FAKE, not the product. It exists because the state it
 * produces — a sub-agent still running with no live parent turn holding it
 * open — could not be produced at all before, which made the #725 bug class
 * structurally untestable: a nav-away/nav-back test written on `[[SUBAGENT]]`
 * or `[[SLOWTOOL]]` PASSES while the bug is live, because a live parent turn
 * is exactly what keeps sub-agent polling alive.
 *
 * So the property under test is precisely "the parent turn ends first". If a
 * future change to the fake (or to how herdctl decides a turn is over) makes
 * the drain finish before `chat:complete`, the directive silently stops
 * reproducing the condition and every test built on it turns into a
 * false green. That is what this guards.
 *
 * The second test guards the OTHER half of that same trap, added alongside the
 * #725 cause-B client fix. Producing the on-disk state is not enough: the state
 * has to reach the client through REST in the shape the running-sub-agents bar
 * consumes. A `Task` whose sidecar is missing comes back with `hasSubagent`
 * false and is not a candidate at all, and one the server has already stamped a
 * `subagentDurationMs` onto is dropped as finished — either way a browser test
 * finds an empty bar for a reason that has nothing to do with the bug, and
 * passes for the wrong reason once the bug is fixed. So this asserts the payload
 * directly: still-running sub-agent present, expandable, NOT dated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SLUG = "bg-subagent-proj";
const SLUG2 = "bg-subagent-rest";
const WINDOW_MS = 4000;

const completeFor = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === slug;
const isComplete = completeFor(SLUG);
const isComplete2 = completeFor(SLUG2);

type Line = {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
};

async function readLines(file: string): Promise<Line[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Line);
}

const countSidechain = (lines: Line[]) => lines.filter((l) => l.isSidechain).length;

describe("integration: [[BGSUBAGENT]] produces a sub-agent that outlives its parent turn", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp({
      script: {},
      env: { PADDOCK_FAKE_BGSUBAGENT_MS: String(WINDOW_MS) },
    });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Bg Subagent Proj" },
    });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Bg Subagent Rest" },
    });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("pairs the Task before the turn ends, then keeps appending sidechain steps after it", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: SLUG, sessionId: null, message: "[[BGSUBAGENT]] go" },
    });
    const complete = await ws.waitFor(isComplete, { from: mark });

    const sessionId = complete.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();
    const file = path.join(t.projectsRoot, SLUG, ".chats", `${sessionId}.jsonl`);

    // Sampled the instant the turn reports complete.
    const atComplete = await readLines(file);
    const sidechainAtComplete = countSidechain(atComplete);

    // The terminal result must already be on disk...
    const resultIdx = atComplete.findIndex((l) => l.type === "result");
    expect(resultIdx).toBeGreaterThanOrEqual(0);

    // ...and the Task must already be paired, on the main lane, BEFORE it. That
    // pairing is what frees the turn to finish while the sub-agent runs on.
    const mainBeforeResult = atComplete.slice(0, resultIdx).filter((l) => !l.isSidechain);
    expect(mainBeforeResult.length).toBeGreaterThanOrEqual(3); // user, Task use, Task result

    // The property that matters: steps are STILL arriving after the turn ended.
    await new Promise((r) => setTimeout(r, WINDOW_MS));
    const afterWindow = await readLines(file);
    expect(countSidechain(afterWindow)).toBeGreaterThan(sidechainAtComplete);

    // And every one of them landed after the terminal result — i.e. the sub-agent
    // genuinely outlived the turn rather than merely being slow within it.
    const finalResultIdx = afterWindow.findIndex((l) => l.type === "result");
    const sidechainAfterResult = afterWindow
      .slice(finalResultIdx + 1)
      .filter((l) => l.isSidechain).length;
    expect(sidechainAfterResult).toBeGreaterThan(0);
  });

  // Its OWN project: `chat:send` with `sessionId: null` continues the keeper's
  // current session rather than starting a fresh one, so reusing SLUG here would
  // append to the first test's chat — whose sub-agent has already finished and
  // been dated, which is the exact state this test asserts the absence of.
  it("serves the sub-agent as a LIVE candidate over REST once the parent turn is done", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: SLUG2, sessionId: null, message: "[[BGSUBAGENT]] rest" },
    });
    const complete = await ws.waitFor(isComplete2, { from: mark });
    const sessionId = complete.payload?.sessionId as string;

    // The sidecar pair the real binary writes. `hasSubagent` on a paired Task is
    // "is there a meta.json naming this toolUseId", so this is load-bearing.
    const dir = path.join(t.projectsRoot, SLUG2, ".chats", sessionId, "subagents");
    const entries = await fs.readdir(dir);
    expect(entries.some((e) => e.endsWith(".meta.json"))).toBe(true);
    expect(entries.some((e) => e.endsWith(".jsonl"))).toBe(true);

    type Row = {
      toolCall?: {
        toolName?: string;
        toolUseId?: string;
        hasSubagent?: boolean;
        subagentDurationMs?: number;
      };
    };
    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${SLUG2}/chats/${sessionId}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const task = (res.json().messages as Row[]).find((m) => m.toolCall?.toolName === "Task");
    expect(task).toBeDefined();
    // Exactly the three fields `useRunningSubagents` reads. A candidate needs an
    // id and a sidecar; the ABSENCE of a duration is what keeps it in the bar.
    expect(task?.toolCall?.toolUseId).toBeTruthy();
    expect(task?.toolCall?.hasSubagent).toBe(true);
    expect(task?.toolCall?.subagentDurationMs).toBeUndefined();

    // And its own steps are readable, and still growing — the thing the client
    // polls to keep the card's step list moving after the parent turn ended.
    const toolUseId = task!.toolCall!.toolUseId!;
    const stepsUrl = `/api/projects/${SLUG2}/chats/${sessionId}/subagents/${toolUseId}/messages`;
    const stepCount = async () =>
      (await t.app.inject({ method: "GET", url: stepsUrl })).json().messages.length as number;
    // The sidecar exists from the launch but its first step lands a beat later,
    // which is itself the point: the steps arrive AFTER the turn reported done.
    await expect.poll(stepCount, { timeout: WINDOW_MS }).toBeGreaterThan(0);
    const first = await stepCount();
    await expect.poll(stepCount, { timeout: WINDOW_MS }).toBeGreaterThan(first);
  });
});
