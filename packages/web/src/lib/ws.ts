// WebSocket chat client matching the paddock-server protocol (server/src/ws.ts).
//
// Design: ONE shared socket for the whole app (a singleton), with robust
// auto-reconnect + ping keepalive. Callers subscribe a handler keyed by the
// chat they care about; the client routes each incoming event to the matching
// subscriber by projectSlug (+ sessionId once known). This lets multiple chat
// panes coexist and survives reconnects without tearing down React state.
//
// Client -> server:
//   chat:send   { projectSlug, sessionId|null, message }
//   chat:cancel { jobId }
//   ping
//
// Server -> client (each carries projectSlug + sessionId + jobId for routing):
//   chat:response         { ..., chunk }
//   chat:tool_call        { ..., toolName, inputSummary?, output, isError, durationMs? }
//   chat:message_boundary { ... }
//   chat:complete         { ..., success, error? }
//   chat:error            { projectSlug, error }
//   pong
import type { ServerWsMessage } from "./types";

export interface ToolCall {
  toolName: string;
  inputSummary?: string;
  output: string;
  isError: boolean;
  durationMs?: number;
}

/** Events delivered to a subscribed chat. */
export interface ChatHandlers {
  onResponse?: (chunk: string, meta: { sessionId: string | null; jobId: string | null }) => void;
  onToolCall?: (tc: ToolCall, meta: { sessionId: string | null; jobId: string | null }) => void;
  onMessageBoundary?: (meta: { sessionId: string | null; jobId: string | null }) => void;
  onComplete?: (meta: { sessionId: string | null; jobId: string | null; success: boolean; error?: string }) => void;
  onError?: (error: string) => void;
}

export type ConnectionState = "connecting" | "open" | "closed";

interface Subscription {
  /** The project slug (or "scratch") this chat addresses. */
  projectSlug: string;
  /** Known session id, if resuming or once the server reports it. May update. */
  sessionId: string | null;
  handlers: ChatHandlers;
}

const PING_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

class ChatClient {
  private ws: WebSocket | null = null;
  private url: string;
  private outbox: string[] = [];
  private subs = new Map<symbol, Subscription>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manualClose = false;
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private _state: ConnectionState = "closed";

  constructor() {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const base = (import.meta.env.VITE_WS_BASE as string | undefined) ?? `${proto}://${window.location.host}`;
    this.url = `${base.replace(/^http/, "ws")}/ws`;
  }

  get state(): ConnectionState {
    return this._state;
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this._state);
    return () => this.stateListeners.delete(cb);
  }

  private setState(s: ConnectionState) {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateListeners) cb(s);
  }

  /** Subscribe a chat. Returns an updater + an unsubscribe fn. */
  subscribe(
    projectSlug: string,
    sessionId: string | null,
    handlers: ChatHandlers,
  ): { setSessionId: (id: string | null) => void; unsubscribe: () => void } {
    const key = Symbol("chat-sub");
    this.subs.set(key, { projectSlug, sessionId, handlers });
    this.connect();
    return {
      setSessionId: (id: string | null) => {
        const sub = this.subs.get(key);
        if (sub) sub.sessionId = id;
      },
      unsubscribe: () => {
        this.subs.delete(key);
      },
    };
  }

  send(projectSlug: string, message: string, sessionId: string | null): void {
    this.transmit(
      JSON.stringify({
        type: "chat:send",
        payload: { projectSlug, sessionId, message },
      }),
    );
  }

  cancel(jobId: string): void {
    this.transmit(JSON.stringify({ type: "chat:cancel", payload: { jobId } }));
  }

  private transmit(raw: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.outbox.push(raw);
      this.connect();
    }
  }

  private connect(): void {
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState("open");
      for (const m of this.outbox) ws.send(m);
      this.outbox = [];
      this.startPing();
    };
    ws.onclose = () => {
      this.stopPing();
      this.setState("closed");
      if (!this.manualClose) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; reconnect handled there.
      ws.close();
    };
    ws.onmessage = (ev) => this.dispatch(ev.data);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Find the subscriber an incoming event belongs to. */
  private route(projectSlug: string, sessionId: string | null): Subscription | undefined {
    const candidates = [...this.subs.values()].filter((s) => s.projectSlug === projectSlug);
    if (candidates.length <= 1) return candidates[0];
    // Multiple chats on the same project (rare): prefer an exact session match,
    // else the one still awaiting its first session id (a freshly-sent new chat).
    return (
      candidates.find((s) => sessionId && s.sessionId === sessionId) ??
      candidates.find((s) => s.sessionId === null) ??
      candidates[0]
    );
  }

  private dispatch(raw: string): void {
    let msg: ServerWsMessage;
    try {
      msg = JSON.parse(raw) as ServerWsMessage;
    } catch {
      return;
    }
    if (msg.type === "pong") return;

    const slug = msg.payload.projectSlug ?? (msg.payload as { target?: string }).target;
    if (!slug) return;

    if (msg.type === "chat:error") {
      const sub = this.route(slug, null);
      sub?.handlers.onError?.(msg.payload.error);
      return;
    }

    const { sessionId, jobId } = msg.payload;
    const sub = this.route(slug, sessionId);
    if (!sub) return;
    const meta = { sessionId, jobId };

    switch (msg.type) {
      case "chat:response":
        sub.handlers.onResponse?.(msg.payload.chunk, meta);
        break;
      case "chat:tool_call":
        sub.handlers.onToolCall?.(
          {
            toolName: msg.payload.toolName,
            inputSummary: msg.payload.inputSummary,
            output: msg.payload.output,
            isError: msg.payload.isError,
            durationMs: msg.payload.durationMs,
          },
          meta,
        );
        break;
      case "chat:message_boundary":
        sub.handlers.onMessageBoundary?.(meta);
        break;
      case "chat:complete":
        sub.handlers.onComplete?.({
          ...meta,
          success: msg.payload.success,
          error: msg.payload.error,
        });
        break;
    }
  }
}

/** App-wide shared chat socket. */
export const chatClient = new ChatClient();
