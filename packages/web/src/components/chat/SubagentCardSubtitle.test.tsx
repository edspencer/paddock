import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TurnView } from "./Transcript";
import { SubagentActivityContext, SubagentLiveContext } from "./chatContexts";
import type { SubagentActivity } from "./useSubagentActivity";
import type { Turn } from "./turnModel";

const TOOL_USE_ID = "toolu_sub1";
const DESCRIPTION = "Audit the config files";
const LATEST_STEP = "Bash sleep 5; wc -l sandbox/a.txt";

/** A sub-agent's own transcript is the authority on whether it is still working. */
const RUNNING: SubagentActivity = { latestStep: LATEST_STEP, stepCount: 3, running: true };
const FINISHED: SubagentActivity = {
  latestStep: LATEST_STEP,
  stepCount: 8,
  running: false,
  elapsedMs: 252_000,
};

function renderSubagentCard({
  live,
  durationMs,
  subagentDurationMs,
  activity,
}: {
  live: boolean;
  /** The LAUNCHING tool_call's own duration — ~30ms for a background sub-agent. */
  durationMs?: number;
  subagentDurationMs?: number;
  activity?: SubagentActivity;
}) {
  const turn: Turn = {
    kind: "tool",
    id: "t1",
    tool: {
      toolName: "Task",
      output: "",
      isError: false,
      toolUseId: TOOL_USE_ID,
      subagentType: "general-purpose",
      description: DESCRIPTION,
      hasSubagent: true,
      ...(durationMs != null ? { durationMs } : {}),
      ...(subagentDurationMs != null ? { subagentDurationMs } : {}),
    },
  };
  const map = new Map<string, SubagentActivity>(activity ? [[TOOL_USE_ID, activity]] : []);
  return render(
    <MemoryRouter>
      <SubagentLiveContext.Provider value={live}>
        <SubagentActivityContext.Provider value={map}>
          <TurnView turn={turn} />
        </SubagentActivityContext.Provider>
      </SubagentLiveContext.Provider>
    </MemoryRouter>,
  );
}

describe("sub-agent card subtitle", () => {
  it("shows the LATEST STEP instead of the description while running", () => {
    renderSubagentCard({ live: true, activity: RUNNING });
    expect(screen.getByText(LATEST_STEP)).toBeInTheDocument();
    expect(screen.queryByText(DESCRIPTION)).not.toBeInTheDocument();
  });

  it("keeps the description reachable on hover while a step has its place", () => {
    renderSubagentCard({ live: true, activity: RUNNING });
    expect(screen.getByText(LATEST_STEP)).toHaveAttribute("title", DESCRIPTION);
  });

  it("reverts to the description once the sub-agent FINISHES", () => {
    renderSubagentCard({ live: true, activity: FINISHED });
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(LATEST_STEP)).not.toBeInTheDocument();
  });

  it("falls back to the description before the first poll returns a step", () => {
    renderSubagentCard({ live: true });
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
  });
});

/**
 * A sub-agent outlives its parent's turn — the SDK backgrounds sub-agents by
 * default, so the parent finishes its reply (and the chat stops streaming) while
 * they keep working. Judging liveness by the chat's streaming state alone snapped
 * every card to "finished" the moment the parent replied; measured as a 12s window
 * in a live capture. The sub-agent's own transcript wins.
 */
describe("sub-agent liveness survives the parent's turn ending", () => {
  it("still reads as RUNNING after the chat stops streaming", () => {
    renderSubagentCard({ live: false, activity: RUNNING });
    expect(screen.getByTitle("Sub-agent is running")).toBeInTheDocument();
    // …and the header keeps reporting what it is doing.
    expect(screen.getByText(LATEST_STEP)).toBeInTheDocument();
  });

  it("reads as finished once its transcript settles, even while the chat is live", () => {
    renderSubagentCard({ live: true, activity: FINISHED });
    expect(screen.queryByTitle("Sub-agent is running")).not.toBeInTheDocument();
  });
});

/**
 * The launching `Task`/`Agent` tool_call returns as soon as a background sub-agent
 * is SPAWNED (~30ms), so its `durationMs` is a different quantity from the run's
 * length. A four-minute research sub-agent advertised itself as "38ms".
 */
describe("sub-agent duration never shows the launch-ack", () => {
  it("does NOT render the launching call's ~30ms duration", () => {
    renderSubagentCard({ live: false, durationMs: 38, activity: FINISHED });
    expect(screen.queryByText("38ms")).not.toBeInTheDocument();
  });

  it("uses the transcript's elapsed span when the server figure is absent", () => {
    renderSubagentCard({ live: false, durationMs: 38, activity: FINISHED });
    expect(screen.getByText("4m 12s")).toBeInTheDocument();
  });

  it("prefers the server's final figure over the polled estimate", () => {
    renderSubagentCard({
      live: false,
      durationMs: 38,
      subagentDurationMs: 300_000,
      activity: FINISHED,
    });
    expect(screen.getByText("5m")).toBeInTheDocument();
    expect(screen.queryByText("4m 12s")).not.toBeInTheDocument();
  });

  it("shows NO duration rather than a wrong one when neither is known", () => {
    renderSubagentCard({ live: false, durationMs: 38 });
    expect(screen.queryByText("38ms")).not.toBeInTheDocument();
  });
});
