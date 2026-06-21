// WebSocket chat client matching the paddock-server protocol (ws.ts).
//
// Usage:
//   const chat = new ChatSocket();
//   chat.onResponse = (chunk) => ...;
//   chat.onComplete = ({ sessionId }) => ...;
//   chat.send({ target: "my-project", message: "hi", sessionId });
import type { ServerWsMessage } from "./types";

export interface SendArgs {
  target: string;
  message: string;
  sessionId?: string;
}

type ResponseHandler = (chunk: string, meta: { sessionId: string | null; jobId: string | null }) => void;
type ToolCallHandler = (tc: {
  toolName: string;
  inputSummary?: string;
  output: string;
  isError: boolean;
}) => void;
type CompleteHandler = (meta: { sessionId: string | null; success: boolean; error?: string }) => void;
type ErrorHandler = (error: string) => void;

export class ChatSocket {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private url: string;

  onResponse: ResponseHandler = () => {};
  onToolCall: ToolCallHandler = () => {};
  onComplete: CompleteHandler = () => {};
  onError: ErrorHandler = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  constructor(url?: string) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    this.url = url ?? `${proto}://${window.location.host}/ws`;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.onOpen();
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onclose = () => this.onClose();
    ws.onerror = () => this.onError("WebSocket connection error");
    ws.onmessage = (ev) => this.handle(ev.data);
  }

  send(args: SendArgs): void {
    const msg = JSON.stringify({
      type: "chat:send",
      payload: { target: args.target, message: args.message, sessionId: args.sessionId },
    });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this.queue.push(msg);
      this.connect();
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private handle(raw: string): void {
    let msg: ServerWsMessage;
    try {
      msg = JSON.parse(raw) as ServerWsMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "chat:response":
        this.onResponse(msg.payload.chunk, {
          sessionId: msg.payload.sessionId,
          jobId: msg.payload.jobId,
        });
        break;
      case "chat:tool_call":
        this.onToolCall(msg.payload);
        break;
      case "chat:complete":
        this.onComplete({
          sessionId: msg.payload.sessionId,
          success: msg.payload.success,
          error: msg.payload.error,
        });
        break;
      case "chat:error":
        this.onError(msg.payload.error);
        break;
      case "pong":
        break;
    }
  }
}
