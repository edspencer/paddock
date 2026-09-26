/**
 * #911 — a sub-agent that FINISHES while the parent turn is still streaming must
 * leave the running-work bar (and stop its card claiming RUNNING) promptly.
 *
 * The bug: both of the client's exits from "running" are unreachable mid-turn.
 * `subagentDurationMs` — the finished-signal {@link useRunningSubagents} drops a
 * card on — is only ever published on the `/messages` history join, never live;
 * and the silence-settle in {@link useSubagentActivity} is gated on
 * `!liveRef.current`, which is the PARENT's streaming state. So while the parent
 * works on, a sub-agent that returned forty seconds ago is still advertised as
 * running, and the bar accumulates: five finished deep-reads beside three live
 * edits, under a header reading "8 sub-agents running".
 *
 * The signal being adopted here is the server's own: `BackgroundRegistry` evicts
 * a task on the SDK's terminal `task_notification` and broadcasts the new set,
 * which the client already receives for the #604 registry rows. It just never
 * consulted it for the transcript-derived ones. The tell in the original report
 * was that the five stale rows had no ✕ button while the three live ones did — a
 * stop button needs a registry twin, so the server had already dropped them.
 *
 * Every test here runs with `chatLive: true` from first render, which is the
 * state the old code could never settle out of.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import {
  useSubagentActivity,
  useRegistryFinishedSubagents,
  SUBAGENT_POLL_MS,
  type RunningSubagent,
} from "./useSubagentActivity";
import type { HistoryMessage, LiveBackgroundTask } from "../../lib/types";

const CANDIDATES: RunningSubagent[] = [
  { toolUseId: "toolu_done", label: "general-purpose", description: "Deep-read 2020 return" },
];

/** `n` sub-agent steps, each a distinct tool call so the signature changes. */
function steps(n: number): HistoryMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: "tool" as const,
    content: `step ${i + 1}`,
    timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(),
    toolCall: { toolName: "Read", inputSummary: `STEP_${i + 1}`, output: "", isError: false },
  }));
}

/** One registry row, shaped as the #604 `chat:background` frame delivers it. */
function task(id: string, toolUseId: string): LiveBackgroundTask {
  return {
    id,
    type: "local_agent",
    role: "subagent",
    description: "Deep-read 2020 return",
    startedAt: 1_800_000_000_000,
    toolUseId,
    agentType: "general-purpose",
    stoppable: true,
  };
}

const EMPTY: ReadonlySet<string> = new Set();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useRegistryFinishedSubagents — seen-then-vanished is terminal (#911)", () => {
  it("reports nothing for a task that is still live", () => {
    const { result } = renderHook(() => useRegistryFinishedSubagents([task("t1", "toolu_done")]));
    expect([...result.current]).toEqual([]);
  });

  it("reports a sub-agent the registry showed us and then dropped", () => {
    const { result, rerender } = renderHook(
      ({ tasks }: { tasks: LiveBackgroundTask[] }) => useRegistryFinishedSubagents(tasks),
      { initialProps: { tasks: [task("t1", "toolu_done")] } },
    );
    expect([...result.current]).toEqual([]);

    // The SDK's terminal notification evicts it; the server broadcasts the rest.
    rerender({ tasks: [] });
    expect([...result.current]).toEqual(["toolu_done"]);
  });

  it("does NOT report a sub-agent it has never seen", () => {
    // Absence alone is not proof: the transcript path routinely finds sub-agents
    // the registry never knew about (a reload after a server restart, a launch
    // whose `task_started` edge never carried a tool_use_id). Those must keep
    // today's behaviour rather than being declared finished on no evidence.
    const { result } = renderHook(() => useRegistryFinishedSubagents([]));
    expect([...result.current]).toEqual([]);
  });

  it("keeps a verdict once reached, even if the frame set churns", () => {
    const { result, rerender } = renderHook(
      ({ tasks }: { tasks: LiveBackgroundTask[] }) => useRegistryFinishedSubagents(tasks),
      { initialProps: { tasks: [task("t1", "toolu_done")] } },
    );
    rerender({ tasks: [] });
    const first = result.current;
    // A later frame carrying unrelated work must not resurrect the finished one.
    rerender({ tasks: [task("t2", "toolu_other")] });
    expect([...result.current]).toContain("toolu_done");
    // Identity is stable while the verdict set is unchanged, so the memo
    // downstream of this does not churn on every frame.
    expect(result.current).toBe(first);
  });
});

describe("useSubagentActivity — the registry's verdict settles a live chat (#911)", () => {
  it("BUG: without the registry, a finished sub-agent runs forever mid-turn", async () => {
    // The control. This is the state the user reported, and it is unchanged by
    // this fix: with no registry verdict there is still nothing that can settle a
    // silent sub-agent while the parent streams. Fix (b) on #911 — publishing the
    // server's own transcript verdict on the poll endpoint — is what closes this.
    const fetchSubagent = vi.fn().mockResolvedValue(steps(3));
    const { result } = renderHook(() =>
      useSubagentActivity(CANDIDATES, fetchSubagent, /* chatLive */ true, EMPTY),
    );
    await waitFor(() => expect(result.current.get("toolu_done")?.stepCount).toBe(3));

    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS);
      });
    }
    expect(result.current.get("toolu_done")?.running).toBe(true);
  });

  it("marks a sub-agent finished the moment the registry drops it", async () => {
    const fetchSubagent = vi.fn().mockResolvedValue(steps(3));
    const { result, rerender } = renderHook(
      ({ finished }: { finished: ReadonlySet<string> }) =>
        useSubagentActivity(CANDIDATES, fetchSubagent, /* chatLive */ true, finished),
      { initialProps: { finished: EMPTY } },
    );
    await waitFor(() => expect(result.current.get("toolu_done")?.running).toBe(true));

    // No timer advance: the verdict must apply on the frame, not on the next tick.
    rerender({ finished: new Set(["toolu_done"]) });
    expect(result.current.get("toolu_done")?.running).toBe(false);
    // Its last-known detail survives — the card still shows what it got to.
    expect(result.current.get("toolu_done")?.stepCount).toBe(3);
    expect(result.current.get("toolu_done")?.latestStep).toContain("STEP_3");
  });

  it("stops polling a sub-agent the registry has settled", async () => {
    const fetchSubagent = vi.fn().mockResolvedValue(steps(3));
    const { rerender } = renderHook(
      ({ finished }: { finished: ReadonlySet<string> }) =>
        useSubagentActivity(CANDIDATES, fetchSubagent, /* chatLive */ true, finished),
      { initialProps: { finished: EMPTY } },
    );
    await waitFor(() => expect(fetchSubagent).toHaveBeenCalled());

    rerender({ finished: new Set(["toolu_done"]) });
    const callsAtVerdict = fetchSubagent.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS);
      });
    }
    // 2s polls against a chat that may run for an hour: a settled sub-agent must
    // cost nothing, not merely render correctly.
    expect(fetchSubagent.mock.calls.length).toBe(callsAtVerdict);
  });

  it("a poll in flight when the verdict lands cannot resurrect it", async () => {
    // The race the `settledRef` re-check exists for: a fetch issued before the
    // registry frame arrives resolves after it, carrying `running: !settled`
    // computed from the stale verdict.
    let release!: (m: HistoryMessage[]) => void;
    const fetchSubagent = vi
      .fn()
      .mockResolvedValueOnce(steps(3))
      .mockImplementationOnce(() => new Promise<HistoryMessage[]>((r) => (release = r)));

    const { result, rerender } = renderHook(
      ({ finished }: { finished: ReadonlySet<string> }) =>
        useSubagentActivity(CANDIDATES, fetchSubagent, /* chatLive */ true, finished),
      { initialProps: { finished: EMPTY } },
    );
    await waitFor(() => expect(result.current.get("toolu_done")?.running).toBe(true));
    // Second poll goes out and hangs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS);
    });
    await waitFor(() => expect(release).toBeDefined());

    rerender({ finished: new Set(["toolu_done"]) });
    expect(result.current.get("toolu_done")?.running).toBe(false);

    // The stale poll lands afterwards.
    await act(async () => {
      release(steps(4));
      await Promise.resolve();
    });
    expect(result.current.get("toolu_done")?.running).toBe(false);
  });

  it("leaves a sub-agent the registry has NOT dropped alone", async () => {
    const fetchSubagent = vi.fn().mockResolvedValue(steps(3));
    const { result, rerender } = renderHook(
      ({ finished }: { finished: ReadonlySet<string> }) =>
        useSubagentActivity(CANDIDATES, fetchSubagent, /* chatLive */ true, finished),
      { initialProps: { finished: EMPTY } },
    );
    await waitFor(() => expect(result.current.get("toolu_done")?.running).toBe(true));
    // A verdict about a DIFFERENT sub-agent must not touch this one.
    rerender({ finished: new Set(["toolu_someone_else"]) });
    expect(result.current.get("toolu_done")?.running).toBe(true);
  });
});
