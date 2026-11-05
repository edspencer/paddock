/**
 * What `GET /api/busy` answers (CLI contract SPEC §4, ROADMAP "Busy, per tool").
 *
 * ## What "busy" means here
 *
 * Only work **a restart would lose or cut short** — the kind someone would be
 * annoyed to find killed. For Paddock that is three things, and the ROADMAP row
 * names them:
 *
 *  - **`chat`** — a chat turn running. This is the one that matters: a turn is a
 *    live `claude` subprocess writing a transcript, and `herdctl.stop()` ends it
 *    with `waitForJobs: false`. A fired trigger or a cron schedule is NOT a
 *    fourth kind, because every one of them runs as a first-class chat on the
 *    hub (`ws-triggers.ts` — one `startAgentTurn` for every trigger type), so it
 *    is already counted here.
 *  - **`background`** — background work a live SDK session is still holding
 *    after its turn ended (#604): a `run_in_background` shell, a sub-agent, a
 *    `Monitor`. These outlive the `Turn` record, so the hub cannot see them.
 *  - **`job`** — herdctl's scheduler running a job. Paddock routes a keeper's
 *    schedule fire back onto the hub, so in practice this double-counts with
 *    `chat` for the window where both are true; a count that is occasionally
 *    high by one is the right failure direction for a check whose answer is
 *    "wait a moment".
 *
 * ## What is deliberately NOT busy
 *
 *  - **Idle live sessions.** A session the reaper is holding open with no turn
 *    and no background task resumes after a restart; that is the whole point of
 *    a resumable session.
 *  - **The post-turn sweeper.** It is re-runnable from its watermark, so losing
 *    one is a re-sweep rather than lost work. The ROADMAP row leaves it out too.
 *  - **Open browsers.** A page reconnects to `/ws` and replays.
 *
 * ## Cheap, and in-memory only
 *
 * §4 requires this to read in-memory state, never walk the disk, and answer in
 * well under a second — it is called by Watchtower's pre-update hook and by
 * every `service stop`. So each source here is a `Map.size` or a filtered
 * iteration over one, and {@link collectBusy} is synchronous.
 *
 * That rules out the obvious source for `job`. `fleetStatus().counts.runningJobs`
 * is what the ROADMAP names, and `FleetStatus` is built by `getAgentInfo()`,
 * which **reads the fleet state file off disk** on every call (herdctl's
 * `StatusQueries.readFleetStateSnapshot`) — the same re-parse that was 61% of
 * this server's CPU once. `counts.runningJobs` reduces to
 * `Σ scheduler.getRunningJobCount(agent)`, and the scheduler also publishes
 * `getTotalRunningJobCount()` over the same in-memory map, so Paddock asks the
 * scheduler directly for an identical number with no file read.
 *
 * ## No labels, ids or titles
 *
 * Counts only, for every caller, until SPEC §10's first question (how a CLI
 * proves it is local) is designed. That is why this route needs no auth: there
 * is nothing in the answer to protect. A chat's TITLE would be a different
 * matter, and is exactly what `reasons` will carry once there is a way to know
 * who is asking — so nothing here may grow a string field by accident.
 */

/** The non-zero kinds the CLI's message names: `Paddock is busy: 2 chats are running.` */
export interface BusyCounts {
  /** Chat turns running — a human turn, a fired trigger, a cron fire. */
  chat: number;
  /** Background tasks live sessions are still holding after their turn (#604). */
  background: number;
  /** herdctl scheduler jobs in flight. */
  job: number;
}

/** The `/api/busy` body (SPEC §4). */
export interface BusyBody {
  busy: boolean;
  version: string;
  counts: BusyCounts;
}

/**
 * The three in-memory readings, injected so the computation is unit-testable
 * without a fleet, a hub or a socket. Each must be cheap enough to call on every
 * request — see the module header.
 */
export interface BusySources {
  /** Sessions with a running turn: `hub.runningSessions().length`. */
  runningChats: () => number;
  /** Live background tasks, counted only in sessions whose SDK session is live. */
  backgroundTasks: () => number;
  /** Scheduler jobs running right now. */
  runningJobs: () => number;
}

/**
 * Read the three counts and decide busy.
 *
 * `busy` is `counts` having any non-zero member rather than a separately
 * computed predicate, so the sentence the CLI prints can never disagree with the
 * boolean it printed it for. A source that throws counts as zero: a busy check
 * that 500s is worse than one that under-reports, because a 500 is read by
 * `busy-client.ts` as "something answered, but not as Paddock's busy check" —
 * exit 1 — which fails a `service stop` outright instead of letting it proceed.
 */
export function collectBusy(sources: BusySources, version: string): BusyBody {
  const counts: BusyCounts = {
    chat: safeCount(sources.runningChats),
    background: safeCount(sources.backgroundTasks),
    job: safeCount(sources.runningJobs),
  };
  return {
    busy: counts.chat > 0 || counts.background > 0 || counts.job > 0,
    version,
    counts,
  };
}

function safeCount(read: () => number): number {
  try {
    const n = read();
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
