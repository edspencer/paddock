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
    // Default keeper model is Opus 4.8 → 1M context window.
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

  it("preloadContext prepends the project OVERVIEW.md for a NEW chat", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Preload Proj" } });
    // Seed an overview the keeper should be primed with.
    await t.projects.writeOverview("preload-proj", "OVERVIEW: the secret is 'velvet'.");

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

    // The transcript's first user message must contain the injected overview
    // block (the fake records the exact prompt it received on stdin).
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/preload-proj/chats/${sessionId}/messages`,
      })
    ).json().messages;
    const firstUser = messages.find((m: { role: string }) => m.role === "user");
    expect(firstUser.content).toContain("<project-context>");
    expect(firstUser.content).toContain("velvet");
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

  it("preloadContext is a no-op for scratch (no project overview)", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "scratch",
        sessionId: null,
        message: "scratch no preload",
        preloadContext: true,
      },
    });
    const complete = await ws.waitFor(isComplete("scratch"), { from: mark });
    const sessionId = complete.payload?.sessionId as string;
    const messages = (
      await t.app.inject({ method: "GET", url: `/api/chats/${sessionId}/messages` })
    ).json().messages;
    const firstUser = messages.find((m: { role: string }) => m.role === "user");
    expect(firstUser.content).not.toContain("<project-context>");
    expect(firstUser.content).toBe("scratch no preload");
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
        model: "claude-sonnet-4-6",
      },
    });
    const complete = await ws.waitFor(isComplete("ws-proj"), { from: mark });
    expect(complete.payload?.success).toBe(true);
    // ensureKeeperModel was called with the requested (valid) model.
    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe("claude-sonnet-4-6");
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
    expect(lastCall?.[1]).toBe("claude-opus-4-8");
    spy.mockRestore();
  });

  it("a valid scratch model override re-registers the scratch agent", async () => {
    const spy = vi.spyOn(t.herdctl, "ensureScratchModel");
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "scratch",
        sessionId: null,
        message: "scratch model override",
        model: "claude-sonnet-4-6",
      },
    });
    await ws.waitFor(isComplete("scratch"), { from: mark });
    expect(spy).toHaveBeenCalledWith("claude-sonnet-4-6");
    spy.mockRestore();
  });

  it("an unknown scratch model override does NOT call ensureScratchModel", async () => {
    const spy = vi.spyOn(t.herdctl, "ensureScratchModel");
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "scratch",
        sessionId: null,
        message: "scratch bad model",
        model: "gpt-4",
      },
    });
    await ws.waitFor(isComplete("scratch"), { from: mark });
    expect(spy).not.toHaveBeenCalled();
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
    ws.send({ type: "chat:send", payload: { target: "scratch", sessionId: null, message: "via target" } });
    const complete = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === "scratch",
      { from: mark },
    );
    expect(complete.payload?.success).toBe(true);
  });
});
