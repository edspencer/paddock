import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * End-to-end chat over WS through the REAL @herdctl/core CLI runtime + the fake
 * `claude` binary. Proves: a turn streams assistant text over WS, the transcript
 * is written + discoverable, history hydrates on reload, and resume continues
 * the SAME session (continuity).
 *
 * The socket is shared across tests, so each turn marks the current event index
 * and waits for events AT OR AFTER that mark (events from earlier turns linger).
 */
describe("integration: chat turn over WS (real CLI runtime, fake claude)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  beforeAll(async () => {
    t = await startTestApp({
      script: {
        "Hello there": "Hi! I am the fake keeper.",
      },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Chat Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("streams an assistant reply and completes with a session id", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "chat-proj", sessionId: null, message: "Hello there" },
    });

    const complete = await ws.waitFor(isComplete("chat-proj"), { from: mark });
    expect(complete.payload?.success).toBe(true);
    const sessionId = complete.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();

    // The scripted reply streamed through as chat:response chunk(s).
    expect(ws.responseText(mark)).toContain("Hi! I am the fake keeper.");

    // The new chat now lists under the project (discovery found the transcript).
    const chats = (
      await t.app.inject({ method: "GET", url: "/api/projects/chat-proj/chats" })
    ).json().chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);

    // History hydrates from the transcript on reload: user + assistant messages.
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/chat-proj/chats/${sessionId}/messages`,
      })
    ).json().messages;
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const assistant = messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.content).toContain("Hi! I am the fake keeper.");

    // Context usage reads back from the transcript's last turn.
    const ctx = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/chat-proj/chats/${sessionId}/context`,
      })
    ).json();
    expect(ctx.usage).toBeTruthy();
    expect(ctx.usage.contextTokens).toBeGreaterThan(0);

    // Issue #116: usage is NO LONGER inlined into the chat-list payload (that
    // per-session transcript parse is what made project switching slow) — the
    // list is cheap and the ring data comes from the bulk usage endpoint keyed
    // by session id.
    expect(chats.find((c: { sessionId: string }) => c.sessionId === sessionId)).not.toHaveProperty(
      "contextTokens",
    );
    const bulk = (
      await t.app.inject({ method: "GET", url: "/api/projects/chat-proj/chats/usage" })
    ).json();
    expect(bulk.usage[sessionId]).toBeTruthy();
    expect(bulk.usage[sessionId].contextTokens).toBeGreaterThan(0);
    expect(bulk.usage[sessionId].contextLimit).toBeGreaterThan(0);
  });

  it("resume continues the SAME session (continuity is testable)", async () => {
    // Turn 1: set a codeword (built-in fake rule).
    const m1 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "chat-proj", sessionId: null, message: "the codeword is pomegranate" },
    });
    const c1 = await ws.waitFor(isComplete("chat-proj"), { from: m1 });
    const sessionId = c1.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();

    // Turn 2: RESUME that session and ask for the codeword back.
    const m2 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "chat-proj", sessionId, message: "what was the codeword?" },
    });
    const c2 = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: m2 },
    );
    expect(c2.payload?.success).toBe(true);
    // The streamed reply referenced the earlier turn.
    expect(ws.responseText(m2).toLowerCase()).toContain("pomegranate");

    // And the hydrated transcript's last assistant turn confirms continuity.
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/chat-proj/chats/${sessionId}/messages`,
      })
    ).json().messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m: { role: string }) => m.role === "assistant");
    expect(lastAssistant.content.toLowerCase()).toContain("pomegranate");
  });

  it("a one-off (scratch) chat lists under /api/chats", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "scratch", sessionId: null, message: "scratch hello" },
    });
    const complete = await ws.waitFor(isComplete("scratch"), { from: mark });
    const sessionId = complete.payload?.sessionId as string;
    const chats = (await t.app.inject({ method: "GET", url: "/api/chats" })).json().chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);
  });
});
