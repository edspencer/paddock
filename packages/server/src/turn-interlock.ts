/**
 * Turn interlock (issue #731) — stop a chat's in-flight turn BEFORE a destructive
 * operation mutates its transcript.
 *
 * ## The bug this exists to make impossible
 *
 * A chat's transcript is not something paddock writes: `claude` writes
 * `<sessionId>.jsonl` itself, straight through the symlink `ensureProjectAgent`
 * plants (see `transcripts.ts`). So a destructive operation — delete, promote,
 * revert, project delete — is a race against a live subprocess that still holds
 * that path and will append to it whenever it next has something to say.
 *
 * Deleting the file mid-turn therefore did not delete the chat. The unlink
 * landed, the chat left the list, and ~45s later the still-running process
 * re-created the SAME file containing only its own tail: a 3-line transcript
 * opening on an orphan `tool_result` whose `tool_use` no longer existed. The
 * chat came back, named after its raw session id, with every prior turn
 * permanently gone. Promote lost the chat from BOTH projects the same way.
 *
 * ## The guarantee
 *
 * Nothing here tries to out-race the writer, because that race is unwinnable.
 * Instead {@link quiesceSession} refuses to return "go ahead" until the session
 * is verifiably dead — and a caller that cannot get that answer within its
 * timeout must NOT mutate (the routes return 409 instead). A destructive op
 * therefore only ever runs against a transcript no process holds, and a dead
 * session has nothing left to write itself back with.
 *
 * ## Why two liveness signals
 *
 * `hub.isRunning` sees the WS layer's turn, and `herdctl.isSdkSessionLive` sees
 * herdctl's `SessionReaper` — a session held open past its turn (a killed
 * background task's keepAlive, or the re-invocation grace, #397). Either one
 * means a `claude` process may still write. The recovery engine already pairs
 * them for exactly this reason (`ws-turn.ts`); so do we.
 *
 * ## Why cancel is not enough on its own
 *
 * `herdctl.cancel(jobId)` ends the model TURN. On the session runtime that is an
 * `interrupt()`, which deliberately leaves the session — and its subprocess —
 * alive for the next message. That is right for the Stop button and wrong for a
 * delete, so we also reap the managed session. Cancel and reap are both
 * best-effort; the polled liveness check is what actually decides.
 */
import type { SessionHub } from "./session-hub.js";
import type { HerdctlService } from "./herdctl.js";

/** How long to wait for a cancelled turn to actually die before giving up. */
export const DEFAULT_QUIESCE_TIMEOUT_MS = 10_000;

/** How often to re-check liveness while waiting. */
const POLL_MS = 25;

/**
 * The dependencies the interlock needs. Both come off the route context: `hub`
 * via `ctx.managementOpsContext?.hub` (hence optional — a server built without
 * the WS layer has no hub, and correctly reports nothing running).
 */
export interface TurnInterlockDeps {
  hub: SessionHub | undefined;
  herdctl: HerdctlService;
}

/**
 * - `idle` — nothing was running; the caller may proceed.
 * - `stopped` — a turn WAS running, was stopped, and is now verifiably dead;
 *   the caller may proceed.
 * - `stuck` — something is still alive after the timeout. The caller MUST NOT
 *   mutate the transcript: that is precisely the resurrection case.
 */
export type QuiesceOutcome = "idle" | "stopped" | "stuck";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Is anything alive on this session right now — a live WS turn, or a session
 * herdctl's reaper is still holding open?
 */
export function sessionIsBusy(deps: TurnInterlockDeps, sessionId: string): boolean {
  if (deps.hub?.isRunning(sessionId) === true) return true;
  return deps.herdctl.isSdkSessionLive(sessionId);
}

/**
 * Stop whatever is running against `sessionId` and WAIT for it to actually be
 * gone. Returns `stuck` rather than throwing, so each caller can pick its own
 * failure shape (a 409, or a `failed` bucket entry in a batch).
 *
 * A running turn is not always cancellable the instant we look at it: `jobId`
 * is null early in a turn (it arrives with the first frames). That is why this
 * polls rather than cancelling once — each pass re-reads `activeInfo` and
 * cancels any job id it has not cancelled yet, so a turn that arms its job id a
 * beat later is still caught inside the same call.
 */
export async function quiesceSession(
  deps: TurnInterlockDeps,
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<QuiesceOutcome> {
  if (!sessionIsBusy(deps, sessionId)) return "idle";

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS);
  const cancelled = new Set<string>();
  let reaped = false;

  // Mark the turn end this is about to cause as OURS, not a user's Stop. The WS
  // layer treats the two oppositely for anything queued behind the turn: a Stop
  // hands the message back to the user's composer, while this caller is about to
  // delete, revert or promote the transcript — so the queue must be left strictly
  // alone. Draining it here would start a fresh turn on a chat being removed (the
  // #730 resurrection), and would make the session busy again so the poll below
  // could never settle.
  deps.hub?.noteCancel(sessionId, { reason: "quiesce", origin: null });

  for (;;) {
    const jobId = deps.hub?.activeInfo(sessionId)?.jobId ?? null;
    if (jobId && !cancelled.has(jobId)) {
      cancelled.add(jobId);
      await deps.herdctl.cancel(jobId).catch(() => false);
    }
    // Close the managed session too — on the session runtime `cancel` only
    // interrupts the turn and leaves the subprocess holding the transcript.
    // Once is enough; a second reap of an already-closed session is a no-op.
    if (!reaped) {
      reaped = true;
      deps.herdctl.reapSession(sessionId);
    }
    if (!sessionIsBusy(deps, sessionId)) return "stopped";
    if (Date.now() >= deadline) return "stuck";
    await delay(POLL_MS);
  }
}

/**
 * Quiesce every session with a running turn in `projectSlug`, ahead of a project
 * delete. Returns the ids that could NOT be stopped — empty means it is safe to
 * remove the project directory.
 *
 * Only the hub can enumerate running turns by project, so a server with no hub
 * simply has nothing to stop.
 */
export async function quiesceProject(
  deps: TurnInterlockDeps,
  projectSlug: string,
  opts: { timeoutMs?: number } = {},
): Promise<string[]> {
  const running = (deps.hub?.runningSessions() ?? []).filter((i) => i.projectSlug === projectSlug);
  // Concurrent: each turn dies independently, so the whole call is bounded by one
  // timeout rather than N of them stacked end to end.
  const outcomes = await Promise.all(
    running.map(async (info) => [info.sessionId, await quiesceSession(deps, info.sessionId, opts)] as const),
  );
  return outcomes.filter(([, outcome]) => outcome === "stuck").map(([sessionId]) => sessionId);
}

/** The 409 body every refusing route sends, so clients can match one code. */
export function turnRunningError(sessionIds: string[]): {
  error: string;
  code: "turn_running";
  sessionIds: string[];
} {
  return {
    error:
      sessionIds.length === 1
        ? `A turn is still running on chat ${sessionIds[0]} and could not be stopped; try again.`
        : `Turns are still running on ${sessionIds.length} chats and could not be stopped; try again.`,
    code: "turn_running",
    sessionIds,
  };
}
