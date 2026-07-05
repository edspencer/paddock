import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatClient, type ChatHandlers } from "./ws";
import type { ServerWsMessage } from "./types";

// ws.ts is a singleton chat socket over a real browser WebSocket. We replace the
// global WebSocket with a controllable fake so we can drive open/message/close/
// error and assert dispatch, routing, outbox flushing, and reconnect — all
// offline and deterministic (fake timers for the reconnect backoff).

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  // test helpers
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emit(msg: ServerWsMessage | { type: string; payload?: unknown }) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  emitRaw(raw: string) {
    this.onmessage?.({ data: raw });
  }
}

const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  // The chat socket is an app-wide singleton: a live socket from a previous test
  // would make the next subscribe reuse it (connect() early-returns when
  // open/connecting). Reach through and reset to a clean disconnected state so
  // each test drives its own fresh socket via the fake.
  resetChatClient();
});
afterEach(() => {
  resetChatClient();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Tear down the singleton's live socket + pending timers between tests. */
function resetChatClient() {
  const c = chatClient as unknown as {
    ws: { close: () => void; onclose: null } | null;
    manualClose: boolean;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    pingTimer: ReturnType<typeof setInterval> | null;
    pongTimer: ReturnType<typeof setTimeout> | null;
    awaitingPong: boolean;
    lastPongAt: number;
    subs: Map<symbol, unknown>;
    outbox: string[];
    reconnectAttempts: number;
    _state: string;
    activeSessions: Set<string>;
  };
  c.manualClose = true; // suppress the reconnect that onclose would schedule
  if (c.ws) {
    c.ws.onclose = null;
    try {
      c.ws.close();
    } catch {
      /* ignore */
    }
    c.ws = null;
  }
  if (c.reconnectTimer) {
    clearTimeout(c.reconnectTimer);
    c.reconnectTimer = null;
  }
  if (c.pingTimer) {
    clearInterval(c.pingTimer);
    c.pingTimer = null;
  }
  if (c.pongTimer) {
    clearTimeout(c.pongTimer);
    c.pongTimer = null;
  }
  c.awaitingPong = false;
  c.lastPongAt = 0;
  c.subs.clear();
  c.outbox = [];
  c.reconnectAttempts = 0;
  c._state = "closed";
  c.activeSessions.clear();
}

function handlers(): Required<Pick<ChatHandlers, "onResponse" | "onToolCall" | "onMessageBoundary" | "onComplete" | "onError">> {
  return {
    onResponse: vi.fn(),
    onToolCall: vi.fn(),
    onMessageBoundary: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

describe("ws: connect + lifecycle", () => {
  it("subscribing opens a /ws socket and reports state transitions", () => {
    const states: string[] = [];
    const offState = chatClient.onState((s) => states.push(s));
    const h = handlers();
    const sub = chatClient.subscribe("proj", null, h);
    expect(last().url).toMatch(/\/ws$/);
    last().open();
    expect(states).toContain("connecting");
    expect(states).toContain("open");
    sub.unsubscribe();
    offState();
  });

  it("queues sends made before open and flushes them on open (outbox)", () => {
    const sub = chatClient.subscribe("proj-outbox", null, handlers());
    // Not yet open → the send is buffered.
    chatClient.send("proj-outbox", "hello", null, { model: "m1" });
    expect(last().sent).toHaveLength(0);
    last().open();
    expect(last().sent).toHaveLength(1);
    const payload = JSON.parse(last().sent[0]);
    expect(payload).toEqual({ type: "chat:send", payload: { projectSlug: "proj-outbox", sessionId: null, message: "hello", model: "m1" } });
    sub.unsubscribe();
  });

  it("send omits preloadContext when false and model when unset", () => {
    const sub = chatClient.subscribe("proj-clean", null, handlers());
    last().open();
    chatClient.send("proj-clean", "hi", "sess-1");
    const payload = JSON.parse(last().sent[0]).payload;
    expect(payload).toEqual({ projectSlug: "proj-clean", sessionId: "sess-1", message: "hi" });
    expect(payload).not.toHaveProperty("preloadContext");
    expect(payload).not.toHaveProperty("model");
    sub.unsubscribe();
  });

  it("cancel transmits a chat:cancel with the jobId", () => {
    const sub = chatClient.subscribe("proj-cancel", null, handlers());
    last().open();
    chatClient.cancel("job-7");
    expect(JSON.parse(last().sent[0])).toEqual({ type: "chat:cancel", payload: { jobId: "job-7" } });
    sub.unsubscribe();
  });
});

describe("ws: dispatch + routing", () => {
  it("routes each event type to the subscribed chat's handler", () => {
    const h = handlers();
    const sub = chatClient.subscribe("route-a", null, h);
    last().open();
    const ws = last();
    ws.emit({ type: "chat:response", payload: { projectSlug: "route-a", sessionId: "s1", jobId: "j1", chunk: "hello " } });
    ws.emit({ type: "chat:tool_call", payload: { projectSlug: "route-a", sessionId: "s1", jobId: "j1", toolName: "Read", output: "x", isError: false } });
    ws.emit({ type: "chat:message_boundary", payload: { projectSlug: "route-a", sessionId: "s1", jobId: "j1" } });
    ws.emit({ type: "chat:complete", payload: { projectSlug: "route-a", sessionId: "s1", jobId: "j1", success: true } });

    expect(h.onResponse).toHaveBeenCalledWith("hello ", { sessionId: "s1", jobId: "j1" });
    expect(h.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ toolName: "Read" }), { sessionId: "s1", jobId: "j1" });
    expect(h.onMessageBoundary).toHaveBeenCalledWith({ sessionId: "s1", jobId: "j1" });
    expect(h.onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true, sessionId: "s1" }));
    sub.unsubscribe();
  });

  it("does not deliver events for a different project slug", () => {
    const h = handlers();
    const sub = chatClient.subscribe("mine", null, h);
    last().open();
    last().emit({ type: "chat:response", payload: { projectSlug: "someone-else", sessionId: "s", jobId: "j", chunk: "x" } });
    expect(h.onResponse).not.toHaveBeenCalled();
    sub.unsubscribe();
  });

  it("accepts the legacy `target` alias as the routing slug", () => {
    const h = handlers();
    const sub = chatClient.subscribe("legacy", null, h);
    last().open();
    last().emit({ type: "chat:response", payload: { target: "legacy", sessionId: "s", jobId: "j", chunk: "hi" } } as unknown as ServerWsMessage);
    expect(h.onResponse).toHaveBeenCalledWith("hi", expect.anything());
    sub.unsubscribe();
  });

  it("delivers chat:error to onError", () => {
    const h = handlers();
    const sub = chatClient.subscribe("errproj", null, h);
    last().open();
    last().emit({ type: "chat:error", payload: { projectSlug: "errproj", error: "boom" } });
    expect(h.onError).toHaveBeenCalledWith("boom");
    sub.unsubscribe();
  });

  it("ignores pong and malformed frames without throwing", () => {
    const h = handlers();
    const sub = chatClient.subscribe("pong-proj", null, h);
    last().open();
    expect(() => last().emit({ type: "pong" })).not.toThrow();
    expect(() => last().emitRaw("{not json")).not.toThrow();
    expect(h.onResponse).not.toHaveBeenCalled();
    sub.unsubscribe();
  });

  it("when two chats share a project, prefers the exact session match", () => {
    const a = handlers();
    const b = handlers();
    const subA = chatClient.subscribe("shared", "sess-A", a);
    const subB = chatClient.subscribe("shared", "sess-B", b);
    last().open();
    last().emit({ type: "chat:response", payload: { projectSlug: "shared", sessionId: "sess-B", jobId: "j", chunk: "for-B" } });
    expect(b.onResponse).toHaveBeenCalledWith("for-B", expect.anything());
    expect(a.onResponse).not.toHaveBeenCalled();
    subA.unsubscribe();
    subB.unsubscribe();
  });

  it("drops a straggler frame whose session no longer has a mounted pane (issue #35)", () => {
    // Only chat C is mounted. A frame for session A — a chat whose pane just
    // unmounted mid-stream — must NOT leak into C.
    const c = handlers();
    const sub = chatClient.subscribe("solo", "sess-C", c);
    last().open();
    last().emit({ type: "chat:response", payload: { projectSlug: "solo", sessionId: "sess-A", jobId: "jA", chunk: "leaked" } });
    expect(c.onResponse).not.toHaveBeenCalled();
    // C's own frames still arrive.
    last().emit({ type: "chat:response", payload: { projectSlug: "solo", sessionId: "sess-C", jobId: "jC", chunk: "mine" } });
    expect(c.onResponse).toHaveBeenCalledWith("mine", expect.anything());
    sub.unsubscribe();
  });

  it("delivers a session-less frame to a sole subscriber", () => {
    // Early frames of a turn can arrive before the server stamps the session id.
    const c = handlers();
    const sub = chatClient.subscribe("solo-null", "sess-C", c);
    last().open();
    last().emit({ type: "chat:response", payload: { projectSlug: "solo-null", sessionId: null, jobId: "j", chunk: "early" } });
    expect(c.onResponse).toHaveBeenCalledWith("early", expect.anything());
    sub.unsubscribe();
  });

  it("routes an unmatched frame to a nascent chat (ChatPane applies the final guard)", () => {
    // A freshly-mounted new chat (sessionId null) is the only subscriber; the
    // router hands it the frame, and the mounted pane's own session guard
    // decides whether to apply it. Here we assert the routing half.
    const nascent = handlers();
    const sub = chatClient.subscribe("nascent", null, nascent);
    last().open();
    last().emit({ type: "chat:response", payload: { projectSlug: "nascent", sessionId: "sess-A", jobId: "jA", chunk: "x" } });
    expect(nascent.onResponse).toHaveBeenCalled();
    sub.unsubscribe();
  });

  it("updates a subscription's sessionId via setSessionId so later events route", () => {
    const a = handlers();
    const b = handlers();
    // a is the established chat; b is a freshly-sent NEW chat (sessionId null).
    const subA = chatClient.subscribe("dyn", "sess-A", a);
    const subB = chatClient.subscribe("dyn", null, b);
    last().open();
    // The server reports b's new session id; the pane would call setSessionId.
    subB.setSessionId("sess-NEW");
    last().emit({ type: "chat:response", payload: { projectSlug: "dyn", sessionId: "sess-NEW", jobId: "j", chunk: "to-b" } });
    expect(b.onResponse).toHaveBeenCalledWith("to-b", expect.anything());
    expect(a.onResponse).not.toHaveBeenCalled();
    subA.unsubscribe();
    subB.unsubscribe();
  });
});

describe("ws: reconnect", () => {
  it("schedules a reconnect after an unexpected close (new socket created)", () => {
    vi.useFakeTimers();
    const sub = chatClient.subscribe("recon", null, handlers());
    last().open();
    const before = FakeWebSocket.instances.length;
    // Server-side drop (not a manual close): onclose fires → backoff reconnect.
    last().close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    sub.unsubscribe();
  });

  it("onerror triggers a close which leads to a reconnect", () => {
    vi.useFakeTimers();
    const sub = chatClient.subscribe("recon-err", null, handlers());
    last().open();
    const before = FakeWebSocket.instances.length;
    last().onerror?.();
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    sub.unsubscribe();
  });
});

describe("ws: heartbeat + revive (issue #46)", () => {
  const PING_INTERVAL_MS = 25_000;
  const PONG_TIMEOUT_MS = 10_000;
  const pingsSent = (ws: FakeWebSocket) =>
    ws.sent.filter((s) => JSON.parse(s).type === "ping").length;
  const sentTypes = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s).type);

  it("closes and reconnects a socket that stops answering pings", () => {
    vi.useFakeTimers();
    const sub = chatClient.subscribe("hb", null, handlers());
    last().open();
    const ws1 = last();
    // Next ping tick sends a ping…
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(pingsSent(ws1)).toBeGreaterThanOrEqual(1);
    // …no pong arrives within the deadline → the dead socket is closed and a
    // reconnect is scheduled + fires.
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    sub.unsubscribe();
  });

  it("keeps the socket open when pings are answered with pong", () => {
    vi.useFakeTimers();
    const sub = chatClient.subscribe("hb-ok", null, handlers());
    last().open();
    const ws = last();
    vi.advanceTimersByTime(PING_INTERVAL_MS); // ping sent, awaiting pong
    ws.emit({ type: "pong" }); // answered → deadline cleared
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1000);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances.length).toBe(before); // no reconnect
    sub.unsubscribe();
  });

  it("queues a send on a stale (possibly half-open) socket and flushes on the probe pong", () => {
    const sub = chatClient.subscribe("stale", null, handlers());
    last().open();
    const ws = last();
    // Simulate a long idle with no pong observed (beyond the staleness window).
    (chatClient as unknown as { lastPongAt: number }).lastPongAt = Date.now() - 60_000;

    chatClient.send("stale", "hi", null);
    // The message is NOT written into the maybe-dead socket; a liveness probe is.
    expect(sentTypes(ws)).toContain("ping");
    expect(sentTypes(ws)).not.toContain("chat:send");

    // A pong confirms liveness and flushes the queued send.
    ws.emit({ type: "pong" });
    expect(sentTypes(ws)).toContain("chat:send");
    sub.unsubscribe();
  });

  it("revives a dropped socket immediately when the tab becomes visible", () => {
    const sub = chatClient.subscribe("vis", null, handlers());
    last().open();
    last().close(); // idle drop; a backoff reconnect is pending
    const before = FakeWebSocket.instances.length;

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    // Reconnected right away rather than waiting out the backoff.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    sub.unsubscribe();
  });
});

describe("ws: session re-attach (issue #54)", () => {
  const subscribes = (ws: FakeWebSocket) =>
    ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "chat:subscribe");

  it("a fresh subscribe attaches the session future-only (no replay)", () => {
    const sub = chatClient.subscribe("re", "sess-1", handlers());
    last().open();
    const attach = subscribes(last()).at(-1);
    expect(attach).toMatchObject({
      type: "chat:subscribe",
      payload: { projectSlug: "re", sessionId: "sess-1", wantReplay: false },
    });
    sub.unsubscribe();
  });

  it("re-attaches a MID-TURN chat on reconnect asking to replay the gap after its lastSeq", () => {
    vi.useFakeTimers();
    const sub = chatClient.subscribe("re", "sess-1", handlers());
    last().open();
    const ws1 = last();

    // A turn is in flight and we've applied through seq 2.
    chatClient.send("re", "hi", "sess-1");
    ws1.emit({ type: "chat:response", payload: { projectSlug: "re", sessionId: "sess-1", jobId: "j", chunk: "a", seq: 0 } });
    ws1.emit({ type: "chat:response", payload: { projectSlug: "re", sessionId: "sess-1", jobId: "j", chunk: "b", seq: 1 } });
    ws1.emit({ type: "chat:tool_call", payload: { projectSlug: "re", sessionId: "sess-1", jobId: "j", toolName: "Read", output: "x", isError: false, seq: 2 } });

    // The socket drops mid-turn and a new one connects.
    ws1.close();
    vi.advanceTimersByTime(1000);
    const ws2 = last();
    expect(ws2).not.toBe(ws1);
    ws2.open();

    // On reconnect it re-attaches with wantReplay + the exact gap cursor.
    const attach = subscribes(ws2).at(-1);
    expect(attach).toMatchObject({
      payload: { projectSlug: "re", sessionId: "sess-1", wantReplay: true, lastSeq: 2 },
    });
    sub.unsubscribe();
  });

  it("after a turn completes, a reconnect re-attaches future-only (no stale replay)", () => {
    vi.useFakeTimers();
    const sub = chatClient.subscribe("re", "sess-1", handlers());
    last().open();
    const ws1 = last();
    chatClient.send("re", "hi", "sess-1");
    ws1.emit({ type: "chat:response", payload: { projectSlug: "re", sessionId: "sess-1", jobId: "j", chunk: "a", seq: 0 } });
    ws1.emit({ type: "chat:complete", payload: { projectSlug: "re", sessionId: "sess-1", jobId: "j", success: true, seq: 1 } });

    ws1.close();
    vi.advanceTimersByTime(1000);
    const ws2 = last();
    ws2.open();
    // Turn is over → turnActive is false → no replay requested (would duplicate).
    expect(subscribes(ws2).at(-1)).toMatchObject({ payload: { wantReplay: false } });
    sub.unsubscribe();
  });

  it("delivers chat:resync to onResync (transcript re-hydrate fallback)", () => {
    const onResync = vi.fn();
    const sub = chatClient.subscribe("rs", "sess-1", { ...handlers(), onResync });
    last().open();
    last().emit({ type: "chat:resync", payload: { projectSlug: "rs", sessionId: "sess-1" } } as unknown as ServerWsMessage);
    expect(onResync).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
  });
});

describe("ws: active-turn signal (issues #52/#53)", () => {
  const emitActive = (ws: FakeWebSocket, sessionId: string, running: boolean, jobId: string | null = null) =>
    ws.emit({ type: "chat:active", payload: { projectSlug: "p", sessionId, jobId, running } } as unknown as ServerWsMessage);

  it("delivers chat:active to the exactly-matching chat's onActive (restores Stop, #52)", () => {
    const onActive = vi.fn();
    const sub = chatClient.subscribe("p", "sess-1", { ...handlers(), onActive });
    last().open();
    emitActive(last(), "sess-1", true, "job-9");
    expect(onActive).toHaveBeenCalledWith({ running: true, jobId: "job-9" });
    sub.unsubscribe();
  });

  it("does NOT deliver chat:active to a nascent (new-chat) pane", () => {
    const onActive = vi.fn();
    // A brand-new chat (sessionId null) must not be told another session is live.
    const sub = chatClient.subscribe("p", null, { ...handlers(), onActive });
    last().open();
    emitActive(last(), "sess-other", true, "job-x");
    expect(onActive).not.toHaveBeenCalled();
    sub.unsubscribe();
  });

  it("onActiveSessions reflects the running set as chat:active arrives (sidebar dots, #53)", () => {
    const seen: string[][] = [];
    const off = chatClient.onActiveSessions((s) => seen.push([...s].sort()));
    const sub = chatClient.subscribe("p", "sess-1", handlers());
    last().open();
    emitActive(last(), "sess-1", true);
    emitActive(last(), "sess-2", true);
    emitActive(last(), "sess-1", false);
    // Initial empty, then after each transition.
    expect(seen[0]).toEqual([]);
    expect(seen).toContainEqual(["sess-1"]);
    expect(seen).toContainEqual(["sess-1", "sess-2"]);
    expect(seen.at(-1)).toEqual(["sess-2"]);
    off();
    sub.unsubscribe();
  });
});
