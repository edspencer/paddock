/**
 * SessionHub — session-scoped fan-out + re-attach for in-flight chat turns.
 *
 * The problem it solves (issue #54): a turn's stream used to be bound to the ONE
 * socket that sent `chat:send`. Frames were written straight to that socket and
 * silently dropped whenever it wasn't OPEN. So if the socket died mid-turn (idle
 * half-open drop, laptop sleep, wifi change, the client's own auto-reconnect
 * swapping sockets), every remaining frame of the running turn was lost — the
 * live stream stalled and only a full page reload (which re-hydrates from the
 * persisted transcript) recovered it.
 *
 * The hub decouples a turn from any single socket:
 *
 *  - Every emitted frame is buffered on the turn and stamped with a per-turn,
 *    monotonic `seq`.
 *  - Frames fan out to the turn's ORIGIN socket PLUS every socket currently
 *    subscribed to the turn's session (dead sockets are skipped, not dropped-
 *    on-the-floor-permanently — a live one still gets the frame).
 *  - A reconnecting client re-`attach`es to the session and replays exactly the
 *    frames it missed (everything with `seq` greater than the last it applied),
 *    so the stream resumes seamlessly with no gap and no duplication.
 *
 * A just-completed turn's buffer is retained briefly ({@link COMPLETED_TTL_MS})
 * so a client that reconnects right at the end still receives the tail frames
 * (including the terminal `chat:complete`) rather than hanging "streaming"
 * forever.
 *
 * The hub is transport-shaped but transport-agnostic: it only needs a socket it
 * can check `readyState` on and `send` a JSON string to (the `HubSocket`
 * minimal interface), so it is unit-testable without a real WebSocket.
 */

/** The slice of a WebSocket the hub needs — real `ws` sockets satisfy this. */
export interface HubSocket {
  readyState: number;
  /** WebSocket.OPEN (1) — read off the instance so tests can fake it. */
  readonly OPEN: number;
  send(data: string): void;
}

/** A server→client frame the hub buffers and fans out. `payload.seq` is stamped by the hub. */
export interface HubMessage {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * The frame shape `emit` accepts. `payload` is any object (the caller's typed
 * routing payloads are interfaces without a string index signature, so they
 * don't satisfy `Record<string, unknown>` directly); the hub treats it opaquely
 * and only adds `seq`.
 */
export interface HubMessageInput {
  type: string;
  payload: object;
}

interface BufferedFrame {
  seq: number;
  msg: HubMessage;
}

interface Turn {
  projectSlug: string;
  /** Null until the turn's session id is known (a brand-new chat resolves it mid-stream). */
  sessionId: string | null;
  jobId: string | null;
  /** The socket that started the turn; always a fan-out target while OPEN. */
  origin: HubSocket;
  frames: BufferedFrame[];
  /** `seq` of `frames[0]` after any trim — replays older than this need a resync. */
  baseSeq: number;
  nextSeq: number;
  running: boolean;
  evictTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Max frames retained per turn. A turn is a dozen assistant messages + tool
 * calls → low hundreds of frames typically; 4000 is generous headroom while
 * bounding memory. Overflow trims the oldest frames and a re-attach that needs
 * them falls back to a transcript resync (correctness preserved, live-ness lost
 * only in the pathological case).
 */
const MAX_FRAMES = 4000;

/** How long a completed turn's buffer lingers so an end-of-turn reconnect still gets the tail. */
export const COMPLETED_TTL_MS = 60_000;

/** The outcome of an {@link SessionHub.attach}. */
export type AttachResult =
  | { status: "none" }
  | { status: "replayed"; frames: number }
  | { status: "resync"; projectSlug: string };

/**
 * A session's live-turn status, surfaced so the UI can restore the Stop button
 * and streaming indicators (issues #52/#53). Emitted on start/stop transitions
 * via {@link SessionHub.onActive} and readable via {@link SessionHub.activeInfo}.
 */
export interface ActiveInfo {
  sessionId: string;
  projectSlug: string;
  /** The running turn's cancellable job id, if known yet (null early in a turn). */
  jobId: string | null;
  running: boolean;
}

export class SessionHub {
  /** sessionId → the current (running or recently-completed) turn for that session. */
  private bySession = new Map<string, Turn>();
  /** sessionId → sockets attached to it (fan-out targets beyond the origin). */
  private subscribers = new Map<string, Set<HubSocket>>();

  /**
   * Notified on every running-state transition (turn start / stop) so the WS
   * layer can broadcast a `chat:active` signal to clients — powering the Stop
   * button restore (#52) and streaming indicators (#53). Set by the WS layer.
   */
  onActive: ((info: ActiveInfo) => void) | null = null;

  /**
   * Begin tracking a turn. Pass `sessionId` when it's already known (a resumed
   * chat / a slash command) so the turn is re-attachable from its very first
   * frame; omit it for a brand-new chat and call {@link TurnHandle.setSession}
   * once the id arrives on the stream.
   */
  startTurn(projectSlug: string, origin: HubSocket, sessionId?: string | null): TurnHandle {
    const turn: Turn = {
      projectSlug,
      sessionId: null,
      jobId: null,
      origin,
      frames: [],
      baseSeq: 0,
      nextSeq: 0,
      running: true,
      evictTimer: null,
    };
    const handle = new TurnHandle(this, turn);
    if (sessionId) this.register(turn, sessionId);
    return handle;
  }

  /** Add a socket to a session's fan-out set (idempotent). */
  subscribe(sessionId: string, socket: HubSocket): void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(socket);
  }

  /**
   * Attach a (re)connecting socket to a session and, when `wantReplay`, catch it
   * up on a still-live turn by replaying every buffered frame after `afterSeq`.
   *
   * `wantReplay` MUST be false for a fresh mount (one that also hydrates the
   * transcript over REST) so buffered frames don't duplicate the transcript; it
   * is true only for a genuine reconnect of a socket that was mid-turn, where
   * `afterSeq` is the last seq the client applied and the replay is exactly the
   * gap. Replays are written straight to `socket` (not the whole fan-out).
   */
  attach(
    sessionId: string,
    socket: HubSocket,
    opts: { wantReplay: boolean; afterSeq: number },
  ): AttachResult {
    this.subscribe(sessionId, socket);
    const turn = this.bySession.get(sessionId);
    if (!turn || !opts.wantReplay) return { status: "none" };

    const from = opts.afterSeq + 1;
    if (from < turn.baseSeq) {
      // The gap the client needs has been trimmed — it must re-hydrate instead.
      return { status: "resync", projectSlug: turn.projectSlug };
    }
    let n = 0;
    for (const f of turn.frames) {
      if (f.seq >= from) {
        SessionHub.write(socket, f.msg);
        n++;
      }
    }
    return { status: "replayed", frames: n };
  }

  /** Drop a socket from every session's fan-out set (call on socket close). */
  unsubscribeSocket(socket: HubSocket): void {
    for (const [id, set] of this.subscribers) {
      if (set.delete(socket) && set.size === 0) this.subscribers.delete(id);
    }
  }

  /** Whether a session currently has a RUNNING turn (used by the active-turns signal). */
  isRunning(sessionId: string): boolean {
    return this.bySession.get(sessionId)?.running === true;
  }

  // --- internals, driven by TurnHandle -------------------------------------

  /** Whether a session currently has a RUNNING turn plus its job id, or null. */
  activeInfo(sessionId: string): ActiveInfo | null {
    const turn = this.bySession.get(sessionId);
    if (!turn || !turn.running) return null;
    return { sessionId, projectSlug: turn.projectSlug, jobId: turn.jobId, running: true };
  }

  /** Snapshot of every session with a running turn (for a newly-connected client). */
  runningSessions(): ActiveInfo[] {
    const out: ActiveInfo[] = [];
    for (const [sessionId, turn] of this.bySession) {
      if (turn.running) {
        out.push({ sessionId, projectSlug: turn.projectSlug, jobId: turn.jobId, running: true });
      }
    }
    return out;
  }

  /** Register a turn under its resolved session id, evicting any prior turn there. */
  register(turn: Turn, sessionId: string): void {
    if (turn.sessionId === sessionId) return;
    if (turn.sessionId) this.bySession.delete(turn.sessionId);
    turn.sessionId = sessionId;
    const prev = this.bySession.get(sessionId);
    if (prev && prev !== turn) this.evict(prev);
    this.bySession.set(sessionId, turn);
    // A turn becomes visible-as-running the moment its session id is known.
    if (turn.running) this.fireActive(turn);
  }

  /** Stamp `seq`, buffer (with trim), and fan out to origin + subscribers. */
  emit(turn: Turn, base: HubMessageInput): void {
    const seq = turn.nextSeq++;
    const stamped: HubMessage = {
      type: base.type,
      payload: { ...(base.payload as Record<string, unknown>), seq },
    };
    turn.frames.push({ seq, msg: stamped });
    if (turn.frames.length > MAX_FRAMES) {
      turn.frames.shift();
      turn.baseSeq = turn.frames[0]?.seq ?? seq;
    }
    for (const socket of this.recipients(turn)) SessionHub.write(socket, stamped);
  }

  /** Mark a turn finished; retain its buffer briefly for an end-of-turn reconnect. */
  end(turn: Turn): void {
    turn.running = false;
    if (turn.sessionId) {
      this.fireActive(turn);
      turn.evictTimer = setTimeout(() => this.evict(turn), COMPLETED_TTL_MS);
      turn.evictTimer.unref?.();
    }
  }

  private fireActive(turn: Turn): void {
    if (!this.onActive || !turn.sessionId) return;
    this.onActive({
      sessionId: turn.sessionId,
      projectSlug: turn.projectSlug,
      jobId: turn.jobId,
      running: turn.running,
    });
  }

  private recipients(turn: Turn): Set<HubSocket> {
    const set = new Set<HubSocket>();
    set.add(turn.origin);
    if (turn.sessionId) {
      const subs = this.subscribers.get(turn.sessionId);
      if (subs) for (const s of subs) set.add(s);
    }
    return set;
  }

  private evict(turn: Turn): void {
    if (turn.evictTimer) {
      clearTimeout(turn.evictTimer);
      turn.evictTimer = null;
    }
    if (turn.sessionId && this.bySession.get(turn.sessionId) === turn) {
      this.bySession.delete(turn.sessionId);
    }
  }

  private static write(socket: HubSocket, msg: HubMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* a socket that throws on send is effectively gone; the reconnect path recovers it */
    }
  }
}

/**
 * A per-turn handle the WS layer drives: stamp/fan-out frames via {@link emit},
 * learn the session id via {@link setSession}, and finish via {@link end}.
 */
export class TurnHandle {
  constructor(
    private readonly hub: SessionHub,
    private readonly turn: Turn,
  ) {}

  get jobId(): string | null {
    return this.turn.jobId;
  }

  setJobId(id: string): void {
    this.turn.jobId = id;
  }

  /** Register (or move) this turn under its now-known session id. Idempotent. */
  setSession(sessionId: string): void {
    this.hub.register(this.turn, sessionId);
  }

  /** Buffer + fan out one frame to every live socket attached to this turn's session. */
  emit(base: HubMessageInput): void {
    this.hub.emit(this.turn, base);
  }

  /** Finish the turn (buffer retained briefly for a late reconnect). */
  end(): void {
    this.hub.end(this.turn);
  }
}
