/**
 * Layer 3 AUTOMATIC re-drive, end-to-end (issue #352).
 *
 * This is the acceptance test for "a keeper whose background task is killed at the
 * turn boundary recovers automatically". It wires the REAL {@link RecoveryEngine}
 * against the REAL app: a real project on disk, a real turn's transcript, the real
 * transcript-tail reader (no injected readTail/fileSize — it reads the actual
 * `.chats/<id>.jsonl`), and a re-drive that sends a REAL turn through the app. Then
 * it appends the exact production kill signature — a `queue-operation` enqueue of a
 * `killed` `<task-notification>` (the SDK-input-queue shape #350 taught the engine
 * to detect) — and proves the engine auto-injects the recovery nudge, which lands
 * as a real turn in the transcript.
 *
 * (The ws.ts wiring only *arms* this engine after a session-mode keeper turn; that
 * path needs the SDK runtime + a real login, so it can't run under the fake-claude
 * CLI harness. Here we drive the same engine directly against real infrastructure,
 * which is what makes the auto path demonstrable without a live model.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import { RecoveryEngine } from "../../src/recovery.js";
import { DEFAULT_RECOVERY } from "../../src/recovery-config.js";
import { RECOVERY_NUDGE } from "../../src/ws.js";
import { projectChatsDir } from "../../src/transcripts.js";

const SLUG = "autodrive-proj";
const isComplete = (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === SLUG && typeof e.payload?.sessionId === "string";
const isNudge = (text: string) => text.includes("[Paddock recovery]");

/** A `killed` <task-notification> in its input-queue (`queue-operation`) shape. */
const queueOpKill = () =>
  JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content:
      "<task-notification>\n<task-id>bg-1</task-id>\n<status>killed</status>\n" +
      "<summary>the background build</summary>\n</task-notification>",
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("integration: Layer 3 automatic re-drive end-to-end (#352)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp({ script: { "start turn": "Kicked off a background build, standing by." } });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Autodrive Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  async function userMessages(sessionId: string): Promise<string[]> {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${SLUG}/chats/${sessionId}/messages`,
    });
    const body = res.json() as
      | { messages?: Array<{ role: string; content: string }> }
      | Array<{ role: string; content: string }>;
    const msgs = Array.isArray(body) ? body : (body.messages ?? []);
    return msgs.filter((m) => m.role === "user").map((m) => m.content);
  }

  it("detects the queue-operation kill in a real transcript and auto-injects the recovery nudge", async () => {
    // 1) A real keeper turn: it "starts a background task" and ends. Now idle, its
    //    transcript ends in assistant activity (the normal, healthy end-of-turn).
    const m1 = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: null, message: "start turn" } });
    const sessionId = (await ws.waitFor(isComplete, { from: m1 })).payload?.sessionId as string;
    expect(sessionId).toBeTruthy();

    // 2) Wire the real engine exactly as ws.ts does, but with a re-drive that sends
    //    a REAL turn through the app (the nudge, resuming this session) so we can
    //    prove it lands. autoReDrive ON; tight guards for a fast, deterministic test.
    let reDrives = 0;
    const engine = new RecoveryEngine({
      cfg: { recovery: { ...DEFAULT_RECOVERY, autoReDrive: true, debounceMs: 200 } },
      getProject: (slug) => t.projects.get(slug),
      reDrive: async (_project, sid) => {
        reDrives += 1;
        // The real re-drive: inject the recovery nudge as a resume turn. Wait for it
        // to complete so the assertion sees the landed transcript entry.
        const mk = ws.mark();
        ws.send({ type: "chat:send", payload: { projectSlug: SLUG, sessionId: sid, message: RECOVERY_NUDGE } });
        await ws.waitFor((e) => isComplete(e) && e.payload?.sessionId === sid, { from: mk });
      },
      pollMs: 40,
      killGraceMs: 4000,
    });

    // Sanity: before the kill, the transcript has NO recovery nudge.
    expect((await userMessages(sessionId)).filter(isNudge)).toHaveLength(0);

    // 3) Arm the post-turn watch on the real transcript, then let the runtime's
    //    turn-boundary kill land — as the SDK writes it: a queue-operation enqueue
    //    of a `killed` task-notification (NOT a type:"user" entry). Append AFTER the
    //    arm-time EOF baseline is taken so the tail sees it as a new line.
    engine.armWatch({ slug: SLUG, sessionId });
    await sleep(150); // let armWatch take its stat baseline + start polling
    const file = path.join(projectChatsDir((await t.projects.get(SLUG)).dir), `${sessionId}.jsonl`);
    await fs.appendFile(file, queueOpKill() + "\n", "utf8");

    // 4) The engine detects the hung signature past the debounce and auto-re-drives.
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (reDrives > 0) break;
      if (Date.now() >= deadline) break;
      await sleep(100);
    }
    expect(reDrives).toBe(1);

    // The recovery nudge landed as a real user turn in the real transcript — the
    // keeper was woken automatically, with no human in the loop.
    expect((await userMessages(sessionId)).filter(isNudge)).toHaveLength(1);
    // The watch fired exactly once and cleaned itself up.
    expect(engine.isWatching(sessionId)).toBe(false);
    expect(engine.retryCountFor(sessionId)).toBe(1);
    engine.stopAll();
  });
});
