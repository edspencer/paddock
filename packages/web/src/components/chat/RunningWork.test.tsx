import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunningWork } from "./RunningWork";
import { isSubagentRunning } from "./toolFormatting";
import type { RunningSubagent, SubagentActivity } from "./useSubagentActivity";
import type { ToolCall } from "../../lib/ws";
import type { LiveBackgroundTask } from "../../lib/types";

const RUNNING: RunningSubagent[] = [
  { toolUseId: "toolu_a", label: "general-purpose", description: "audit the config" },
];

const activity = (a?: SubagentActivity) =>
  new Map<string, SubagentActivity>(a ? [["toolu_a", a]] : []);

const task = (over: Partial<LiveBackgroundTask> = {}): LiveBackgroundTask => ({
  id: "t1",
  type: "shell",
  description: "",
  startedAt: Date.now() - 65_000,
  ...over,
});

describe("RunningWork bar — sub-agents (behaviour preserved from RunningSubagents)", () => {
  it("renders nothing when nothing is running (an ordinary turn is unchanged)", () => {
    const { container } = render(
      <RunningWork running={[]} activity={activity()} tasks={[]} onReveal={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the sub-agent's LATEST step, which is the whole point of the bar", () => {
    render(
      <RunningWork
        running={RUNNING}
        activity={activity({ latestStep: "Bash wc -l a.txt", stepCount: 4 })}
        tasks={[]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("Bash wc -l a.txt")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.getByText("1 sub-agent running")).toBeInTheDocument();
  });

  it("falls back to 'starting…' before the first poll returns", () => {
    render(
      <RunningWork running={RUNNING} activity={activity()} tasks={[]} onReveal={() => {}} />,
    );
    expect(screen.getByText("starting…")).toBeInTheDocument();
  });

  it("asks to reveal the sub-agent's card when its row is tapped", async () => {
    const onReveal = vi.fn();
    render(
      <RunningWork
        running={RUNNING}
        activity={activity({ latestStep: "Read a.txt", stepCount: 1 })}
        tasks={[]}
        onReveal={onReveal}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /general-purpose/ }));
    expect(onReveal).toHaveBeenCalledWith("toolu_a");
  });
});

describe("RunningWork bar — background tasks (#604)", () => {
  it("shows a background shell, which previously had no liveness at all", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ command: "npm run build", description: "build the app" })]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("npm run build")).toBeInTheDocument();
    expect(screen.getByText("1 thing running")).toBeInTheDocument();
  });

  it("labels a monitor and a workflow by their own identity", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          task({ id: "m", type: "monitor", description: "errors in deploy.log" }),
          task({ id: "w", type: "workflow", workflowName: "spec", description: "phase 2" }),
        ]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("errors in deploy.log")).toBeInTheDocument();
    expect(screen.getByText("spec")).toBeInTheDocument();
    expect(screen.getByText("2 things running")).toBeInTheDocument();
  });

  it("counts sub-agents and background tasks together", () => {
    render(
      <RunningWork
        running={RUNNING}
        activity={activity({ latestStep: "Read a.txt", stepCount: 1 })}
        tasks={[task()]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("2 things running")).toBeInTheDocument();
    expect(screen.getAllByTestId("running-task-row")).toHaveLength(1);
  });

  it("does NOT double-render a sub-agent the transcript path is already showing", () => {
    render(
      <RunningWork
        running={RUNNING}
        activity={activity({ latestStep: "Read a.txt", stepCount: 1 })}
        tasks={[task({ id: "s", type: "subagent", toolUseId: "toolu_a", agentType: "Explore" })]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("1 sub-agent running")).toBeInTheDocument();
    expect(screen.queryByTestId("running-task-row")).not.toBeInTheDocument();
  });

  it("DOES show a sub-agent the transcript path has not found (the reload case)", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ id: "s", type: "subagent", toolUseId: "toolu_z", agentType: "Explore" })]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("Explore")).toBeInTheDocument();
  });

  it("hides ambient work the SDK marks as skip_transcript", () => {
    const { container } = render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ skipTranscript: true })]}
        onReveal={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows elapsed time, so a stuck shell is visibly stuck", () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={[task()]} onReveal={() => {}} />,
    );
    // startedAt is 65s ago.
    expect(screen.getByTestId("running-task-elapsed")).toHaveTextContent("1:05");
  });

  it("reveals a task's card when the row is tapped, and is inert without a tool id", async () => {
    const onReveal = vi.fn();
    const { rerender } = render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ toolUseId: "toolu_b", command: "sleep 60" })]}
        onReveal={onReveal}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /sleep 60/ }));
    expect(onReveal).toHaveBeenCalledWith("toolu_b");

    // A task with no tool_use_id (launched turns ago) renders, but not as a button.
    rerender(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ command: "sleep 60" })]}
        onReveal={onReveal}
      />,
    );
    expect(screen.queryByRole("button", { name: /sleep 60/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("running-task-row")).toBeInTheDocument();
  });

  it("renders an unknown task type rather than dropping it", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ type: "some_future_kind", description: "who knows" })]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("some_future_kind")).toBeInTheDocument();
    expect(screen.getByText("who knows")).toBeInTheDocument();
  });
});

/**
 * The bar and the card must agree on what "running" means — they read the same
 * predicate precisely so a sub-agent can't be listed as running by one and shown
 * as finished by the other.
 */
describe("isSubagentRunning", () => {
  const tool = (over: Partial<ToolCall> = {}): ToolCall =>
    ({ toolName: "Task", output: "", isError: false, ...over }) as ToolCall;

  it("is true for a sub-agent with no final duration while the chat is live", () => {
    expect(isSubagentRunning(tool(), true)).toBe(true);
  });

  it("is false once the final duration lands (the history join completed it)", () => {
    expect(isSubagentRunning(tool({ subagentDurationMs: 31_000 }), true)).toBe(false);
  });

  it("is false when the chat is not live (a reloaded transcript)", () => {
    expect(isSubagentRunning(tool(), false)).toBe(false);
  });

  it("is false for a tool that isn't a sub-agent at all", () => {
    expect(isSubagentRunning(tool({ toolName: "Bash" }), true)).toBe(false);
  });
});
