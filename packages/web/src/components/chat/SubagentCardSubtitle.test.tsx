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

/**
 * A sub-agent card's subtitle while it works.
 *
 * A collapsed card is the common case, so the header is where progress is
 * actually wanted: WHILE the sub-agent runs it reports its latest step, and it
 * reverts to the description it was launched with once finished. The two states
 * are distinguished only by `subagentDurationMs` (filled by the history join).
 */
function renderSubagentCard({
  live,
  durationMs,
  activity,
}: {
  live: boolean;
  durationMs?: number;
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
      ...(durationMs != null ? { subagentDurationMs: durationMs } : {}),
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
    renderSubagentCard({
      live: true,
      activity: { latestStep: LATEST_STEP, stepCount: 3 },
    });
    expect(screen.getByText(LATEST_STEP)).toBeInTheDocument();
    expect(screen.queryByText(DESCRIPTION)).not.toBeInTheDocument();
  });

  it("keeps the description reachable on hover while a step has its place", () => {
    renderSubagentCard({
      live: true,
      activity: { latestStep: LATEST_STEP, stepCount: 3 },
    });
    expect(screen.getByText(LATEST_STEP)).toHaveAttribute("title", DESCRIPTION);
  });

  it("reverts to the description once the sub-agent FINISHES", () => {
    // A final duration is exactly what marks it finished, even mid-turn.
    renderSubagentCard({
      live: true,
      durationMs: 31_000,
      activity: { latestStep: LATEST_STEP, stepCount: 8 },
    });
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(LATEST_STEP)).not.toBeInTheDocument();
  });

  it("shows the description on a reloaded transcript (chat not live)", () => {
    renderSubagentCard({
      live: false,
      activity: { latestStep: LATEST_STEP, stepCount: 8 },
    });
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(LATEST_STEP)).not.toBeInTheDocument();
  });

  it("falls back to the description before the first poll returns a step", () => {
    renderSubagentCard({ live: true });
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
  });
});
