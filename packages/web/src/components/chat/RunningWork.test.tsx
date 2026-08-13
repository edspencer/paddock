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

/**
 * The server's SDK-type → role map (#846), mirrored here so fixtures carry the
 * SAME shape the wire does.
 *
 * This file used to invent friendly names (`type: "shell"`, `"subagent"`) that
 * the CLI never sends — which is exactly why #846 stayed green: every assertion
 * was made against a payload production cannot produce. Fixtures now use the
 * REAL discriminants and let `role` be derived, so "15 local_bashs running"
 * would fail here rather than only in front of a user.
 */
const ROLE_OF_TYPE: Record<string, string> = {
  local_bash: "shell",
  local_agent: "subagent",
  remote_agent: "subagent",
  in_process_teammate: "subagent",
  local_workflow: "workflow",
  monitor_mcp: "monitor",
  monitor_ws: "monitor",
  mcp_task: "task",
};

const task = (over: Partial<LiveBackgroundTask> = {}): LiveBackgroundTask => {
  const type = over.type ?? "local_bash";
  return {
    id: "t1",
    type,
    role: ROLE_OF_TYPE[type] ?? type,
    description: "",
    startedAt: Date.now() - 65_000,
    ...over,
  };
};

/** `n` background shells, oldest first, as a real fan-out puts on the wire. */
const shells = (n: number): LiveBackgroundTask[] =>
  Array.from({ length: n }, (_, i) =>
    task({
      id: `sh${i}`,
      type: "local_bash",
      description: `wait for scan ${i}`,
      startedAt: Date.now() - (n - i) * 60_000,
    }),
  );

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
    // Named by its role, not the raw `local_bash` the wire carries (#846).
    expect(screen.getByText("1 shell running")).toBeInTheDocument();
  });

  it("labels a monitor and a workflow by their own identity", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          task({ id: "m", type: "monitor_mcp", description: "errors in deploy.log" }),
          task({ id: "w", type: "local_workflow", workflowName: "spec", description: "phase 2" }),
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
        tasks={[task({ id: "s", type: "local_agent", toolUseId: "toolu_a", agentType: "Explore" })]}
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
        tasks={[task({ id: "s", type: "local_agent", toolUseId: "toolu_z", agentType: "Explore" })]}
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
 * Collapse/expand (#847).
 *
 * The bar docks above the composer, so its height comes straight out of the
 * conversation. A fifteen-row fan-out is a wall; these cover the rule that keeps
 * it from eating the viewport, and — the part that is easy to get wrong — the
 * rule that it must NOT move under a click once it is on screen.
 */
describe("RunningWork bar — collapse/expand (#847)", () => {
  const rows = () => screen.queryAllByTestId("running-task-row");
  const toggle = () => screen.getByTestId("running-work-toggle");

  it("stays expanded AT the threshold (4 rows is about the composer's height)", () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(4)} onReveal={() => {}} />,
    );
    expect(rows()).toHaveLength(4);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByTestId("running-work-summary")).not.toBeInTheDocument();
  });

  it("starts collapsed ONE over the threshold, showing a summary instead of rows", () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(5)} onReveal={() => {}} />,
    );
    expect(rows()).toHaveLength(0);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("running-work-summary")).toBeInTheDocument();
  });

  it("names the kind when the bar is homogeneous, against REAL wire values (#846)", () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(15)} onReveal={() => {}} />,
    );
    // The whole acceptance bar for this feature: the noun comes from the mapped
    // role, so a bar of `local_bash` reads as shells and never as "15 local_bashs".
    expect(screen.getByText("15 shells running")).toBeInTheDocument();
    expect(screen.queryByText(/local_bash/)).not.toBeInTheDocument();
  });

  it("falls back to the generic noun for a genuinely mixed bar", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          ...shells(6),
          task({ id: "m", type: "monitor_mcp", description: "watch deploy.log" }),
        ]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("7 things running")).toBeInTheDocument();
  });

  it("falls back to the generic noun for a kind it has no noun for", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={Array.from({ length: 5 }, (_, i) =>
          task({ id: `f${i}`, type: "some_future_kind", description: "?" }),
        )}
        onReveal={() => {}}
      />,
    );
    // Better a vague "5 things" than a confidently wrong invented plural.
    expect(screen.getByText("5 things running")).toBeInTheDocument();
  });

  it("collapsed, a MIXED bar shows the mix rather than restating the header", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          ...shells(6),
          task({ id: "m", type: "monitor_mcp", description: "watch deploy.log" }),
        ]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-work-summary")).toHaveTextContent("6 shells · 1 monitor");
  });

  it("collapsed, a HOMOGENEOUS bar shows what the NEWEST one is doing", () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(15)} onReveal={() => {}} />,
    );
    // The header already said "15 shells"; the line below it should earn its row.
    const summary = screen.getByTestId("running-work-summary");
    expect(summary).toHaveTextContent("wait for scan 14");
    expect(summary).not.toHaveTextContent("15 shells");
  });

  it("collapsed, shows how long the OLDEST has been going — the wedged signal", () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(15)} onReveal={() => {}} />,
    );
    // shells(15) starts the oldest 15 minutes ago.
    expect(screen.getByTestId("running-work-summary")).toHaveTextContent("oldest 15:00");
  });

  it("toggles on click, flipping aria-expanded and swapping rows for the summary", async () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(5)} onReveal={() => {}} />,
    );
    expect(rows()).toHaveLength(0);

    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(rows()).toHaveLength(5);
    expect(screen.queryByTestId("running-work-summary")).not.toBeInTheDocument();

    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(rows()).toHaveLength(0);
  });

  it("is operable by keyboard alone, with Enter and Space", async () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(5)} onReveal={() => {}} />,
    );
    await userEvent.tab();
    expect(toggle()).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard(" ");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("points aria-controls at the region it actually shows and hides", async () => {
    render(
      <RunningWork running={[]} activity={activity()} tasks={shells(5)} onReveal={() => {}} />,
    );
    const controls = toggle().getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(screen.getByTestId("running-work-summary")).toHaveAttribute("id", controls!);

    await userEvent.click(toggle());
    expect(document.querySelector(`ul[id="${controls}"]`)).toBeInTheDocument();
  });

  it("does NOT re-collapse when the count crosses the threshold after first render", () => {
    const { rerender } = render(
      <RunningWork running={[]} activity={activity()} tasks={shells(2)} onReveal={() => {}} />,
    );
    expect(rows()).toHaveLength(2);

    // Thirteen more land. The bar must not fold itself up under the pointer.
    rerender(
      <RunningWork running={[]} activity={activity()} tasks={shells(15)} onReveal={() => {}} />,
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(rows()).toHaveLength(15);
  });

  it("keeps an explicit expand even as work arrives and disappears around it", async () => {
    const { rerender } = render(
      <RunningWork running={[]} activity={activity()} tasks={shells(6)} onReveal={() => {}} />,
    );
    await userEvent.click(toggle()); // the user asked to see them
    expect(rows()).toHaveLength(6);

    rerender(
      <RunningWork running={[]} activity={activity()} tasks={shells(9)} onReveal={() => {}} />,
    );
    expect(rows()).toHaveLength(9);

    rerender(
      <RunningWork running={[]} activity={activity()} tasks={shells(5)} onReveal={() => {}} />,
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(rows()).toHaveLength(5);
  });

  it("keeps an explicit COLLAPSE as work arrives below the threshold", async () => {
    const { rerender } = render(
      <RunningWork running={[]} activity={activity()} tasks={shells(2)} onReveal={() => {}} />,
    );
    await userEvent.click(toggle()); // collapsed by hand, though only 2 rows
    expect(rows()).toHaveLength(0);

    rerender(
      <RunningWork running={[]} activity={activity()} tasks={shells(3)} onReveal={() => {}} />,
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("re-decides for a NEW burst of work once the bar has emptied", () => {
    const { rerender } = render(
      <RunningWork running={[]} activity={activity()} tasks={shells(2)} onReveal={() => {}} />,
    );
    expect(rows()).toHaveLength(2);

    // All the work finishes — the bar leaves the screen entirely...
    rerender(<RunningWork running={[]} activity={activity()} tasks={[]} onReveal={() => {}} />);
    expect(screen.queryByTestId("running-work")).not.toBeInTheDocument();

    // ...so a later fan-out is a fresh appearance and gets the auto rule again.
    // Without this, the first two-sub-agent turn of a chat would decide that a
    // fifteen-shell fan-out an hour later renders fully expanded.
    rerender(
      <RunningWork running={[]} activity={activity()} tasks={shells(15)} onReveal={() => {}} />,
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(rows()).toHaveLength(0);
  });

  it("survives a task with no description at all", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ description: "" })]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("starting…")).toBeInTheDocument();
    expect(screen.getByText("1 shell running")).toBeInTheDocument();
  });

  it("collapses a long single-line description to one truncated row", () => {
    const long = `until grep -qE "SCANDONE" ${"/a/very/long/path".repeat(20)}; do sleep 60; done`;
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          ...shells(4),
          task({ id: "long", type: "local_bash", description: long, startedAt: Date.now() }),
        ]}
        onReveal={() => {}}
      />,
    );
    // Collapsed (5 > 4) and the newest is the long one: it must ride on a single
    // truncating row, not wrap the bar to three lines.
    const line = screen.getByTestId("running-work-summary").querySelector("span");
    expect(line).toHaveTextContent(long);
    expect(line?.className).toContain("truncate");
  });

  it("counts only VISIBLE rows, so skipped chores cannot force a collapse", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          ...shells(2),
          ...Array.from({ length: 10 }, (_, i) =>
            task({ id: `skip${i}`, type: "local_bash", skipTranscript: true }),
          ),
        ]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("2 shells running")).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
  });

  it("renders nothing at all when every row is filtered out (no empty box)", () => {
    const { container } = render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={Array.from({ length: 8 }, (_, i) =>
          task({ id: `skip${i}`, type: "local_bash", skipTranscript: true }),
        )}
        onReveal={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("collapsed, a homogeneous SUB-AGENT bar shows the newest one's latest step", () => {
    const many: RunningSubagent[] = Array.from({ length: 5 }, (_, i) => ({
      toolUseId: `toolu_${i}`,
      label: "general-purpose",
      description: `shard ${i}`,
    }));
    render(
      <RunningWork
        running={many}
        activity={new Map([["toolu_4", { latestStep: "Grep TODO", stepCount: 3 }]])}
        tasks={[]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText("5 sub-agents running")).toBeInTheDocument();
    expect(screen.getByTestId("running-work-summary")).toHaveTextContent("Grep TODO");
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
