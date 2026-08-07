// WebSocket chat client matching the paddock-server protocol (server/src/ws.ts).
//
// Design: ONE shared socket for the whole app (a singleton), with robust
// auto-reconnect + ping keepalive. Callers subscribe a handler keyed by the
// chat they care about; the client routes each incoming event to the matching
// subscriber by projectSlug (+ sessionId once known). This lets multiple chat
// panes coexist and survives reconnects without tearing down React state.
//
// Client -> server:
//   chat:send   { projectSlug, sessionId|null, message, preloadContext?, model? }
//   chat:cancel { jobId }
//   ping
//
// Server -> client (each carries projectSlug + sessionId + jobId for routing):
//   chat:response         { ..., chunk }
//   chat:tool_call        { ..., toolName, inputSummary?, output, isError, durationMs? }
//   chat:message_boundary { ... }
//   chat:complete         { ..., success, error?, model?, usage? }
//   chat:error            { projectSlug, error }
//   pong
import type {
  AttachmentRef,
  ChatCompleteUsage,
  EditDiff,
  ReadInfo,
  BashDetails,
  SearchInfo,
  TaskUpdateInfo,
  TaskCreateInfo,
  ServerWsMessage,
  MessageSender,
  TurnNotice,
} from "./types";

export interface ToolCall {
  toolName: string;
  inputSummary?: string;
  output: string;
  isError: boolean;
  durationMs?: number;
  /**
   * True while the tool is in flight — created from a `chat:tool_start` frame
   * before the tool completes (#175). Reconciled to a finished call (pending
   * cleared) when the matching `chat:tool_call` arrives, keyed by `toolUseId`.
   */
  pending?: boolean;
  // Sub-agent (Task/Agent) enrichment (issue #37). Populated only on tool calls
  // hydrated from history — the live WS frame does not carry these.
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
  hasSubagent?: boolean;
  subagentDurationMs?: number;
  /** The sub-agent's estimated API-rate cost (USD), priced per-model (issue #166). */
  subagentCostUsd?: number | null;
  // Background-job / Monitor enrichment (issue #230). History-hydrated tool calls
  // carry these directly; live frames fall back to output-sniffing (see
  // `isBackgroundTool`/`classifyBackground` in ChatPane).
  background?: boolean;
  taskId?: string;
  taskStatus?: string;
  taskResultSummary?: string;
  monitorEvents?: string[];
  // Per-tool detail enrichment (issue #237); history-hydrated only (live frames
  // carry none of this, so the renderer degrades to the generic block).
  /** Inline diff for an edit tool call (issue #232 → #237). */
  editDiff?: EditDiff;
  readInfo?: ReadInfo;
  bashDetails?: BashDetails;
  searchInfo?: SearchInfo;
  taskUpdate?: TaskUpdateInfo;
  taskCreate?: TaskCreateInfo;
}

/** Events delivered to a subscribed chat. */
export interface ChatHandlers {
  onResponse?: (chunk: string, meta: { sessionId: string | null; jobId: string | null }) => void;
  onToolCall?: (tc: ToolCall, meta: { sessionId: string | null; jobId: string | null }) => void;
  /**
   * An in-flight tool started (#175). Carries a `pending: true` ToolCall so the
   * client can render a "running…" row immediately, reconciled by `toolUseId`
   * when the matching `onToolCall` completion lands.
   */
  onToolStart?: (tc: ToolCall, meta: { sessionId: string | null; jobId: string | null }) => void;
  onMessageBoundary?: (meta: { sessionId: string | null; jobId: string | null }) => void;
  onComplete?: (meta: {
    sessionId: string | null;
    jobId: string | null;
    success: boolean;
    error?: string;
    /** The model the turn ran on (server: lastModel ?? effectiveModel). */
    model?: string;
    /** Last per-turn usage; absent if none was observed (drives the context meter). */
    usage?: ChatCompleteUsage;
  }) => void;
  onError?: (error: string) => void;
  /**
   * The server couldn't replay the missed gap of a live turn (its buffer aged
   * out) and asks the client to re-hydrate from the transcript instead (issue
   * #54). Rare fallback — the caller should reload this chat's history.
   */
  onResync?: () => void;
  /**
   * This chat's live-turn status changed (issues #52/#53): `running` true when a
   * turn is in flight (restore the Stop button using `jobId` + show the working
   * indicator), false when it ends. Fires on (re)subscribe for an already-running
   * turn, so a pane the user navigated back to restores state immediately.
   */
  onActive?: (meta: { running: boolean; jobId: string | null }) => void;
  /**
   * The server auto-sent this chat's queued message (#245). `text` is present when
   * it actually drained+sent it (render it as the user bubble, then clear the
   * queued state); absent when the server is only telling the client to clear a
   * stale/already-sent copy. The server is authoritative — the client never sends
   * the queued message itself.
   */
  onQueuedFlushed?: (meta: { text?: string; attachments?: AttachmentRef[] }) => void;
  /**
   * The chat's queued message changed on the server (#629): another client queued
   * alongside us, edited the slot, or cleared it. `text` is the slot's full
   * contents (null when empty), `attachments` the files staged on it (#728), and
   * `qid` its identity, which the pane adopts.
   */
  onQueuedState?: (meta: {
    text: string | null;
    attachments?: AttachmentRef[];
    qid?: string;
    reason?: "returned";
  }) => void;
  /**
   * A Stop handed this chat's queued message back to THIS client's composer
   * (#751), files and all (#728). Only the socket that pressed Stop receives it.
   */
  onQueuedReturned?: (meta: { text: string; attachments?: AttachmentRef[] }) => void;
  /**
   * A machine-injected user turn arrived for this chat (#290): another chat
   * `send_message`d / a schedule fired into it. Render the injected user bubble
   * live (with its sender attribution) so it no longer takes a refresh to appear.
   */
  onInjected?: (
    inj: { sender: MessageSender; content: string; timestamp: string },
    meta: { sessionId: string | null; jobId: string | null },
  ) => void;
  /**
   * A background task was killed at the turn boundary and the keeper is idle
   * (#347). Render the amber "keeper is idle / Continue" affordance inline, live,
   * so it no longer takes a refresh to appear. `timestamp` dedups a hub replay.
   */
  onKilledTask?: (info: { summary: string; timestamp: string }) => void;
  /**
   * A keeper turn dead-ended without a normal reply (issue #329): a
   * subscription/usage-limit hit, the max-turns cap, or an error. Render a
   * distinct inline notice turn (with the reset time / a Retry affordance) so the
   * chat surfaces WHY it stopped instead of appearing to hang.
   */
  onNotice?: (notice: TurnNotice, meta: { sessionId: string | null; jobId: string | null }) => void;
}

export type ConnectionState = "connecting" | "open" | "closed";

interface Subscription {
  /** The workspace key (a project slug, or `""` for the root) this chat addresses. */
  projectSlug: string;
  /** Known session id, if resuming or once the server reports it. May update. */
  sessionId: string | null;
  handlers: ChatHandlers;
  /**
   * The highest per-turn `seq` this chat has applied for the CURRENT turn, or -1
   * between turns (reset when a new turn is sent). On reconnect it's sent back so
   * the server replays exactly the frames missed after it (issue #54).
   */
  lastSeq: number;
  /**
   * True while a turn is in flight for this chat (from send/first-frame until
   * complete). Gates whether a reconnect asks for a gap replay vs. future-only
   * frames — a fresh mount (no active turn) must NOT replay, or buffered frames
   * would duplicate the transcript it just hydrated.
   */
  turnActive: boolean;
}

const PING_INTERVAL_MS = 25_000;
// How long to wait for a `pong` after a `ping` before declaring the socket dead.
const PONG_TIMEOUT_MS = 10_000;
// A socket that hasn't produced a `pong` within this window is treated as
// possibly half-open, so a send is queued (and a fresh probe/reconnect kicked)
// rather than written into a dead-but-still-`OPEN` socket and silently lost.
// Must exceed one full ping→pong cycle so healthy sockets are never seen stale.
const STALE_MS = PING_INTERVAL_MS + PONG_TIMEOUT_MS + 5_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

class ChatClient {
  private ws: WebSocket | null = null;
  private url: string;
  private outbox: string[] = [];
  private subs = new Map<symbol, Subscription>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  // Timestamp (ms) of the last observed `pong` or fresh open; 0 before any.
  private lastPongAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manualClose = false;
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private _state: ConnectionState = "closed";
  // Sessions with a currently-running turn (issue #53), maintained from
  // chat:active broadcasts so the sidebar can show a streaming dot on ANY chat —
  // including ones whose pane isn't mounted. Keyed by sessionId -> projectSlug
  // so the projects sidebar can also group in-flight turns BY project (#161)
  // with no new polling; `onActiveSessions` still exposes just the id set.
  private activeSessions = new Map<string, string>();
  private activeListeners = new Set<(s: ReadonlySet<string>) => void>();
  private activeInfoListeners = new Set<(m: ReadonlyMap<string, string>) => void>();
  // Every session id this client has ever attached a subscription to. Used by
  // route() to tell a straggler frame from an unmounted chat (a KNOWN session)
  // apart from a brand-new chat's very first session reveal (an unknown session),
  // so the former is never mis-delivered to a nascent new-chat pane. Grows with
  // the number of distinct chats touched this page-load — negligible (UUIDs).
  private knownSessions = new Set<string>();

  constructor() {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const base = (import.meta.env.VITE_WS_BASE as string | undefined) ?? `${proto}://${window.location.host}`;
    this.url = `${base.replace(/^http/, "ws")}/ws`;

    // A backgrounded/asleep tab has its timers throttled, so the ping keepalive
    // stalls and an idle-dropped socket goes unnoticed (it stays `OPEN` with no
    // `close` event). When the user returns or the network comes back, probe the
    // socket's liveness (or reconnect) immediately instead of waiting for the
    // next throttled tick. See issue #46.
    if (typeof window !== "undefined") {
      const revive = () => this.ensureLive();
      window.addEventListener("online", revive);
      window.addEventListener("focus", revive);
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") this.ensureLive();
        });
      }
    }
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

  /**
   * Observe the set of sessions with a live turn (issue #53). Fires immediately
   * with the current set and again whenever it changes. Used by the project
   * sidebar to render a streaming dot next to each running chat.
   */
  onActiveSessions(cb: (running: ReadonlySet<string>) => void): () => void {
    this.activeListeners.add(cb);
    cb(new Set(this.activeSessions.keys()));
    // Watching the running set is a reason to HAVE a socket (#573/#599). The
    // server replays its whole running snapshot to every socket the moment it
    // connects, so this is also what makes the set correct on a first paint
    // that mounts no chat pane at all — Home listing running chats, or the
    // sidebar's in-flight badges. Before this, `connect()` was reachable only
    // from `subscribe()`, so landing on Home opened no socket and every one of
    // those surfaces sat empty until the user opened a chat.
    this.connect();
    return () => this.activeListeners.delete(cb);
  }

  /**
   * Like {@link onActiveSessions} but exposes the running sessions WITH their
   * `projectSlug` (sessionId -> slug), so the projects sidebar can count
   * in-flight turns per project (#161). Fires immediately with the current map
   * and again whenever the running set changes.
   */
  onActiveInfos(cb: (running: ReadonlyMap<string, string>) => void): () => void {
    this.activeInfoListeners.add(cb);
    cb(new Map(this.activeSessions));
    // Same reason as {@link onActiveSessions}: an active-set watcher wants a
    // socket even with no chat mounted.
    this.connect();
    return () => this.activeInfoListeners.delete(cb);
  }

  private setActive(sessionId: string, running: boolean, projectSlug: string): void {
    const had = this.activeSessions.has(sessionId);
    if (running) this.activeSessions.set(sessionId, projectSlug);
    else this.activeSessions.delete(sessionId);
    if (this.activeSessions.has(sessionId) !== had) {
      const keys = new Set(this.activeSessions.keys());
      for (const cb of this.activeListeners) cb(keys);
      const infos = new Map(this.activeSessions);
      for (const cb of this.activeInfoListeners) cb(infos);
    }
  }

  /** Subscribe a chat. Returns an updater + an unsubscribe fn. */
  subscribe(
    projectSlug: string,
    sessionId: string | null,
    handlers: ChatHandlers,
  ): { setSessionId: (id: string | null) => void; unsubscribe: () => void } {
    const key = Symbol("chat-sub");
    const sub: Subscription = { projectSlug, sessionId, handlers, lastSeq: -1, turnActive: false };
    this.subs.set(key, sub);
    this.connect();
    // A fresh mount attaches future-only (no replay): it hydrates the transcript
    // over REST, so replaying buffered frames would duplicate it.
    if (sessionId) this.attachSession(sub, false);
    return {
      setSessionId: (id: string | null) => {
        const s = this.subs.get(key);
        if (!s) return;
        s.sessionId = id;
        // Now that this chat knows its session id, register the socket→session
        // mapping so a later reconnect can re-attach this turn to a new socket.
        if (id) this.attachSession(s, false);
      },
      unsubscribe: () => {
        this.subs.delete(key);
      },
    };
  }

  /**
   * Tell the server this socket is attached to a chat's session (issue #54). When
   * `wantReplay`, ask it to replay the frames missed after `sub.lastSeq` — used on
   * a reconnect of a socket that was mid-turn. A no-op without a session id.
   */
  private attachSession(sub: Subscription, wantReplay: boolean): void {
    if (!sub.sessionId) return;
    // Remember this session so a later straggler frame for it (after the pane
    // unmounts) is dropped by route() rather than leaking into a new-chat pane.
    this.knownSessions.add(sub.sessionId);
    this.transmit(
      JSON.stringify({
        type: "chat:subscribe",
        payload: {
          projectSlug: sub.projectSlug,
          sessionId: sub.sessionId,
          wantReplay,
          lastSeq: sub.lastSeq,
        },
      }),
    );
  }

  send(
    projectSlug: string,
    message: string,
    sessionId: string | null,
    opts?: {
      preloadContext?: boolean;
      model?: string;
      attachments?: Array<{ id: string; filename: string; kind?: string }>;
    },
  ): void {
    const payload: Record<string, unknown> = { projectSlug, sessionId, message };
    // Only meaningful on the first turn of a NEW chat; the server ignores it
    // otherwise. Omit when false to keep the wire clean.
    if (opts?.preloadContext) payload.preloadContext = true;
    // The model the keeper agent should run this turn on. The server
    // re-registers the agent with it (last-write-wins per project). Omit when
    // unset so the server falls back to the project/keeper default.
    if (opts?.model) payload.model = opts.model;
    // Composer attachments (issue #328): refs to already-uploaded files. The
    // server prepends a Read-tool hint block to the prompt. Omit when none.
    if (opts?.attachments && opts.attachments.length > 0) payload.attachments = opts.attachments;
    this.markTurnStart(projectSlug, sessionId);
    this.transmit(JSON.stringify({ type: "chat:send", payload }));
  }

  /**
   * Store a queued message on the server so it persists across browser close
   * and auto-sends when the current turn completes (#197). The message is also
   * persisted to localStorage for live editing UX.
   */
  setQueued(
    projectSlug: string,
    sessionId: string,
    text: string | null,
    qid?: string | null,
    attachments?: AttachmentRef[],
  ): void {
    const payload: Record<string, unknown> = { projectSlug, sessionId, text, qid };
    // The files staged behind this queued message (#728). The server merges them
    // into the shared slot additively, so omitting them never clears any — which
    // is what makes a re-assert from a client whose tray is empty harmless.
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        kind: a.kind,
      }));
    }
    this.transmit(JSON.stringify({ type: "chat:set_queue", payload }));
  }

  /**
   * A new turn is starting for a chat: reset its per-turn `seq` baseline and mark
   * it in flight, so a reconnect mid-turn re-attaches with a gap replay from the
   * right point (issue #54). Matches the chat by slug + (possibly null) session id.
   */
  private markTurnStart(projectSlug: string, sessionId: string | null): void {
    for (const sub of this.subs.values()) {
      if (sub.projectSlug === projectSlug && sub.sessionId === sessionId) {
        sub.lastSeq = -1;
        sub.turnActive = true;
      }
    }
  }

  /**
   * Run a slash command (e.g. `/compact`) in the current chat. Unlike `send`,
   * the server drives herdctl's streaming session so the CLI dispatches the
   * command instead of treating it as a plain prompt. Output arrives over the
   * same response/tool/complete handlers as a normal turn.
   */
  sendCommand(projectSlug: string, command: string, sessionId: string | null): void {
    this.markTurnStart(projectSlug, sessionId);
    this.transmit(
      JSON.stringify({ type: "chat:command", payload: { projectSlug, sessionId, command } }),
    );
  }

  cancel(jobId: string): void {
    this.transmit(JSON.stringify({ type: "chat:cancel", payload: { jobId } }));
  }

  /**
   * Manually re-drive a hung keeper whose background task was killed at the turn
   * boundary (issue #301, Layer 2 "Continue"). The keeper's session stayed alive
   * (herdctl#374) so it's still injectable; the server injects a recovery nudge
   * into it via startAgentTurn, and the resulting turn streams back over the same
   * response/tool/complete handlers as any other. Marks the turn as starting so a
   * reconnect mid-turn re-attaches cleanly (mirrors sendCommand).
   */
  continueChat(projectSlug: string, sessionId: string): void {
    this.markTurnStart(projectSlug, sessionId);
    this.transmit(
      JSON.stringify({ type: "chat:continue", payload: { projectSlug, sessionId } }),
    );
  }

  private transmit(raw: string): void {
    if (this.isLive()) {
      this.ws!.send(raw);
    } else {
      // Not open, or open-but-stale (possible half-open drop). Queue and kick a
      // liveness probe / reconnect; the outbox flushes once the socket is
      // confirmed live (on `pong`) or freshly reopened (on `open`).
      this.outbox.push(raw);
      this.ensureLive();
    }
  }

  /**
   * Whether the socket can be trusted to actually deliver right now: OPEN and
   * having produced a `pong` within the staleness window. A socket silently
   * killed while idle stays `readyState === OPEN`, so the freshness check is
   * what prevents writing into the void.
   */
  private isLive(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    return Date.now() - this.lastPongAt < STALE_MS;
  }

  /**
   * Does anything in the app still need this socket? A mounted chat does, and so
   * does anyone watching the running set — the sidebar's in-flight badges and
   * Home's running-chats list both render with no chat pane in sight, and both
   * are fed exclusively by `chat:active` broadcasts.
   *
   * Counting ONLY chat subscriptions here is what made a fresh Home load show
   * nothing running (#573): no pane, so no subscription, so no socket, so no
   * broadcasts — and the failure was silent, because an empty running set is
   * indistinguishable from a quiet instance.
   */
  private wantsSocket(): boolean {
    return (
      this.subs.size > 0 || this.activeListeners.size > 0 || this.activeInfoListeners.size > 0
    );
  }

  /**
   * Ensure we have a live socket: reconnect if it's closed (cancelling any
   * backoff wait so the user doesn't sit offline), or fire an immediate ping
   * probe if it's open-but-unverified so a half-open drop is detected within
   * `PONG_TIMEOUT_MS`.
   */
  private ensureLive(): void {
    if (!this.wantsSocket()) return; // nothing wants the socket
    const rs = this.ws?.readyState;
    if (rs === WebSocket.OPEN) {
      this.sendPing();
    } else if (rs !== WebSocket.CONNECTING) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      this.connect();
    }
  }

  private flushOutbox(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.outbox.length === 0) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const m of pending) this.ws.send(m);
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
      this.awaitingPong = false;
      this.lastPongAt = Date.now();
      this.setState("open");
      this.flushOutbox();
      // Re-attach every known chat to this (possibly new) socket. A chat that was
      // mid-turn when the old socket dropped asks for a gap replay so its stream
      // resumes seamlessly; an idle chat attaches future-only (issue #54).
      for (const sub of this.subs.values()) {
        if (sub.sessionId) this.attachSession(sub, sub.turnActive);
      }
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
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  /**
   * Send a `ping` and arm a pong deadline. If no `pong` arrives within
   * `PONG_TIMEOUT_MS` the socket is treated as dead and force-closed, which runs
   * the normal `onclose` → reconnect path. A no-op if a probe is already in
   * flight (its deadline covers this tick) or the socket isn't open.
   */
  private sendPing(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.awaitingPong) return;
    this.awaitingPong = true;
    try {
      this.ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      // A throw here means the socket is already unusable — reconnect.
      this.awaitingPong = false;
      this.ws.close();
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // No pong within the deadline → half-open/dead socket. Closing it flips
      // readyState off OPEN (so sends queue) and triggers reconnect via onclose.
      if (this.awaitingPong) this.ws?.close();
    }, PONG_TIMEOUT_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.awaitingPong = false;
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
    if (candidates.length === 0) return undefined;
    // Prefer an exact session match no matter how many chats are mounted.
    if (sessionId) {
      const exact = candidates.find((s) => s.sessionId === sessionId);
      if (exact) return exact;
      // No live subscriber for a *known* session: this is a straggler from a chat
      // whose pane has since unmounted (e.g. the user started another new chat
      // while this turn kept streaming). It must be DROPPED — never handed to a
      // nascent new-chat pane below, or the still-streaming chat's frames bleed
      // into the new chat and the two fuse (issues #35, #100-follow-up). A
      // brand-new chat's own first session-bearing frame is for a session we've
      // never attached, so it stays unknown here and still reaches the nascent
      // pane. This is the routing half of the guard the mounted pane's
      // framesBelong() enforces as a backstop.
      if (this.knownSessions.has(sessionId)) return undefined;
    }
    // No exact match and (if any) an unknown session id: hand the frame to a chat
    // still awaiting its first session id (a freshly-sent new chat).
    const nascent = candidates.find((s) => s.sessionId === null);
    if (nascent) return nascent;
    // A session-less frame (very first frame, or an error) can only belong to a
    // sole subscriber; with a known session and no match, drop it.
    if (sessionId === null && candidates.length === 1) return candidates[0];
    return undefined;
  }

  private dispatch(raw: string): void {
    let msg: ServerWsMessage;
    try {
      msg = JSON.parse(raw) as ServerWsMessage;
    } catch {
      return;
    }
    if (msg.type === "pong") {
      // Liveness confirmed: clear the deadline, refresh the freshness stamp, and
      // flush anything queued while the socket was (briefly) considered stale.
      this.awaitingPong = false;
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      this.lastPongAt = Date.now();
      this.flushOutbox();
      return;
    }

    // The workspace key of the frame's owner. `""` is the ROOT workspace — a
    // real, routable key — so only an ABSENT key means "nothing to route to".
    // A falsy test here silently dropped every root frame, which meant a root
    // chat sent fine and then never rendered a reply: the turn ran server-side,
    // the transcript was written, and the UI just span forever.
    const slug = msg.payload.projectSlug;
    if (slug === undefined || slug === null) return;

    if (msg.type === "chat:error") {
      const sub = this.route(slug, null);
      sub?.handlers.onError?.(msg.payload.error);
      return;
    }

    if (msg.type === "chat:resync") {
      const sub = this.route(slug, msg.payload.sessionId);
      sub?.handlers.onResync?.();
      return;
    }

    if (msg.type === "chat:active") {
      // App-level: update the running-sessions set that drives the sidebar dots,
      // even for chats with no mounted pane.
      this.setActive(msg.payload.sessionId, msg.payload.running, slug);
      // Pane-level: tell the matching mounted chat so it restores/clears its Stop
      // button + streaming indicator (a returning pane learns its turn is live).
      // EXACT session match only — never fall through to a nascent (new-chat) pane,
      // which would wrongly show it as streaming another chat's turn.
      for (const sub of this.subs.values()) {
        if (sub.projectSlug === slug && sub.sessionId === msg.payload.sessionId) {
          sub.handlers.onActive?.({ running: msg.payload.running, jobId: msg.payload.jobId });
        }
      }
      return;
    }

    if (msg.type === "chat:queued_flushed") {
      // The server auto-sent (or is clearing a stale copy of) the queued message.
      // Clear this chat's localStorage copy (#197/#245), and hand any mounted pane
      // the text so it renders the sent bubble + clears its in-memory queued state.
      const { sessionId, text, attachments } = msg.payload as {
        sessionId?: string;
        text?: string;
        attachments?: AttachmentRef[];
      };
      if (sessionId) {
        // Import inline to avoid a circular dependency.
        void import("./queued.js").then(
          ({ writeQueued, writeQueuedId, writeQueuedAttachments }) => {
            writeQueued(sessionId, slug, null);
            writeQueuedId(sessionId, slug, null);
            writeQueuedAttachments(sessionId, slug, []);
          },
        );
        for (const sub of this.subs.values()) {
          if (sub.projectSlug === slug && sub.sessionId === sessionId) {
            sub.handlers.onQueuedFlushed?.({ text, attachments });
          }
        }
      }
      return;
    }

    if (msg.type === "chat:queued_state") {
      // The chat's single queued slot changed server-side (#629). It is shared
      // state now — every attached client renders the same thing — so mirror it
      // into localStorage and hand it to any mounted pane. Before this, a queue was
      // written and never announced: a second client's queue silently replaced the
      // first's, whose chip went on showing a message that no longer existed.
      const { sessionId, text, qid, reason, attachments } = msg.payload as {
        sessionId?: string;
        text?: string | null;
        qid?: string;
        reason?: "returned";
        attachments?: AttachmentRef[];
      };
      if (sessionId) {
        const next = text && text.length > 0 ? text : null;
        // The slot can hold files with no prose (#328/#728), so "is it empty" is
        // text OR attachments — keying the persisted id off `next` alone would
        // forget the identity of an attachment-only slot.
        const atts = attachments ?? [];
        const occupied = next !== null || atts.length > 0;
        void import("./queued.js").then(
          ({ writeQueued, writeQueuedId, writeQueuedAttachments }) => {
            writeQueued(sessionId, slug, next);
            writeQueuedId(sessionId, slug, occupied ? (qid ?? null) : null);
            writeQueuedAttachments(sessionId, slug, atts);
          },
        );
        for (const sub of this.subs.values()) {
          if (sub.projectSlug === slug && sub.sessionId === sessionId) {
            sub.handlers.onQueuedState?.({ text: next, attachments: atts, qid, reason });
          }
        }
      }
      return;
    }

    if (msg.type === "chat:queued_returned") {
      // A Stop gave this chat's queued message back to us rather than sending it
      // (#751). Clear the persisted queue copy — it is a composer draft now, and
      // the pane persists it as one — then hand the text to the mounted pane.
      const { sessionId, text, attachments } = msg.payload as {
        sessionId?: string;
        text?: string;
        attachments?: AttachmentRef[];
      };
      if (sessionId && typeof text === "string") {
        void import("./queued.js").then(
          ({ writeQueued, writeQueuedId, writeQueuedAttachments }) => {
            writeQueued(sessionId, slug, null);
            writeQueuedId(sessionId, slug, null);
            // The files go back to the composer TRAY, which persists them under
            // its own key (#346) — so the queue's copy is forgotten here.
            writeQueuedAttachments(sessionId, slug, []);
          },
        );
        for (const sub of this.subs.values()) {
          if (sub.projectSlug === slug && sub.sessionId === sessionId) {
            sub.handlers.onQueuedReturned?.({ text, attachments });
          }
        }
      }
      return;
    }

    if (msg.type === "chat:killed_task") {
      // Out-of-band (no live turn): a background task was killed at the turn
      // boundary and the keeper is idle (#347). Tell the matching mounted pane so
      // it renders the "keeper is idle / Continue" affordance live — EXACT session
      // match only (never a nascent new-chat pane).
      const { sessionId, summary, timestamp } = msg.payload as {
        sessionId?: string;
        summary?: string;
        timestamp?: string;
      };
      if (sessionId) {
        for (const sub of this.subs.values()) {
          if (sub.projectSlug === slug && sub.sessionId === sessionId) {
            sub.handlers.onKilledTask?.({ summary: summary ?? "", timestamp: timestamp ?? "" });
          }
        }
      }
      return;
    }

    const { sessionId, jobId } = msg.payload;
    const sub = this.route(slug, sessionId);
    if (!sub) return;
    const meta = { sessionId, jobId };

    // Track the per-turn seq so a reconnect can replay exactly the missed gap,
    // and the in-flight flag so it knows whether to ask for a replay (issue #54).
    const seq = (msg.payload as { seq?: number }).seq;
    if (typeof seq === "number" && seq > sub.lastSeq) sub.lastSeq = seq;
    sub.turnActive = msg.type !== "chat:complete";

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
            toolUseId: msg.payload.toolUseId,
            // Live sub-agent enrichment (#429): real type/title + expandable flag,
            // recovered server-side from the launch input so the card fills without
            // a refresh. Undefined for non-sub-agent tools.
            subagentType: msg.payload.subagentType,
            description: msg.payload.description,
            hasSubagent: msg.payload.hasSubagent,
          },
          meta,
        );
        break;
      case "chat:tool_start":
        sub.handlers.onToolStart?.(
          {
            toolName: msg.payload.toolName,
            inputSummary: msg.payload.inputSummary,
            toolUseId: msg.payload.toolUseId,
            output: "",
            isError: false,
            pending: true,
            // Live sub-agent enrichment (#429) — see chat:tool_call above.
            subagentType: msg.payload.subagentType,
            description: msg.payload.description,
            hasSubagent: msg.payload.hasSubagent,
          },
          meta,
        );
        break;
      case "chat:message_boundary":
        sub.handlers.onMessageBoundary?.(meta);
        break;
      case "chat:injected":
        sub.handlers.onInjected?.(
          {
            sender: msg.payload.sender,
            content: msg.payload.content,
            timestamp: msg.payload.timestamp,
          },
          meta,
        );
        break;
      case "chat:notice":
        // #329: a dead-end (usage limit / max-turns / error) surfaced inline
        // during the turn. Session-routed like the other turn frames.
        sub.handlers.onNotice?.(msg.payload.notice, meta);
        break;
      case "chat:complete":
        sub.handlers.onComplete?.({
          ...meta,
          success: msg.payload.success,
          error: msg.payload.error,
          model: msg.payload.model,
          usage: msg.payload.usage,
        });
        break;
    }
  }
}

/** App-wide shared chat socket. */
export const chatClient = new ChatClient();
