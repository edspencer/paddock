/**
 * WS permission prompts (#971), over a real socket.
 *
 * The fake `claude` runs the CLI runtime, which never calls the prompt tool, so
 * `herdctl.chat` is stubbed with a turn that emits one tool_use and then hangs
 * until it is released or cancelled. The test then calls the injected prompt
 * server's handler exactly as the CLI would, and drives everything else — the
 * level and edge frames, answers, Stop, turn end, connect-time replay — through
 * the real handler.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { InjectedMcpServerDef, SDKMessage, TriggerResult } from "@herdctl/core";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import type { ChatTurnOptions } from "../../src/herdctl.js";
import { PERMISSION_PROMPT_SERVER_KEY } from "../../src/permission-prompt-mcp.js";

type ToolResult = { content: Array<{ type: string; text: string }> };

describe("integration: WS permission prompts (#971)", () => {
  let t: TestApp;
  let port: number;
  let n = 0;
  const sockets: WsClient[] = [];
  let release: (() => void) | null = null;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    ({ port } = await listen(t.app));
  });
  afterEach(() => {
    release?.();
    release = null;
    for (const s of sockets.splice(0)) s.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await t.teardown();
  });

  const permissionsFrame = (sessionId: string) => (e: WsEvent) =>
    e.type === "chat:permissions" && e.payload?.sessionId === sessionId;

  async function socket(): Promise<WsClient> {
    const ws = await connectWs(port);
    sockets.push(ws);
    return ws;
  }

  /**
   * Start a turn that emits a Write tool_use and then waits, and park a prompt
   * for that call through the injected server. Returns the pending tool result.
   */
  async function parkedPrompt() {
    const name = `Perm ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const sessionId = `sess-perm-${n}`;
    const jobId = `job-perm-${n}`;
    const released = new Promise<void>((r) => (release = r));
    let opts: ChatTurnOptions | null = null;
    const started = new Promise<void>((ready) => {
      vi.spyOn(t.herdctl, "chat").mockImplementation(async (agentName, o) => {
        opts = o;
        o.onJobCreated?.(jobId);
        await o.onMessage?.({
          type: "assistant",
          session_id: sessionId,
          message: {
            model: "claude-opus-5",
            content: [
              { type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "/tmp/x" } },
            ],
          },
        } as unknown as SDKMessage);
        ready();
        await released;
        return {
          jobId,
          agentName,
          scheduleName: null,
          startedAt: new Date().toISOString(),
          success: true,
          sessionId,
        } as TriggerResult;
      });
    });
    vi.spyOn(t.herdctl, "cancel").mockImplementation(async () => {
      release?.();
      return true;
    });

    const ws = await socket();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "go" } });
    await started;
    const server = opts!.injectedMcpServers![PERMISSION_PROMPT_SERVER_KEY] as InjectedMcpServerDef;
    expect(server, "the human turn was not given the prompt server").toBeDefined();
    const result = server.tools[0]
      .handler({ tool_name: "Write", input: { file_path: "/tmp/x" }, tool_use_id: "toolu_w" })
      .then((r) => JSON.parse((r as ToolResult).content[0].text));
    const frame = await ws.waitFor(
      (e) => permissionsFrame(sessionId)(e) && (e.payload?.requests as unknown[]).length === 1,
    );
    const [request] = frame.payload!.requests as Array<{ id: string; toolUseId: string }>;
    return { ws, slug, sessionId, jobId, request, result };
  }

  it("routes an answer to the waiting call, then treats a replay of it as a no-op", async () => {
    const { ws, sessionId, request, result } = await parkedPrompt();
    expect(request.toolUseId).toBe("toolu_w");

    ws.send({ type: "chat:permission_answer", payload: { sessionId, id: request.id, answer: "once" } });
    expect(await result).toMatchObject({ behavior: "allow" });
    const decision = await ws.waitFor((e) => e.type === "chat:permission_decision");
    expect(decision.payload!.decision).toMatchObject({ toolUseId: "toolu_w", outcome: "once" });
    await ws.waitFor(
      (e) => permissionsFrame(sessionId)(e) && (e.payload?.requests as unknown[]).length === 0,
    );

    // Another tab's late click on the same card, and one for the wrong chat.
    const mark = ws.mark();
    ws.send({ type: "chat:permission_answer", payload: { sessionId, id: request.id, answer: "deny" } });
    ws.send({
      type: "chat:permission_answer",
      payload: { sessionId: "other", id: request.id, answer: "deny" },
    });
    ws.send({ type: "ping" });
    await ws.waitFor((e) => e.type === "pong", { from: mark });
    const after = ws.events.slice(mark).map((e) => e.type);
    expect(after).not.toContain("chat:permissions");
    expect(after).not.toContain("chat:permission_decision");
  });

  it("cancels the prompt when the turn is stopped", async () => {
    const { ws, jobId, result } = await parkedPrompt();
    ws.send({ type: "chat:cancel", payload: { jobId } });
    expect(await result).toEqual({
      behavior: "deny",
      message: "Permission request cancelled (the turn was stopped).",
    });
  });

  it("cancels the prompt when the turn ends", async () => {
    const { result } = await parkedPrompt();
    release!();
    expect(await result).toEqual({
      behavior: "deny",
      message: "Permission request cancelled (the turn ended).",
    });
  });

  it("replays what is pending to a socket that connects while it waits", async () => {
    const { sessionId, slug, request } = await parkedPrompt();
    const late = await socket();
    const replay = await late.waitFor(permissionsFrame(sessionId));
    expect(replay.payload).toMatchObject({ projectSlug: slug, sessionId });
    expect((replay.payload!.requests as Array<{ id: string }>).map((r) => r.id)).toEqual([
      request.id,
    ]);
  });
});
