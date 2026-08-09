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
  /**
   * The socket that started the turn; always a fan-out target while OPEN. `null`
   * for a server-initiated turn with no client watching (a scheduler-fired
   * wake — Paddock#111): frames are still buffered for replay so a client that
   * attaches mid-turn (or opens the chat afterward) sees the woken work.
   */
  origin: HubSocket | null;
  frames: BufferedFrame[];
  /** `seq` of `frames[0]` after any trim — replays older than this need a resync. */
  baseSeq: number;
  nextSeq: number;
  running: boolean;
  /**
   * Epoch-ms the turn began. The hub is the only place that knows this: a job
   * record is written when a turn ENDS, and the transcript's own timestamps are
   * the model's, not the run's. Surfaced on {@link ActiveInfo} so a client that
   * loads mid-turn — or reconnects — can still say how long the fleet has been
   * working, rather than restarting every clock at zero on every page load.
   */
  startedAt: number;
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
  /** Epoch-ms this turn started. See {@link Turn.startedAt}. */
  startedAt: number;
}

/** Why a turn is being cancelled, and which socket asked for it. */
export interface CancelIntent {
  /**
   * `stop` — a user pressed Stop (`chat:cancel`): they are taking control back.
   * `quiesce` — a destructive op is stopping the turn so it can safely mutate
   * the transcript (#731); the chat is being deleted, reverted or promoted.
   */
  reason: "stop" | "quiesce";
  /** The socket that asked, if any. */
  origin: HubSocket | null;
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
   * Notified once per turn, when that turn stops running (#627). Set by the WS
   * layer, which uses it to drain a queued follow-up.
   *
   * This exists because "after a turn" was, for a long time, spelled as a call at
   * ONE of the eight `turn.end()` sites — the `chat:send` completion. A message
   * queued during a slash command, a trigger/spawn turn, a scheduler wake, a
   * background sub-agent stretch or a Stopped turn was therefore persisted and
   * then stranded, escaping only when some LATER `chat:send` happened to flush it —
   * arriving after a message the user typed afterwards. Every one of those paths
   * already funnels through {@link end}, so hanging the drain here makes "drain on
   * every turn-ending path" structural rather than a list somebody has to remember
   * to extend — including for turn paths that don't exist yet.
   *
   * Fires only once a turn's session id is known (a turn that died before its id
   * resolved has no chat to drain), and always AFTER the terminal frame its caller
   * emitted, so a drained follow-up's bubble lands below the turn it followed.
   */
  onTurnEnd:
    | ((info: {
        sessionId: string;
        projectSlug: string;
        origin: HubSocket | null;
        /** Set when this end was CAUSED by an explicit cancel — see {@link noteCancel}. */
        cancel?: CancelIntent;
      }) => void)
    | null = null;

  /**
   * Why a turn was cancelled, and by whom, pending the end it causes.
   * Consumed by the next {@link end} for that session.
   */
  private cancels = new Map<string, CancelIntent>();

  /**
   * Record that a cancel was just issued for `sessionId`, so the turn end it
   * causes can be told apart from a turn that finished on its own.
   *
   * The distinction is not cosmetic: "the turn ended" and "the user took control
   * back" call for opposite treatment of anything queued behind that turn. A
   * `stop` hands the queued message back to the client that pressed Stop; a
   * `quiesce` (the destructive-op interlock, #731) must not touch it at all —
   * that caller is about to delete or rewrite the transcript, and starting a
   * fresh turn into it is the resurrection #730 was about.
   *
   * `origin` is the socket that asked, so the WS layer knows where to hand the
   * message back; null when the cancel came from no socket at all.
   */
  noteCancel(sessionId: string, intent: CancelIntent): void {
    this.cancels.set(sessionId, intent);
  }

  /**
   * Begin tracking a turn. Pass `sessionId` when it's already known (a resumed
   * chat / a slash command) so the turn is re-attachable from its very first
   * frame; omit it for a brand-new chat and call {@link TurnHandle.setSession}
   * once the id arrives on the stream.
   */
  startTurn(projectSlug: string, origin: HubSocket | null, sessionId?: string | null): TurnHandle {
    const turn: Turn = {
      projectSlug,
      sessionId: null,
      jobId: null,
      origin,
      frames: [],
      baseSeq: 0,
      nextSeq: 0,
      running: true,
      startedAt: Date.now(),
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

  /**
   * Send a one-off control frame to every socket attached to a session — its
   * (recently-)tracked turn's origin plus every subscribed socket (#245). Unlike
   * {@link emit} this is not seq-stamped or buffered; it's for out-of-band signals
   * like `chat:queued_flushed` that must reach a client that reconnected on a new
   * socket after the origin died.
   */
  broadcast(sessionId: string, msg: HubMessage, opts: { except?: HubSocket | null } = {}): void {
    const set = new Set<HubSocket>();
    const turn = this.bySession.get(sessionId);
    if (turn?.origin) set.add(turn.origin);
    const subs = this.subscribers.get(sessionId);
    if (subs) for (const s of subs) set.add(s);
    if (opts.except) set.delete(opts.except);
    for (const s of set) SessionHub.write(s, msg);
  }

  /**
   * The session a cancellable job id belongs to, or null if no tracked turn
   * carries it. `chat:cancel` names only a job id, so this is how the WS layer
   * learns WHICH chat a Stop was aimed at. Covers a background stretch too — it
   * publishes its synthetic id on its own hub turn (#528).
   */
  sessionForJob(jobId: string): { sessionId: string; projectSlug: string } | null {
    for (const [sessionId, turn] of this.bySession) {
      if (turn.jobId === jobId) return { sessionId, projectSlug: turn.projectSlug };
    }
    return null;
  }

  // --- internals, driven by TurnHandle -------------------------------------

  /** Whether a session currently has a RUNNING turn plus its job id, or null. */
  activeInfo(sessionId: string): ActiveInfo | null {
    const turn = this.bySession.get(sessionId);
    if (!turn || !turn.running) return null;
    return {
      sessionId,
      projectSlug: turn.projectSlug,
      jobId: turn.jobId,
      running: true,
      startedAt: turn.startedAt,
    };
  }

  /** Snapshot of every session with a running turn (for a newly-connected client). */
  runningSessions(): ActiveInfo[] {
    const out: ActiveInfo[] = [];
    for (const [sessionId, turn] of this.bySession) {
      if (turn.running) {
        out.push({
          sessionId,
          projectSlug: turn.projectSlug,
          jobId: turn.jobId,
          running: true,
          startedAt: turn.startedAt,
        });
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
    if (!turn.running) return; // already ended — never fire onTurnEnd twice
    turn.running = false;
    if (turn.sessionId) {
      this.fireActive(turn);
      turn.evictTimer = setTimeout(() => this.evict(turn), COMPLETED_TTL_MS);
      turn.evictTimer.unref?.();
      // #627: the session is idle again — let the WS layer deal with anything
      // queued behind this turn. Never allowed to throw into a caller finalizing
      // its turn. A pending cancel intent belongs to THIS end, so consume it.
      const cancel = this.cancels.get(turn.sessionId);
      this.cancels.delete(turn.sessionId);
      if (this.onTurnEnd) {
        const { sessionId, projectSlug, origin } = turn;
        try {
          this.onTurnEnd({ sessionId, projectSlug, origin, ...(cancel ? { cancel } : {}) });
        } catch {
          /* a drain that throws must not break turn teardown */
        }
      }
    }
  }

  /**
   * Re-broadcast a running turn's active state once its jobId becomes known, so
   * clients can arm the Stop button before the first content frame (Paddock#111).
   * No-op if the turn isn't running or its session id isn't resolved yet (a new
   * chat learns the jobId together with its session id on the first frame).
   */
  jobIdResolved(turn: Turn): void {
    if (turn.running) this.fireActive(turn);
  }

  private fireActive(turn: Turn): void {
    if (!this.onActive || !turn.sessionId) return;
    this.onActive({
      sessionId: turn.sessionId,
      projectSlug: turn.projectSlug,
      jobId: turn.jobId,
      running: turn.running,
      startedAt: turn.startedAt,
    });
  }

  private recipients(turn: Turn): Set<HubSocket> {
    const set = new Set<HubSocket>();
    // A client-less woken turn (Paddock#111) has no origin; frames are still
    // buffered for replay, they just have no live origin socket to fan out to.
    if (turn.origin) set.add(turn.origin);
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
    // Push the now-known jobId to attached clients immediately (via chat:active),
    // so the Stop button is ARMED even while the model is still "thinking" and no
    // content frame has yet carried the jobId in its routing metadata. Without
    // this, Stop silently no-ops during the (often long) pre-output phase because
    // the client has no jobId to cancel — the original "Stop does nothing" bug
    // (Paddock#111). Fixes both drive modes (batch + session).
    this.hub.jobIdResolved(this.turn);
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
