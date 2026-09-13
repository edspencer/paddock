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

  it("caps the transcript to the trailing ?limit= messages, and is uncapped without it (#914)", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "chat-proj", sessionId: null, message: "cap me" },
    });
    const complete = await ws.waitFor(isComplete("chat-proj"), { from: mark });
    const sessionId = complete.payload?.sessionId as string;
    const url = `/api/projects/chat-proj/chats/${sessionId}/messages`;

    // No param ⇒ the whole transcript. This is the published contract every
    // non-SPA consumer relies on, so it must NOT pick up the instance default.
    const full = (await t.app.inject({ method: "GET", url })).json();
    expect(full.messages.length).toBeGreaterThan(1);
    expect(full.truncated).toBe(false);
    expect(full.total).toBe(full.messages.length);

    // ?limit=1 ⇒ only the newest message, but `total` still reports the real size.
    const capped = (await t.app.inject({ method: "GET", url: `${url}?limit=1` })).json();
    expect(capped.messages).toHaveLength(1);
    expect(capped.total).toBe(full.messages.length);
    expect(capped.truncated).toBe(true);
    // The TRAILING message, not the leading one — the cap keeps the newest.
    expect(capped.messages[0]).toEqual(full.messages[full.messages.length - 1]);

    // ?limit=0 is the explicit "everything" the deep-link fallback uses.
    const zero = (await t.app.inject({ method: "GET", url: `${url}?limit=0` })).json();
    expect(zero.messages).toHaveLength(full.messages.length);
    expect(zero.truncated).toBe(false);

    // A limit larger than the transcript is not truncation.
    const big = (await t.app.inject({ method: "GET", url: `${url}?limit=9999` })).json();
    expect(big.messages).toHaveLength(full.messages.length);
    expect(big.truncated).toBe(false);
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

});
