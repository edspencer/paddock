/**
 * Minimal WebSocket client for integration tests.
 *
 * Connects a real `ws` socket to a listening Fastify app and collects the
 * server→client chat events, exposing promise-based helpers to await specific
 * message types (chat:complete, chat:error, etc.). Used to exercise the real
 * WS streaming path end-to-end.
 */
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";

export interface WsEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface WsClient {
  send: (msg: unknown) => void;
  /** Send a raw (already-serialized) frame — used to test invalid-JSON handling. */
  sendRaw: (text: string) => void;
  /** All events received, in order. */
  events: WsEvent[];
  /** Current event count — pass to `waitFor`/`responseText` as a baseline so a
   *  later turn ignores events from earlier turns on the same socket. */
  mark: () => number;
  /**
   * Resolve when an event AT OR AFTER index `from` matches `pred` (or reject on
   * timeout). `from` defaults to 0 (any event, including already-received ones).
   */
  waitFor: (
    pred: (e: WsEvent) => boolean,
    opts?: { from?: number; timeoutMs?: number },
  ) => Promise<WsEvent>;
  /** Concatenated text from chat:response chunks received at/after index `from`. */
  responseText: (from?: number) => string;
  close: () => void;
}

/** Start listening on an ephemeral port; returns the base URL + port. */
export async function listen(app: FastifyInstance): Promise<{ port: number; url: string }> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { port: addr.port, url: `http://127.0.0.1:${addr.port}` };
}

export async function connectWs(port: number): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: WsEvent[] = [];
  const waiters: Array<{
    pred: (e: WsEvent) => boolean;
    from: number;
    resolve: (e: WsEvent) => void;
  }> = [];

  ws.on("message", (raw: WebSocket.RawData) => {
    let parsed: WsEvent;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const index = events.length;
    events.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (index >= waiters[i].from && waiters[i].pred(parsed)) {
        waiters[i].resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  return {
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    sendRaw: (text: string) => ws.send(text),
    events,
    mark: () => events.length,
    waitFor: (pred, opts = {}) => {
      const from = opts.from ?? 0;
      const timeoutMs = opts.timeoutMs ?? 20_000;
      return new Promise<WsEvent>((resolve, reject) => {
        for (let i = from; i < events.length; i++) {
          if (pred(events[i])) return resolve(events[i]);
        }
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for WS event (${timeoutMs}ms)`)),
          timeoutMs,
        );
        waiters.push({
          pred,
          from,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    responseText: (from = 0) =>
      events
        .slice(from)
        .filter((e) => e.type === "chat:response")
        .map((e) => (e.payload?.chunk as string) ?? "")
        .join(""),
    close: () => ws.close(),
  };
}
