import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { HistoryPane } from "./HistoryPane";
import type { Chat, ProjectRuns, RunSummary } from "../lib/types";
import type { ProjectRunsState } from "../lib/useProjectRuns";

/**
 * The "while you were away" run-history pane (#268 / E3): unattended (scheduled +
 * spawned) runs surface by default with provenance labels + status; the
 * since-last-visit banner counts what ran while away; opening the pane clears the
 * watermark; a row links into its chat. Human runs are behind the "All" filter.
 */

function run(over: Partial<RunSummary>): RunSummary {
  return {
    jobId: "job-x",
    sessionId: "s-x",
    origin: "human",
    depth: 0,
    triggerType: "manual",
    schedule: null,
    forkedFrom: null,
    status: "completed",
    exitReason: "success",
    startedAt: "2026-07-18T10:00:00.000Z",
    finishedAt: "2026-07-18T10:01:00.000Z",
    durationSeconds: 60,
    prompt: null,
    summary: null,
    isNew: false,
    cost: null,
    ...over,
  };
}

function makeState(runs: RunSummary[], over: Partial<ProjectRuns> = {}): {
  state: ProjectRunsState;
  markSeen: ReturnType<typeof vi.fn>;
} {
  const markSeen = vi.fn().mockResolvedValue(undefined);
  const data: ProjectRuns = {
    runs,
    lastSeen: 0,
    newUnattended: runs.filter((r) => r.isNew && r.origin !== "human").length,
    ...over,
  };
  return {
    markSeen,
    state: {
      data,
      loading: false,
      error: null,
      newUnattended: data.newUnattended,
      refresh: vi.fn(),
      markSeen,
    },
  };
}

const chats: Chat[] = [
  { sessionId: "s-sched", name: "Nightly triage", workingDirectory: "/p", updatedAt: 0, resumable: true } as Chat,
];

describe("HistoryPane (#268)", () => {
  it("defaults to unattended: shows scheduled + spawned, hides human", () => {
    const { state } = makeState([
      run({ jobId: "j-sched", sessionId: "s-sched", origin: "scheduled", schedule: "nightly" }),
      run({ jobId: "j-spawn", sessionId: "s-spawn", origin: "spawned", depth: 1 }),
      run({ jobId: "j-human", sessionId: "s-human", origin: "human", prompt: "my own turn" }),
    ]);
    render(<HistoryPane slug="p" state={state} chats={chats} onOpenChat={vi.fn()} />);

    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("Spawned")).toBeInTheDocument();
    // Human run hidden under the default "Unattended" filter.
    expect(screen.queryByText("my own turn")).not.toBeInTheDocument();
  });

  it("the All filter reveals human runs", () => {
    const { state } = makeState([
      run({ jobId: "j-human", sessionId: "s-human", origin: "human", prompt: "my own turn" }),
    ]);
    render(<HistoryPane slug="p" state={state} chats={chats} onOpenChat={vi.fn()} />);
    // Nothing unattended → empty state initially.
    expect(screen.getByText(/No unattended runs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^All$/ }));
    expect(screen.getByText("my own turn")).toBeInTheDocument();
  });

  it("shows the since-last-visit banner for new unattended runs and marks seen on open", () => {
    const { state, markSeen } = makeState([
      run({ jobId: "j-sched", sessionId: "s-sched", origin: "scheduled", isNew: true }),
      run({ jobId: "j-spawn", sessionId: "s-spawn", origin: "spawned", isNew: true }),
    ]);
    render(<HistoryPane slug="p" state={state} chats={chats} onOpenChat={vi.fn()} />);

    const banner = screen.getByText(/ran while you were away/i);
    expect(within(banner).getByText(/2 new runs/i)).toBeInTheDocument();
    // Opening the tab advances the watermark exactly once.
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it("no banner when nothing is new", () => {
    const { state } = makeState([
      run({ jobId: "j-sched", sessionId: "s-sched", origin: "scheduled", isNew: false }),
    ]);
    render(<HistoryPane slug="p" state={state} chats={chats} onOpenChat={vi.fn()} />);
    expect(screen.queryByText(/ran while you were away/i)).not.toBeInTheDocument();
  });

  it("clicking a run opens its chat", () => {
    const onOpenChat = vi.fn();
    const { state } = makeState([
      run({ jobId: "j-sched", sessionId: "s-sched", origin: "scheduled", schedule: "nightly" }),
    ]);
    render(<HistoryPane slug="p" state={state} chats={chats} onOpenChat={onOpenChat} />);
    fireEvent.click(screen.getByText("Nightly triage"));
    expect(onOpenChat).toHaveBeenCalledWith("s-sched");
  });

  it("renders the scheduled trigger note with the schedule name", () => {
    const { state } = makeState([
      run({ jobId: "j-sched", sessionId: "s-sched", origin: "scheduled", schedule: "nightly-triage" }),
    ]);
    render(<HistoryPane slug="p" state={state} chats={chats} onOpenChat={vi.fn()} />);
    expect(screen.getByText(/schedule · nightly-triage/)).toBeInTheDocument();
  });
});
