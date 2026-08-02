import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunningSubagents } from "./RunningSubagents";
import { isSubagentRunning } from "./toolFormatting";
import type { RunningSubagent, SubagentActivity } from "./useSubagentActivity";
import type { ToolCall } from "../../lib/ws";

const RUNNING: RunningSubagent[] = [
  { toolUseId: "toolu_a", label: "general-purpose", description: "audit the config" },
];

const activity = (a?: SubagentActivity) =>
  new Map<string, SubagentActivity>(a ? [["toolu_a", a]] : []);

describe("RunningSubagents bar", () => {
  it("renders nothing when no sub-agent is running (an ordinary turn is unchanged)", () => {
    const { container } = render(
      <RunningSubagents running={[]} activity={activity()} onReveal={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the sub-agent's LATEST step, which is the whole point of the bar", () => {
    render(
      <RunningSubagents
        running={RUNNING}
        activity={activity({ latestStep: "Bash wc -l a.txt", stepCount: 4 })}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("Bash wc -l a.txt")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.getByText("1 sub-agent running")).toBeInTheDocument();
  });

  it("falls back to 'starting…' before the first poll returns", () => {
    render(<RunningSubagents running={RUNNING} activity={activity()} onReveal={() => {}} />);
    expect(screen.getByText("starting…")).toBeInTheDocument();
  });

  it("asks to reveal the sub-agent's card when its row is tapped", async () => {
    const onReveal = vi.fn();
    render(
      <RunningSubagents
        running={RUNNING}
        activity={activity({ latestStep: "Read a.txt", stepCount: 1 })}
        onReveal={onReveal}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /general-purpose/ }));
    expect(onReveal).toHaveBeenCalledWith("toolu_a");
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
