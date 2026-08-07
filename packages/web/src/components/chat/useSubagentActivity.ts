import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryMessage } from "../../lib/types";
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
 * Known limitation: if a sub-agent goes totally silent for >12s while the parent
 * is idle, it settles early and drops out of the bar (its card still shows the
 * elapsed time it had reached). A reload re-derives the truth. The robust fix is
 * server-side — `chat:active` should not report `running:false` while background
 * sub-agents are still in flight.
 */
export function useSubagentActivity(
  candidates: RunningSubagent[],
  fetchSubagent: ((toolUseId: string) => Promise<HistoryMessage[]>) | null,
  chatLive: boolean,
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
