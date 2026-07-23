/**
 * Resume self-interrupt fix — drain a stale async-input backlog before the real turn.
 *
 * ## The bug this fixes
 *
 * When a keeper session is resumed and the `claude` CLI still holds a stale
 * async-input backlog (leftover `killed`/orphaned `<task-notification>` messages
 * from background shells/subagents a previous process left running), the CLI's
 * drain loop replays that backlog as its **own turn**, emitting that turn's
 * `result` FIRST — ahead of the human/wake/command turn.
 *
 * Every resume consumer used to `break` its `for await (const m of session.messages)`
 * loop on the FIRST `result`. Breaking a `for await` invokes the async generator's
 * `.return()`, which tears the SDK query / `claude` subprocess down (with only a
 * ~2s SIGTERM grace). So the backlog turn's result closed the subprocess out from
 * under the still-running real turn — killing it (`[Request interrupted by user]` /
 * `interruptedByShutdown:true`, the human message lost). It is intermittent because
 * it races the real turn against the ~2s teardown grace: a fast reply survives; a
 * slow (heavy-keeper) reply is killed.
 *
 * ## The fix
 *
 * {@link consumeResumedTurn} consumes the resumed stream and breaks on a `result`
 * only once the on-disk async-input queue has DRAINED (depth 0) — i.e. after the
 * LAST (real) turn, never after a backlog turn. So a backlog turn's result can no
 * longer tear the real turn down.
 *
 * The gate is **dynamic** (the queue depth is probed after each turn's result), not
 * a one-shot pre-probe. This is deliberate: a backlog can materialize DURING the
 * resume — a crashed process that left background work running writes no `killed`
 * notification, so the CLI reconciles those orphans into the queue at resume time,
 * *after* any pre-open probe would have read 0. Dynamic probing catches both the
 * already-on-disk residue and the reconciled-at-resume residue.
 *
 * Zero added latency when there is no backlog: the real prompt is not enqueued into
 * the async queue when the CLI is idle, so the queue depth is 0 the moment the first
 * (and only) turn completes → we break after the first result exactly like before.
 *
 * Robustness:
 * - The per-turn wait is bounded only for the wait for a turn's FIRST message (so a
 *   not-yet-flushed dequeue can't hang us forever waiting on a backlog turn that
 *   never arrives). Once a turn starts producing, it is consumed to its `result`
 *   UNBOUNDED — a slow real turn is never cut off mid-flight.
 * - An overall deadline is the ultimate safety net.
 * - A single in-flight `next()` is threaded throughout, so the iterator is never
 *   advanced twice concurrently.
 */
import type { SDKMessage } from "@herdctl/core";
import type { RuntimeSession } from "@herdctl/core";

/** A loosely-typed view of the fields we read off an {@link SDKMessage}. */
type Msg = {
  type?: string;
  subtype?: string;
  success?: boolean;
  session_id?: string;
};

/** Bounds only the wait for a turn's FIRST message (never mid-turn): a stale
 * (not-yet-flushed) residue read must not hang us on a backlog turn that never
 * arrives. Comfortably longer than the CLI's inter-turn gap. */
const FIRST_MESSAGE_TIMEOUT_MS = 8000;
/** Overall ceiling so consumption can never hang indefinitely. */
const DEFAULT_DEADLINE_MS = 180000;

export interface ConsumeResumedTurnOptions {
  /** Current on-disk async-input-queue depth for this session (0 = drained). */
  residueProbe: () => Promise<number>;
  /** Surface a message to the client (translate/emit). */
  onMessage?: (m: SDKMessage) => void | Promise<void>;
  /** Called with the session id the moment it first appears in the stream. */
  onSessionId?: (id: string) => void;
  /** Overall deadline (ms). Default {@link DEFAULT_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Optional trace hook — invoked only when a backlog was actually drained. */
  log?: (msg: string) => void;
}

export interface ConsumeResumedTurnResult {
  /** True unless the real turn's terminal `result` was an error/`success:false`. */
  success: boolean;
  /** The session id seen on the stream, if any. */
  sessionId: string | null;
  /**
   * The live iterator this consume drove, handed back so the caller can KEEP
   * consuming the SAME stream after the primary turn — without opening a second
   * iterator over the SDK query (which would split messages unpredictably). Used
   * by the Gap B background-turn delivery ({@link consumeBackgroundTurns}): the
   * session is left open by the reaper for in-flight background work, and the
   * autonomous re-invocation turns it later produces arrive on this iterator.
   */
  iterator: AsyncIterator<SDKMessage>;
  /**
   * The single in-flight `iterator.next()` left outstanding when we stopped
   * consuming (awaiting the message AFTER the primary turn's terminal `result`).
   * Handing it back — rather than dropping it and re-pulling — means no message
   * between the primary result and the first background re-invocation is lost.
   */
  pending: Promise<Step>;
}

function isErrorResult(m: Msg): boolean {
  return (typeof m.subtype === "string" && m.subtype.startsWith("error")) || m.success === false;
}

type Step = IteratorResult<SDKMessage>;

/**
 * Pump the message stream until the next terminal `result`, invoking `onMessage`
 * per message. Drives a SINGLE in-flight `next()` (threaded via `pending`) so the
 * iterator is never advanced twice concurrently.
 *
 * `firstMessageTimeoutMs` bounds ONLY the wait for this turn's first message; once
 * a message has been received the turn is consumed to its `result` unbounded (a
 * slow turn is never cut off). On a first-message timeout the still-in-flight
 * `pending` is handed straight back to the caller.
 */
async function pumpToResult(
  iterator: AsyncIterator<SDKMessage>,
  pending: Promise<Step>,
  onMessage: ((m: SDKMessage) => void | Promise<void>) | undefined,
  onSessionId: ((id: string) => void) | undefined,
  firstMessageTimeoutMs: number | undefined,
): Promise<{ pending: Promise<Step>; result: Msg | null; done: boolean; timedOut: boolean }> {
  let awaitingFirst = true;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let step: Step;
    if (awaitingFirst && firstMessageTimeoutMs !== undefined) {
      const TIMED_OUT = Symbol("first-message-timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raced = await Promise.race<Step | typeof TIMED_OUT>([
        pending,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), firstMessageTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (raced === TIMED_OUT) return { pending, result: null, done: false, timedOut: true };
      step = raced as Step;
    } else {
      step = await pending;
    }
    if (step.done) return { pending: Promise.resolve(step), result: null, done: true, timedOut: false };
    awaitingFirst = false;
    const m = step.value as Msg;
    if (m.session_id && onSessionId) onSessionId(m.session_id);
    if (onMessage) await onMessage(step.value);
    if (m.type === "result") {
      return { pending: iterator.next(), result: m, done: false, timedOut: false };
    }
    pending = iterator.next();
  }
}

/**
 * Consume a resumed session's stream to the caller's real turn, first draining any
 * stale async-input backlog that replays ahead of it. See the module doc.
 *
 * The session must already have the caller's prompt seeded (chatSession opens with
 * the prompt; runCommand `send`s the command; the wake path is opened with its
 * prompt by herdctl) — this only governs WHEN we stop consuming, never what runs.
 */
export async function consumeResumedTurn(
  session: RuntimeSession,
  opts: ConsumeResumedTurnOptions,
): Promise<ConsumeResumedTurnResult> {
  const iterator = session.messages[Symbol.asyncIterator]();
  let pending = iterator.next();
  let sessionId: string | null = null;
  const onSid = (id: string): void => {
    sessionId = id;
    opts.onSessionId?.(id);
  };
  const overallDeadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  let success = false;
  let turns = 0;
  while (Date.now() < overallDeadline) {
    // Bound only the wait for the next turn's first message while a backlog may
    // still be queued (residue > 0); wait unbounded when the queue is empty (the
    // running turn is the real one and may be slow).
    const firstMsgTimeout = (await opts.residueProbe()) > 0 ? FIRST_MESSAGE_TIMEOUT_MS : undefined;
    const r = await pumpToResult(iterator, pending, opts.onMessage, onSid, firstMsgTimeout);
    pending = r.pending;
    if (r.done) break;
    if (r.timedOut) break; // no further turn arrived → the queue is effectively drained
    if (r.result) {
      turns++;
      success = !isErrorResult(r.result);
    }
    if ((await opts.residueProbe()) === 0) break; // async queue drained → real turn done
  }
  if (turns > 1) opts.log?.(`drained ${turns - 1} backlog turn(s) ahead of the real turn`);
  return { success, sessionId, iterator, pending };
}

/**
 * Gap B — deliver autonomous background-completion turns.
 *
 * After {@link consumeResumedTurn} returns, the primary turn is done but the
 * session may be held OPEN by the reaper because the turn launched continuous
 * background work (`decideReap` keepAlives while `backgroundTasks.length > 0`).
 * The `claude` subprocess keeps running and, when a background task completes,
 * the SDK hands the parent the result as a fresh autonomous re-invocation turn —
 * emitted on the SAME message stream. Paddock used to stop consuming at the
 * primary `result`, so those messages buffered undelivered: the CLI still
 * PERSISTED the re-invocation to the transcript (the subprocess writes JSONL
 * directly), but the live UI never saw it until a refresh replayed history.
 *
 * This keeps consuming the handed-back {@link ConsumeResumedTurnResult.iterator}
 * (never a second iterator — that would split the stream), forwarding every
 * subsequent message to `onMessage`. The caller's `onMessage` renders each
 * autonomous turn to the hub exactly like the scheduler-wake path does, so it
 * appears live. Consumption ALSO keeps `tapLifecycleStream` advancing, so the
 * reaper keeps receiving its mid-turn `activity` / `background_tasks_changed`
 * signals (they fire as a side effect of the consumer pulling messages) — the
 * behaviour the reaper was designed around.
 *
 * The loop ends cleanly when the reaper reaps the idle session: `close()` ends
 * the SDK query, the iterator yields `done`, and we return. A stream error is
 * swallowed (the turn is already over). Detached by the caller (`void`), it
 * never throws to the event loop.
 */
export async function consumeBackgroundTurns(
  iterator: AsyncIterator<SDKMessage>,
  pending: Promise<Step>,
  onMessage: (m: SDKMessage) => void | Promise<void>,
  onDone?: () => void | Promise<void>,
): Promise<void> {
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let step: Step;
      try {
        step = await pending;
      } catch {
        return; // stream errored/closed — nothing more to deliver
      }
      if (step.done) return; // reaper reaped the session → stream ended
      try {
        await onMessage(step.value);
      } catch {
        /* a rendering failure for one message must not abort delivery */
      }
      pending = iterator.next();
    }
  } finally {
    // Signal the caller (the background sink) that the stream has ended so it can
    // finalize its single hub turn (emit chat:complete + turn.end()). Runs on
    // normal end, error, or reap. Never throws to the event loop.
    try {
      await onDone?.();
    } catch {
      /* completion signalling must not throw to a detached consumer */
    }
  }
}
