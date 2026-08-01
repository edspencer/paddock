import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryMessage } from "../../lib/types";
import { SUBAGENT_TOOLS } from "./toolFormatting";

/** How often a running sub-agent's growing transcript is re-read. */
export const SUBAGENT_POLL_MS = 2000;

/** A sub-agent currently working, as surfaced in the running-sub-agents bar. */
export interface RunningSubagent {
  toolUseId: string;
  /** The agent type (`general-purpose`, …), falling back to the tool name. */
  label: string;
  /** The `description` the parent gave the Task, if any. */
  description?: string;
}

/** What a running sub-agent is doing right now, derived from its transcript. */
export interface SubagentActivity {
  /** Its latest step, e.g. `Bash wc -l a.txt` — undefined before the first poll. */
  latestStep?: string;
  /** How many steps it has taken so far. */
  stepCount: number;
  /** Its steps, shared with the card so an expanded card needs no second poll. */
  messages?: HistoryMessage[];
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

/**
 * Polls every RUNNING sub-agent's transcript so the UI can show what each one is
 * doing WITHOUT the user having to expand its card first (the gap this closes: a
 * sub-agent could work for minutes behind a collapsed card showing only a cost).
 *
 * Polling lives here — hoisted out of the card — for two reasons:
 *  - the bar must show live activity for a COLLAPSED card, which by definition
 *    isn't mounted-and-polling; and
 *  - hoisting keeps it to ONE request per sub-agent per tick. The card reads the
 *    same result through context, so expanding a card adds no extra fetching.
 *
 * A sub-agent drops out of `running` the moment its final duration lands; its last
 * fetched steps are KEPT (not cleared), so an expanded card doesn't flash back to a
 * spinner as the turn settles. A transient read error just retries on the next tick.
 */
export function useSubagentActivity(
  running: RunningSubagent[],
  fetchSubagent: ((toolUseId: string) => Promise<HistoryMessage[]>) | null,
): Map<string, SubagentActivity> {
  const [activity, setActivity] = useState<Map<string, SubagentActivity>>(new Map());
  // The running ids as a stable primitive, so the effect re-runs when the SET
  // changes rather than on every re-render (the array identity changes constantly).
  const key = running
    .map((r) => r.toolUseId)
    .sort()
    .join(",");
  // Read inside the interval without making it an effect dependency.
  const fetchRef = useRef(fetchSubagent);
  fetchRef.current = fetchSubagent;

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0 || !fetchRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const fetcher = fetchRef.current;
      if (!fetcher) return;
      const results = await Promise.all(
        ids.map((id) =>
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
          const steps = r.messages.map(stepLabel).filter((s): s is string => Boolean(s));
          next.set(r.id, {
            latestStep: steps[steps.length - 1],
            stepCount: steps.length,
            messages: r.messages,
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
  }, [key]);

  return activity;
}

/**
 * The sub-agents currently working in this chat, in transcript order, derived from
 * the same turn list the transcript renders (so the bar cannot disagree with the
 * cards about what exists).
 */
export function useRunningSubagents(
  turns: Array<{ kind: string; tool?: import("../../lib/ws").ToolCall }>,
  chatLive: boolean,
): RunningSubagent[] {
  return useMemo(() => {
    if (!chatLive) return [];
    const out: RunningSubagent[] = [];
    for (const t of turns) {
      const tool = t.kind === "tool" ? t.tool : undefined;
      if (!tool?.toolUseId) continue;
      if (!SUBAGENT_TOOLS.has(tool.toolName)) continue;
      if (tool.subagentDurationMs != null) continue;
      out.push({
        toolUseId: tool.toolUseId,
        label: tool.subagentType ?? tool.toolName,
        description: tool.description,
      });
    }
    return out;
  }, [turns, chatLive]);
}
