/**
 * WebSocket transport coverage gaps (ws.ts). The chat.test.ts suite covers the
 * happy path (send → stream → complete) + resume; this file fills the branches:
 *
 *   - ping → pong
 *   - invalid JSON → chat:error "Invalid JSON"
 *   - unknown / malformed message → chat:error "Unknown message"
 *   - the onChatSend catch path → chat:error (unknown project slug throws)
 *   - preloadContext: a NEW project chat with an OVERVIEW.md prepends it
 *   - per-chat model override → ensureKeeperModel / ensureScratchModel
 *   - message_boundary emitted around the assistant turn
 *   - chat:cancel (best-effort; no crash, no response)
 *   - usage/model surfaced on chat:complete
 *
 * Everything runs through the REAL app + the fake claude. A shared socket scopes
 * each turn via mark()/waitFor({ from }).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

describe("integration: WS transport edge cases (real app, fake claude)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp({
      script: {
        "Hello there": "Hi! I am the fake keeper.",
        "primed question": "Primed answer.",
      },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "WS Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  // --- protocol-level messages ------------------------------------------------

  it("responds to ping with pong", async () => {
    const mark = ws.mark();
    ws.send({ type: "ping" });
    const pong = await ws.waitFor((e) => e.type === "pong", { from: mark });
    expect(pong.type).toBe("pong");
  });

  it("rejects invalid JSON with chat:error 'Invalid JSON'", async () => {
    const mark = ws.mark();
    // A raw, un-serialized frame the server cannot JSON.parse.
    ws.sendRaw("this is not json {");
    const err = await ws.waitFor((e) => e.type === "chat:error", { from: mark });
    expect(err.payload?.error).toBe("Invalid JSON");
  });

  it("rejects an unknown message shape with chat:error 'Unknown message'", async () => {
    const mark = ws.mark();
    ws.send({ type: "chat:bogus", payload: {} });
    const err = await ws.waitFor((e) => e.type === "chat:error", { from: mark });
    expect(err.payload?.error).toBe("Unknown message");
  });

  it("rejects a chat:send with a non-string message (Unknown message)", async () => {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: "ws-proj", message: 42 } });
    const err = await ws.waitFor((e) => e.type === "chat:error", { from: mark });
    expect(err.payload?.error).toBe("Unknown message");
  });

  // --- the onChatSend catch path ---------------------------------------------

  it("emits chat:error when the target project does not exist", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "no-such-project", sessionId: null, message: "hi" },
    });
    const err = await ws.waitFor(
      (e) => e.type === "chat:error" && e.payload?.projectSlug === "no-such-project",
      { from: mark },
    );
    expect(String(err.payload?.error)).toMatch(/not found/i);
    // It also carries the legacy `target` alias.
    expect(err.payload?.target).toBe("no-such-project");
  });

  // --- happy path: usage on complete -----------------------------------------

  it("streams text and surfaces usage+model on complete", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId: null, message: "Hello there" },
    });
    const complete = await ws.waitFor(isComplete("ws-proj"), { from: mark });
    expect(complete.payload?.success).toBe(true);
    expect(ws.responseText(mark)).toContain("Hi! I am the fake keeper.");

    // usage + model present (the fake emits a usage block).
    expect(complete.payload?.model).toBeTruthy();
    const usage = complete.payload?.usage as Record<string, number>;
    expect(usage.contextTokens).toBeGreaterThan(0);
    // Default keeper model is Opus 5 → 1M context window.
    expect(usage.contextLimit).toBe(1_000_000);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  // --- tool_call + message_boundary (fake directives) ------------------------

  it("surfaces a chat:tool_call when the turn uses a tool", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId: null, message: "do a thing [[TOOL]]" },
    });
    await ws.waitFor(isComplete("ws-proj"), { from: mark });
    const toolCall = ws.events
      .slice(mark)
      .find((e) => e.type === "chat:tool_call" && e.payload?.projectSlug === "ws-proj");
    expect(toolCall).toBeTruthy();
    expect(toolCall?.payload?.toolName).toBe("Read");
    expect(toolCall?.payload?.isError).toBe(false);
  });

  it("emits a chat:message_boundary between two assistant text runs", async () => {
    // Resume an existing session for the boundary turn: the transcript file
    // already exists, so the runtime's watcher attaches reliably and reads the
    // two assistant lines as the boundary turn (a brand-new session occasionally
    // races the watcher's first read under full-file load).
    const m0 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId: null, message: "boundary setup turn" },
    });
    const c0 = await ws.waitFor(isComplete("ws-proj"), { from: m0 });
    const sessionId = c0.payload?.sessionId as string;

    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId, message: "two parts please [[BOUNDARY]]" },
    });
    await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: mark },
    );
    const boundary = ws.events
      .slice(mark)
      .find((e) => e.type === "chat:message_boundary" && e.payload?.projectSlug === "ws-proj");
    expect(boundary).toBeTruthy();
  });

  // --- preloadContext (dedicated project to avoid sweeper session noise) ------

  it("preloadContext prepends the project OVERVIEW.md AND CHANGELOG.md for a NEW chat", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Preload Proj" } });
    // Seed an overview + a changelog the keeper should be primed with (issue #188:
    // the cross-session narrative must reach the chat, not just current state).
    await t.projects.writeOverview("preload-proj", "OVERVIEW: the secret is 'velvet'.");
    await t.projects.writeChangelog("preload-proj", "## 2026-07-21\n- shipped the tangerine feature");

    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "preload-proj",
        sessionId: null,
        message: "primed question",
        preloadContext: true,
      },
    });
    const complete = await ws.waitFor(isComplete("preload-proj"), { from: mark });
    const sessionId = complete.payload?.sessionId as string;

    // The transcript's first user message must contain the injected context
    // block with BOTH docs (the fake records the exact prompt it got on stdin).
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/preload-proj/chats/${sessionId}/messages`,
      })
    ).json().messages;
    const firstUser = messages.find((m: { role: string }) => m.role === "user");
    expect(firstUser.content).toContain("<project-context>");
    expect(firstUser.content).toContain("velvet"); // overview
    expect(firstUser.content).toContain("tangerine"); // changelog (issue #188)
    expect(firstUser.content).toContain("My request:");
    expect(firstUser.content).toContain("primed question");
  });

  it("preloadContext is a no-op for a NEW chat when the project has no overview", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "No Overview Proj" } });
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "no-overview-proj",
        sessionId: null,
        message: "no overview here",
        preloadContext: true,
      },
    });
    const complete = await ws.waitFor(isComplete("no-overview-proj"), { from: mark });
    const sessionId = complete.payload?.sessionId as string;
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/no-overview-proj/chats/${sessionId}/messages`,
      })
    ).json().messages;
    const firstUser = messages.find((m: { role: string }) => m.role === "user");
    expect(firstUser.content).not.toContain("<project-context>");
    expect(firstUser.content).toBe("no overview here");
  });

  // --- per-chat model override -----------------------------------------------

  it("a valid project model override re-registers the keeper at that model", async () => {
    const spy = vi.spyOn(t.herdctl, "ensureKeeperModel");
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "ws-proj",
        sessionId: null,
        message: "model override turn",
        model: "claude-sonnet-5",
      },
    });
    const complete = await ws.waitFor(isComplete("ws-proj"), { from: mark });
    expect(complete.payload?.success).toBe(true);
    // ensureKeeperModel was called with the requested (valid) model.
    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe("claude-sonnet-5");
    spy.mockRestore();
  });

  it("an UNKNOWN project model override falls back to the project's model", async () => {
    const spy = vi.spyOn(t.herdctl, "ensureKeeperModel");
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "ws-proj",
        sessionId: null,
        message: "bad model turn",
        model: "gpt-4-not-a-claude-model",
      },
    });
    await ws.waitFor(isComplete("ws-proj"), { from: mark });
    // Falls back to the project's persisted model (Opus default), NOT the bogus id.
    const lastCall = spy.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe("claude-opus-5");
    spy.mockRestore();
  });

  // --- chat:cancel ------------------------------------------------------------

  it("chat:cancel is accepted (best-effort) and never crashes the socket", async () => {
    const cancelSpy = vi.spyOn(t.herdctl, "cancel");
    const mark = ws.mark();
    ws.send({ type: "chat:cancel", payload: { jobId: "job-does-not-exist" } });
    // No direct response — assert via the delegated call + that the socket still
    // works afterward (ping/pong).
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith("job-does-not-exist"));
    ws.send({ type: "ping" });
    const pong = await ws.waitFor((e) => e.type === "pong", { from: mark });
    expect(pong.type).toBe("pong");
    cancelSpy.mockRestore();
  });

  it("a chat:cancel with a non-string jobId is rejected (Unknown message)", async () => {
    const mark = ws.mark();
    ws.send({ type: "chat:cancel", payload: { jobId: 123 } });
    const err = await ws.waitFor((e) => e.type === "chat:error", { from: mark });
    expect(err.payload?.error).toBe("Unknown message");
  });

  // --- the `target` alias (legacy clients) -----------------------------------

  it("accepts the legacy `target` field as a projectSlug alias", async () => {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { target: "ws-proj", sessionId: null, message: "via target" } });
    const complete = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === "ws-proj",
      { from: mark },
    );
    expect(complete.payload?.success).toBe(true);
  });

  // --- #380: a dead-end notice is suppressed once a complete reply streamed -----
  // The live path (this transport) surfaces the SDK's terminal `result` failure in
  // real time — which in session mode can arrive AFTER a good `end_turn` reply
  // already streamed, painting a false "turn failed" banner. The history path (on
  // reload) already clears it via "a real reply supersedes the notice"; the live
  // path must apply the same guard. The fake drives a reply-then-error result via
  // [[REPLYERROR]] / [[REPLYMAXTURNS]].

  const noticeIn = (mark: number, slug: string) =>
    ws.events.slice(mark).find((e) => e.type === "chat:notice" && e.payload?.projectSlug === slug);

  it("emits NO error notice when an error result follows a completed reply ([[REPLYERROR]])", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId: null, message: "keep going [[REPLYERROR]]" },
    });
    await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === "ws-proj",
      { from: mark },
    );
    // The reply rendered...
    expect(ws.responseText(mark)).toContain("Acknowledged:");
    // ...and NO dead-end banner was surfaced beneath it (the #380 fix).
    expect(noticeIn(mark, "ws-proj")).toBeUndefined();
  });

  it("emits NO error notice on a tool-heavy turn (prose on a tool_use msg, thinking-only terminal) then error ([[TOOLREPLYERROR]], #394)", async () => {
    // The #380 residual: the visible prose rides on a message that ALSO makes a
    // tool call (`stop_reason:"tool_use"`), the terminal `end_turn` message is
    // thinking-only (zero text), THEN an `error_during_execution` result arrives.
    // The old predicate (text + `end_turn` on ONE message) never flipped
    // `producedReply`, so the benign error painted a false banner. The reply must
    // stream with NO notice beneath it.
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId: null, message: "read the notes [[TOOLREPLYERROR]]" },
    });
    await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === "ws-proj",
      { from: mark },
    );
    expect(ws.responseText(mark)).toContain("Acknowledged:");
    expect(noticeIn(mark, "ws-proj")).toBeUndefined();
  });

  it("emits NO max_turns notice when a max_turns result follows a completed reply ([[REPLYMAXTURNS]])", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId: null, message: "do a lot [[REPLYMAXTURNS]]" },
    });
    await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === "ws-proj",
      { from: mark },
    );
    expect(ws.responseText(mark)).toContain("Acknowledged:");
    expect(noticeIn(mark, "ws-proj")).toBeUndefined();
  });

  it("STILL emits an error notice when the error result has NO preceding reply ([[APIERROR]])", async () => {
    // The guard must not over-suppress: a genuinely dead turn (no reply produced)
    // keeps its error banner.
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "ws-proj", sessionId: null, message: "trigger a failure [[APIERROR]]" },
    });
    await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === "ws-proj",
      { from: mark },
    );
    const notice = noticeIn(mark, "ws-proj");
    expect(notice).toBeTruthy();
    expect((notice?.payload?.notice as { kind?: string })?.kind).toBe("error");
  });

  // --- #404: the queue-drain machinery the fix gates -----------------------------
  // Exercises the end-to-end flow the #404 gate routes through: a message queued
  // WHILE a turn is running is stored (not drained on set), then flushed +
  // re-dispatched when the turn completes. The turn here uses [[SLOWTOOL]] to stay
  // open long enough to queue mid-turn, and [[REPLYERROR]] to end on the exact
  // reply-then-error shape #404 targets.
  //
  // HONEST SCOPE: this batch harness reports `result.success === true` (batch
  // derives success from the CLI job exit, not the terminal result subtype), so it
  // does NOT exercise the `result.success === false` branch the fix corrects — that
  // false signal only arises on the SESSION runtime (`chatSession` →
  // `consumeResumedTurn` → `isErrorResult`). That branch is guarded by the
  // `turnEffectivelySucceeded` unit tests and live-validated on a real session-mode
  // server. What this guards is the drain FLOW itself (store → `chat:queued_flushed`
  // → re-dispatch), which the fix's gate is the entry point to.

  it("flushes a mid-turn queued message after the turn completes ([[SLOWTOOL]] [[REPLYERROR]], #404 flow)", async () => {
    const prevSlow = process.env.PADDOCK_FAKE_SLOWTOOL_MS;
    process.env.PADDOCK_FAKE_SLOWTOOL_MS = "1500";
    try {
      // 1) Establish a session id to queue against.
      const m0 = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: "ws-proj", sessionId: null, message: "prime the session" },
      });
      const primed = await ws.waitFor(isComplete("ws-proj"), { from: m0 });
      const sessionId = primed.payload?.sessionId as string;
      expect(typeof sessionId).toBe("string");

      // 2) Start a slow turn that produces a reply then an error result.
      const mark = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: "ws-proj", sessionId, message: "work [[SLOWTOOL]] [[REPLYERROR]]" },
      });
      // Wait until the turn is demonstrably running (its slow tool started) so the
      // queue is STORED (turn running) rather than drained on set (the idle path).
      await ws.waitFor(
        (e) => e.type === "chat:tool_start" && e.payload?.projectSlug === "ws-proj",
        { from: mark },
      );

      // 3) Queue a follow-up mid-turn.
      ws.send({
        type: "chat:set_queue",
        payload: { projectSlug: "ws-proj", sessionId, text: "the queued follow-up", ts: 1 },
      });

      // 4) The turn completes, and the drain flushes the queued message (text carried
      // on the frame) then re-dispatches it as its own turn.
      const flushed = await ws.waitFor(
        (e) =>
          e.type === "chat:queued_flushed" &&
          e.payload?.sessionId === sessionId &&
          e.payload?.text === "the queued follow-up",
        { from: mark, timeoutMs: 10000 },
      );
      expect(flushed.payload?.text).toBe("the queued follow-up");

      // The re-dispatched follow-up turn runs and completes cleanly.
      const followUp = await ws.waitFor(
        (e) =>
          e.type === "chat:complete" &&
          e.payload?.projectSlug === "ws-proj" &&
          e.payload?.sessionId === sessionId &&
          e.payload?.success === true,
        { from: mark, timeoutMs: 10000 },
      );
      expect(followUp.payload?.success).toBe(true);
    } finally {
      if (prevSlow === undefined) delete process.env.PADDOCK_FAKE_SLOWTOOL_MS;
      else process.env.PADDOCK_FAKE_SLOWTOOL_MS = prevSlow;
    }
  });
});
