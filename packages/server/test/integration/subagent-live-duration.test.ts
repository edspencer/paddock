/**
 * `/messages` must not report a `subagentDurationMs` for a sub-agent that is
 * still working (issue #725, cause A).
 *
 * The field is not cosmetic: it is the client's FINISHED signal —
 * `useRunningSubagents` drops any card that carries one — and it is derived from
 * the first→last timestamp of a transcript that is still growing. Publishing it
 * early therefore does two wrong things at once: it freezes a bogus part-way
 * number onto the card, and it evicts the sub-agent from the running-sub-agents
 * bar for the rest of the run, unrecoverably (a reload re-derives from the same
 * code). The smoking gun was a "final" duration that kept climbing across polls:
 * 9211 → 11296 → 13368.
 *
 * `attachSubagentFields`' PENDING branch already knew this — #622 fixed it there,
 * and its comment states the hazard exactly. The PAIRED branch immediately below
 * kept stamping one unconditionally, and because the SDK BACKGROUNDS sub-agents,
 * the launching `Task` tool_result pairs within milliseconds while the sub-agent
 * keeps working: a live sub-agent reaches the paired branch as a matter of course.
 *
 * The sidecars here are hand-written because the state under test is a property of
 * the transcript on disk, not of any runtime: what matters is whether the file has
 * settled. Note there is NO `type: "result"` line to look for — a sub-agent
 * transcript never carries one (zero of 483 real ones did), so liveness is read
 * from a terminal assistant `end_turn` plus a staleness fallback.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SLUG = "live-duration-proj";

const isComplete = (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === SLUG;

interface HistoryRow {
  role: string;
  toolCall?: { toolName: string; toolUseId?: string; subagentDurationMs?: number };
}

/** One sub-agent transcript line, `n` seconds into the run. */
const line = (n: number, extra: Record<string, unknown>): string =>
  JSON.stringify({
    uuid: `sub-${n}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    ...extra,
  });

/** An assistant step that calls a tool — the agent loop continues after one. */
const workingStep = (n: number): string =>
  line(n, {
    type: "assistant",
    message: {
      id: `m${n}`,
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: `t${n}`, name: "Read", input: { file_path: "a.ts" } }],
    },
  });

/** The one line that means a sub-agent's loop is over. */
const endTurn = (n: number): string =>
  line(n, {
    type: "assistant",
    message: {
      id: `m${n}`,
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }],
    },
  });

describe("integration: a live sub-agent is not handed a final duration (#725 cause A)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let sessionId: string;
  let projectDir: string;
  let toolUseId: string;
  let sidecarJsonl: string;

  beforeAll(async () => {
    t = await startTestApp({ script: {} });
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Live Duration Proj" },
    });
    projectDir = (await t.projects.get(SLUG)).dir;
    ({ port } = await listen(t.app));
    ws = await connectWs(port);

    // A real turn, so the parent transcript carries a real Task tool_use that has
    // ALREADY PAIRED with its tool_result — the exact state cause A mishandles.
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: SLUG, sessionId: null, message: "[[SUBAGENT]] go" },
    });
    const complete = await ws.waitFor(isComplete, { from: mark });
    sessionId = complete.payload?.sessionId as string;
    toolUseId = (await taskRow()).toolCall!.toolUseId!;
    expect(toolUseId).toBeTruthy();

    const dir = path.join(projectDir, ".chats", sessionId, "subagents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "agent-live.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "still going", toolUseId, spawnDepth: 1 }),
      "utf8",
    );
    sidecarJsonl = path.join(dir, "agent-live.jsonl");
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  /** The rehydrated `Task` row of the chat, as `/messages` serves it. */
  async function taskRow(): Promise<HistoryRow> {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${SLUG}/chats/${sessionId}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const rows: HistoryRow[] = res.json().messages;
    const task = rows.find((m) => m.toolCall?.toolName === "Task");
    expect(task, "the Task row must survive rehydration").toBeTruthy();
    return task!;
  }

  /** Write the sub-agent transcript and stamp an explicit mtime, so "how long has
   *  this been quiet" is a fact of the fixture rather than of test timing. */
  async function writeSidecar(lines: string[], quietForMs: number): Promise<void> {
    await fs.writeFile(sidecarJsonl, lines.join("\n") + "\n", "utf8");
    const when = new Date(Date.now() - quietForMs);
    await fs.utimes(sidecarJsonl, when, when);
  }

  it("omits subagentDurationMs while the sub-agent's transcript is still growing", async () => {
    // Two timestamps 30s apart, so a duration IS computable — the point is that it
    // must not be published — and no terminal line, written just now.
    await writeSidecar([workingStep(0), workingStep(30)], 0);

    const task = await taskRow();
    expect(task.toolCall?.subagentDurationMs).toBeUndefined();
  });

  it("reports it once the transcript settles on a terminal end_turn", async () => {
    await writeSidecar([workingStep(0), workingStep(30), endTurn(45)], 0);

    const task = await taskRow();
    expect(task.toolCall?.subagentDurationMs).toBe(45_000);
  });

  it("reports it for an interrupted sub-agent whose transcript went stale", async () => {
    // No terminal line — a sub-agent whose keeper was killed mid-run never writes
    // one. Without the staleness fallback its card would claim "running" forever.
    await writeSidecar([workingStep(0), workingStep(30)], 30 * 60_000);

    const task = await taskRow();
    expect(task.toolCall?.subagentDurationMs).toBe(30_000);
  });
});
