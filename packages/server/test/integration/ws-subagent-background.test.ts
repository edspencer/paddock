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
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SLUG = "bg-subagent-proj";
const WINDOW_MS = 2000;

const isComplete = (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === SLUG;

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
});
