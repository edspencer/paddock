import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryMessage, LiveBackgroundTask } from "../../lib/types";
import { SUBAGENT_TOOLS } from "./toolFormatting";

/** How often a running sub-agent's growing transcript is re-read. */
export const SUBAGENT_POLL_MS = 2000;

/**
 * Consecutive unchanged polls before a sub-agent counts as finished, once the
 * chat itself is no longer live. 6 ticks ≈ 12s of total silence — comfortably
 * longer than a slow `WebFetch` between steps, so a working sub-agent is not
 * declared done just because one step is taking a while.
 */
const STABLE_TICKS_TO_SETTLE = 6;

/** Shared empty verdict set, so the default argument keeps a stable identity. */
const EMPTY_FINISHED: ReadonlySet<string> = new Set<string>();

/** A sub-agent card that may still be working, as derived from the transcript. */
export interface RunningSubagent {
  toolUseId: string;
  /** The agent type (`general-purpose`, …), falling back to the tool name. */
  label: string;
  /** The `description` the parent gave the Task, if any. */
  description?: string;
}

/** What a sub-agent is doing right now, derived from its own transcript. */
export interface SubagentActivity {
  /** Its latest step, e.g. `Bash wc -l a.txt` — undefined before the first poll. */
  latestStep?: string;
  /** How many steps it has taken so far. */
  stepCount: number;
  /** Its steps, shared with the card so an expanded card needs no second poll. */
  messages?: HistoryMessage[];
  /**
   * First→last timestamp of its transcript: its REAL elapsed time. The launching
   * `Task`/`Agent` tool_call's own `durationMs` is NOT this — for a background
   * sub-agent (the SDK default) that call returns in ~30ms, so the card used to
   * advertise "38ms" for a four-minute run until a reload replaced it.
   */
  elapsedMs?: number;
  /** False once its transcript has stopped growing and the chat is not live. */
  running: boolean;
}

/**
 * One label for a transcript step: the tool it called, plus a short argument.
 * Mirrors what a ToolBlock header shows, compressed to a single line.
 */
function stepLabel(m: HistoryMessage): string | null {
  const tool = m.toolCall;
  if (!tool) return null;
  const name = SUBAGENT_TOOLS.has(tool.toolName) ? `${tool.subagentType ?? tool.toolName} ▸` : tool.toolName;
  const arg = (tool.description ?? tool.inputSummary ?? "").trim();
  if (!arg) return name;
  // Deliberately NOT truncated here: the row truncates with CSS, which keeps the
  // HEAD of the string. That is the informative end for a shell command
  // (`sleep 4; wc -l …`) — slicing the tail instead showed the middle of a long
  // absolute path and hid the command itself.
  return `${name} ${arg}`;
}

/** First→last timestamp span of a transcript, in ms. */
function elapsedOf(messages: HistoryMessage[]): number | undefined {
  if (messages.length === 0) return undefined;
  const first = Date.parse(messages[0]?.timestamp ?? "");
  const last = Date.parse(messages[messages.length - 1]?.timestamp ?? "");
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return undefined;
  return last - first;
}

/** Cheap "has this transcript changed?" fingerprint. */
function signatureOf(messages: HistoryMessage[]): string {
  return `${messages.length}:${messages[messages.length - 1]?.timestamp ?? ""}`;
}

/**
 * Polls each sub-agent's transcript so the UI can show what it is doing WITHOUT
 * the user expanding its card, and — critically — so a sub-agent's liveness is
 * judged by ITS OWN transcript rather than by whether the PARENT's turn happens
 * to be streaming.
 *
 * That distinction is the whole point. A sub-agent runs in the background by SDK
 * default, so the parent routinely finishes its reply (and the server emits
 * `chat:complete` + `chat:active{running:false}`) while sub-agents keep working —
 * measured at 12s of "idle-looking" chat in one capture, during which the bar
 * vanished and every card fell back to its ~30ms launch-ack. Liveness therefore
 * has to be sticky across the parent's completion: a sub-agent stays "running"
 * while its transcript keeps growing, and only settles after
 * {@link STABLE_TICKS_TO_SETTLE} silent polls once the chat is no longer live.
 *
 * ## Why every candidate is polled, with no liveness gate of our own (#725)
 *
 * This used to arm a candidate only while `chatLive` was true, and poll only
 * armed ones. That gate was a proxy for "this sub-agent might still be working",
 * and it lived in a `useRef` — so it held only for as long as the component
 * stayed mounted. `ChatPane` is genuinely remounted on navigation (it is keyed,
 * and a tab switch unmounts it outright), and a background sub-agent routinely
 * outlives its parent's turn. So the exact case this hook exists to serve — a
 * sub-agent still working after the parent replied — remounted into a state
 * where nothing was armed, the loop early-returned, no poll ever ran, and every
 * card fell back to "finished" for the rest of the run. A reload did not recover
 * it, because a reload is just another mount. That was #725 cause B.
 *
 * The gate is gone rather than re-derived on mount, because there is now a
 * better one a layer up. {@link useRunningSubagents} already drops any card
 * carrying a `subagentDurationMs`, and since #725 cause A the server publishes
 * that field ONLY for a sub-agent whose own transcript has settled (terminal
 * `end_turn`, or ten minutes of silence). The candidate list is therefore
 * already "the sub-agents the server does not consider finished" — an actual
 * liveness verdict, derived from disk, that survives a remount by construction.
 * Re-checking it here against the parent's streaming state could only subtract
 * true positives.
 *
 * The lazy-"not until you expand it" contract that the arming gate was
 * protecting is upheld by that same filter: opening an old chat yields no
 * candidates at all, so nothing is fetched. The residue is bounded — a
 * candidate we cannot settle (unreadable sidecar, a transcript with too few
 * timestamps for the server to ever measure) costs at most
 * {@link STABLE_TICKS_TO_SETTLE} + 1 polls per mount, then the loop stops.
 *
 * Polling stops entirely once every candidate has settled, so a finished chat
 * costs nothing.
 *
 * ## The registry's verdict, for a sub-agent that finishes MID-TURN (#911)
 *
 * The settle rule above has a hole, and it is the common case for an agent that
 * fans out more than once: silence is the only finished-signal this hook has,
 * and `!liveRef.current` disables it for as long as the PARENT is streaming. A
 * sub-agent that returned forty seconds ago therefore stays "running" until the
 * whole turn ends — the bar accumulates finished rows beside live ones and
 * miscounts them all in its header, and every stale card keeps claiming RUNNING.
 * The other exit is no help: `subagentDurationMs` is only ever published on the
 * `/messages` history join, so mid-turn it cannot arrive.
 *
 * `finished` closes that hole with a POSITIVE signal instead of a silence one —
 * the server's live background-task registry, which evicts a task on the SDK's
 * terminal `task_notification` and broadcasts the remainder. See
 * {@link useRegistryFinishedSubagents} for how "seen and then dropped" is
 * derived, and why mere absence is not enough. A verdict in that set is applied
 * immediately, wins over an in-flight poll, and stops the polling.
 *
 * Deliberately NOT a replacement for the silence rule: a registry that never saw
 * a sub-agent yields no verdict about it, so everything above still carries the
 * cases this cannot reach.
 *
 * Known limitation: if a sub-agent goes totally silent for >12s while the parent
 * is idle, it settles early and drops out of the bar (its card still shows the
 * elapsed time it had reached). A reload re-derives the truth. The robust fix is
 * server-side — `chat:active` should not report `running:false` while background
 * sub-agents are still in flight.
 *
 * Also still open (#911 fix b): a sub-agent whose transcript ends without a
 * terminal `end_turn` AND whose registry row we never saw has no prompt verdict
 * from either path, and waits out the server's ten-minute staleness window on
 * the next history join. Publishing the server's own transcript verdict on the
 * poll endpoint is what would close it.
 */
export function useSubagentActivity(
  candidates: RunningSubagent[],
  fetchSubagent: ((toolUseId: string) => Promise<HistoryMessage[]>) | null,
  chatLive: boolean,
  /**
   * `toolUseId`s the server's live registry has declared finished (#911). Its
   * verdict is terminal and beats every other signal here. Defaults to empty, so
   * a caller with no registry to consult behaves exactly as before.
   */
  finished: ReadonlySet<string> = EMPTY_FINISHED,
): Map<string, SubagentActivity> {
  const [activity, setActivity] = useState<Map<string, SubagentActivity>>(new Map());
  // Per-sub-agent settle bookkeeping. Refs, not state: mutating these must never
  // re-render, and the poll loop reads them at tick time.
  const settledRef = useRef<Set<string>>(new Set());
  const stableRef = useRef<Map<string, { sig: string; ticks: number }>>(new Map());
  // Read inside the loop without making them effect dependencies — `chatLive`
  // flipping must NOT restart the poll loop, only change how it settles.
  const fetchRef = useRef(fetchSubagent);
  fetchRef.current = fetchSubagent;
  const liveRef = useRef(chatLive);
  liveRef.current = chatLive;

  // The candidate ids as a stable primitive, so the effect re-runs when the SET
  // changes rather than on every re-render (the array identity churns constantly).
  const key = candidates
    .map((c) => c.toolUseId)
    .sort()
    .join(",");

  /*
   * Apply the registry's verdicts (#911).
   *
   * Runs as an effect keyed on a stable primitive rather than during render, but
   * it does NOT wait for the next poll tick: the frame that drops the task is
   * what settles the sub-agent, so the row leaves the bar and the card stops
   * saying RUNNING at the moment the server says so — not up to two seconds
   * later, and not when the parent's turn eventually ends.
   *
   * `settledRef` is written here as well as in the loop, which is what makes the
   * verdict stick: the loop's `todo` filter then skips the id forever, so a
   * settled sub-agent costs no further requests for the rest of the session.
   */
  const finishedKey = [...finished].sort().join(",");
  useEffect(() => {
    const ids = finishedKey ? finishedKey.split(",") : [];
    if (ids.length === 0) return;
    for (const id of ids) settledRef.current.add(id);
    setActivity((prev) => {
      let next: Map<string, SubagentActivity> | null = null;
      for (const id of ids) {
        const cur = prev.get(id);
        if (cur && !cur.running) continue;
        next ??= new Map(prev);
        // Keep whatever detail the polls already gathered — the card should
        // still show the steps and elapsed time it got to, just not "running".
        next.set(id, { ...cur, stepCount: cur?.stepCount ?? 0, running: false });
      }
      return next ?? prev;
    });
  }, [finishedKey]);

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0 || !fetchRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const fetcher = fetchRef.current;
      if (!fetcher) return;
      const todo = ids.filter((id) => !settledRef.current.has(id));
      // Everything has settled — stop the loop rather than idle-polling forever.
      if (todo.length === 0) return;
      const results = await Promise.all(
        todo.map((id) =>
          fetcher(id)
            .then((messages) => ({ id, messages }))
            // A sub-agent whose sidecar hasn't appeared yet (or a transient read
            // error) simply has no update this tick — never tear the bar down.
            .catch(() => null),
        ),
      );
      if (cancelled) return;
      setActivity((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (!r) continue;
          // A verdict that landed WHILE this poll was in flight wins (#911).
          // Without this the stale response would write `running: !settled`
          // computed from the pre-verdict world and resurrect the row for one
          // tick — visible as a finished sub-agent flickering back into the bar.
          if (settledRef.current.has(r.id)) continue;
          const sig = signatureOf(r.messages);
          const seen = stableRef.current.get(r.id);
          const ticks = seen && seen.sig === sig ? seen.ticks + 1 : 0;
          stableRef.current.set(r.id, { sig, ticks });
          // Only settle when the PARENT is idle too: while the chat is live the
          // sub-agent is definitionally still in flight, however quiet it is.
          const settled = !liveRef.current && ticks >= STABLE_TICKS_TO_SETTLE;
          if (settled) settledRef.current.add(r.id);
          const steps = r.messages.map(stepLabel).filter((s): s is string => Boolean(s));
          next.set(r.id, {
            latestStep: steps[steps.length - 1],
            stepCount: steps.length,
            messages: r.messages,
            elapsedMs: elapsedOf(r.messages),
            running: !settled,
          });
        }
        return next;
      });
      if (!cancelled) timer = setTimeout(tick, SUBAGENT_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `chatLive` is deliberately NOT a dependency: it must not restart the loop,
    // and it no longer decides what gets polled (see the arming note above). It
    // reaches the loop through `liveRef`, which only changes how a quiet
    // sub-agent settles.
  }, [key]);

  return activity;
}

/**
 * Sub-agents the server's live background-task registry has SHOWN US and then
 * DROPPED — which is that registry saying they are finished (#911).
 *
 * The registry (#604) is fed by the SDK's own task lifecycle and evicts a task
 * on its terminal `task_notification`, ahead of the level signal that confirms
 * it. The client already receives the resulting `chat:background` frames for the
 * registry's own rows; this turns them into a verdict the transcript-derived
 * path can use too. It is the only prompt finished-signal available while the
 * parent's turn is still streaming — see {@link useSubagentActivity}.
 *
 * ## Why SEEN-then-gone, and not simply absent
 *
 * Absence is not evidence. The transcript path routinely carries sub-agents the
 * registry has no row for: the set is per-process and emits nothing at startup,
 * so every sub-agent in a chat reopened after a server restart is absent; so is
 * one whose `task_started` edge never carried a `tool_use_id` (the level signal
 * alone does not have one). Treating those as finished would evict live work
 * from the bar — the #725 regression, reintroduced from the other side. So a
 * verdict requires having watched the row exist first.
 *
 * ## Why the verdict is sticky
 *
 * Once reached it is never revisited. The frames are a REPLACE-semantics level
 * set, so an unrelated later frame naturally omits the finished task, and
 * re-deriving per frame would work — but a task legitimately re-entering the set
 * must not un-finish a sub-agent the user has already watched leave the bar. The
 * one case that would resurrect a row is the server's own membership authority
 * putting it back, and by then its transcript has moved on anyway.
 *
 * A cleared registry (`background.clear`, on the session's stream ending) is
 * therefore read as "everything it was showing is finished". That is correct
 * rather than incidental: Paddock stops the fleet with `waitForJobs: false`, so
 * the process is gone and anything it still listed is genuinely dead.
 *
 * Returns a stable identity while the verdict set is unchanged, so the memo
 * downstream does not churn on every frame.
 */
export function useRegistryFinishedSubagents(
  tasks: LiveBackgroundTask[],
): ReadonlySet<string> {
  const [verdicts, setVerdicts] = useState<ReadonlySet<string>>(EMPTY_FINISHED);
  // Every tool_use_id the registry has ever shown us. A ref, not state: it is
  // bookkeeping for the comparison below and must never itself re-render.
  const seen = useRef<Set<string>>(new Set());
  // The live ids as a stable primitive, so the effect runs on a real membership
  // change rather than on every frame (the task array identity churns per frame,
  // and `task_progress` enrichment alone re-broadcasts several times a second).
  const liveKey = tasks
    .map((t) => t.toolUseId)
    .filter((id): id is string => Boolean(id))
    .sort()
    .join(",");

  useEffect(() => {
    const live = new Set(liveKey ? liveKey.split(",") : []);
    for (const id of live) seen.current.add(id);
    setVerdicts((prev) => {
      let next: Set<string> | null = null;
      for (const id of seen.current) {
        if (live.has(id) || prev.has(id)) continue;
        next ??= new Set(prev);
        next.add(id);
      }
      return next ?? prev;
    });
  }, [liveKey]);

  return verdicts;
}

/**
 * Sub-agents in this chat that might still be working, in transcript order,
 * derived from the same turn list the transcript renders (so the bar cannot
 * disagree with the cards about what exists).
 *
 * Deliberately NOT gated on `chatLive`: a sub-agent outlives its parent's turn
 * (see {@link useSubagentActivity}), so gating here would drop it from the bar
 * the instant the parent replied. A card that already carries a final
 * `subagentDurationMs` (filled by the history join on reload) is finished and
 * excluded, which is what keeps a reloaded chat from polling anything.
 *
 * Since #725 that exclusion is the ONLY liveness gate: {@link useSubagentActivity}
 * polls whatever comes out of here. It can carry that on its own because the
 * server withholds `subagentDurationMs` from a sub-agent whose transcript is
 * still growing — so "no duration" means "not finished as far as disk knows",
 * not merely "we have not looked yet".
 */
export function useRunningSubagents(
  turns: Array<{ kind: string; tool?: import("../../lib/ws").ToolCall }>,
): RunningSubagent[] {
  return useMemo(() => {
    const out: RunningSubagent[] = [];
    for (const t of turns) {
      const tool = t.kind === "tool" ? t.tool : undefined;
      if (!tool?.toolUseId) continue;
      if (!SUBAGENT_TOOLS.has(tool.toolName)) continue;
      // No sub-agent transcript ⇒ nothing to poll and nothing to report. Skips an
      // orphaned/pending `Task` row whose launch was never recognised as a
      // sub-agent, which would otherwise sit in the bar forever.
      if (!tool.hasSubagent) continue;
      if (tool.subagentDurationMs != null) continue;
      out.push({
        toolUseId: tool.toolUseId,
        label: tool.subagentType ?? tool.toolName,
        description: tool.description,
      });
    }
    return out;
  }, [turns]);
}
