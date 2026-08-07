/**
 * #725 cause B — a still-running sub-agent must survive a REMOUNT.
 *
 * The bug: this hook armed a candidate for polling only while the parent chat
 * was live, and kept that arming in a `useRef`. A background sub-agent routinely
 * outlives its parent's turn, and `ChatPane` is genuinely remounted on
 * navigation (it is keyed, and a tab switch unmounts it) — so navigating back to
 * a chat whose turn had already finished remounted into a state where nothing
 * was armed, the poll loop early-returned, and every sub-agent card reported
 * "finished" for the rest of the run. A reload did not recover it, because a
 * reload is just another mount.
 *
 * These tests are written to be UNSATISFIABLE by the old gate: every one of them
 * runs with `chatLive: false` from the very first render, which is exactly the
 * state a remount lands in. The browser-tier proof (the parent turn genuinely
 * ending first, with a real sub-agent still writing to disk) is
 * `test/e2e/journey-subagents.spec.ts`; this tier pins the hook's own contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSubagentActivity, SUBAGENT_POLL_MS, type RunningSubagent } from "./useSubagentActivity";
import type { HistoryMessage } from "../../lib/types";

const CANDIDATES: RunningSubagent[] = [
  { toolUseId: "toolu_a", label: "general-purpose", description: "background research" },
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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useSubagentActivity — polling is not gated on the parent turn (#725)", () => {
  it("polls a candidate on mount even though the chat is NOT live", async () => {
    const fetchSubagent = vi.fn().mockResolvedValue(steps(3));

    const { result } = renderHook(() =>
      useSubagentActivity(CANDIDATES, fetchSubagent, /* chatLive */ false),
    );

    await waitFor(() => expect(fetchSubagent).toHaveBeenCalledWith("toolu_a"));
    await waitFor(() => expect(result.current.get("toolu_a")?.running).toBe(true));
    expect(result.current.get("toolu_a")?.stepCount).toBe(3);
    expect(result.current.get("toolu_a")?.latestStep).toContain("STEP_3");
  });

  it("keeps reporting a growing sub-agent as running across a REMOUNT of a finished chat", async () => {
    let count = 2;
    const fetchSubagent = vi.fn().mockImplementation(() => Promise.resolve(steps(count)));

    // First mount, while the parent turn is still live.
    const first = renderHook(
      ({ live }: { live: boolean }) => useSubagentActivity(CANDIDATES, fetchSubagent, live),
      { initialProps: { live: true } },
    );
    await waitFor(() => expect(first.result.current.get("toolu_a")?.running).toBe(true));

    // The parent turn ends — but the sub-agent keeps working.
    first.rerender({ live: false });
    count = 5;

    // Navigate away: the pane unmounts, taking every ref with it.
    first.unmount();
    fetchSubagent.mockClear();

    // Navigate back. THIS is the failing state: a fresh mount, nothing armed, a
    // chat that is not live, and a sub-agent still going.
    const second = renderHook(() => useSubagentActivity(CANDIDATES, fetchSubagent, false));

    await waitFor(() => expect(fetchSubagent).toHaveBeenCalledWith("toolu_a"));
    await waitFor(() => expect(second.result.current.get("toolu_a")?.running).toBe(true));
    expect(second.result.current.get("toolu_a")?.stepCount).toBe(5);

    // ...and it keeps updating: the remounted poll is a LOOP, not one shot. That
    // second half matters on its own — an expanded card's step list froze even
    // in the cases where the bar happened to repopulate.
    count = 9;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS + 50);
    });
    await waitFor(() => expect(second.result.current.get("toolu_a")?.stepCount).toBe(9));
  });

  it("still settles a quiet sub-agent once the chat is idle, so polling ends", async () => {
    const fetchSubagent = vi.fn().mockResolvedValue(steps(2));

    const { result } = renderHook(() => useSubagentActivity(CANDIDATES, fetchSubagent, false));
    await waitFor(() => expect(result.current.get("toolu_a")?.running).toBe(true));

    // Six consecutive unchanged polls (STABLE_TICKS_TO_SETTLE) settle it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS * 8);
    });
    await waitFor(() => expect(result.current.get("toolu_a")?.running).toBe(false));

    // And the loop stops rather than idle-polling a settled sub-agent forever —
    // this is what bounds the cost of arming every candidate unconditionally.
    const calls = fetchSubagent.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS * 5);
    });
    expect(fetchSubagent.mock.calls.length).toBe(calls);
  });

  it("polls nothing when there are no candidates (a finished chat costs nothing)", async () => {
    const fetchSubagent = vi.fn().mockResolvedValue([]);
    renderHook(() => useSubagentActivity([], fetchSubagent, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS * 3);
    });
    expect(fetchSubagent).not.toHaveBeenCalled();
  });
});
