import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
 * A shell's COMMAND, joined from the transcript (#853).
 *
 * The registry's wire has only the description — the agent's intent — and the
 * motivating failure was fifteen shells whose intents all read plausibly while
 * every one of them polled a path that did not exist. These pin both halves:
 * that the command displaces the description in the wide column when the join
 * lands, and that EVERY way the join can fail leaves the row exactly as it was.
 */
describe("RunningWork bar — a shell's command (#853)", () => {
  const CMD = 'until grep -q SCANDONE /tmp/scan.log 2>/dev/null; do sleep 60; done';
  const shell = (over: Partial<LiveBackgroundTask> = {}) =>
    task({ type: "local_bash", description: "wait for scan completion", ...over });

  it("shows the COMMAND for a shell whose launching Bash call is in the transcript", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell({ toolUseId: "toolu_sh" })]}
        commands={new Map([["toolu_sh", CMD]])}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-task-detail")).toHaveTextContent(CMD);
    // The intent is kept beside it, not replaced by it: the DISCREPANCY between
    // "wait for scan completion" and what is actually running is the diagnostic.
    expect(screen.getByTestId("running-task-intent")).toHaveTextContent("wait for scan completion");
  });

  it("degrades to the description when the task carries no tool id", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell()]}
        commands={new Map([["toolu_sh", CMD]])}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-task-detail")).toHaveTextContent("wait for scan completion");
    expect(screen.queryByTestId("running-task-intent")).not.toBeInTheDocument();
  });

  it("degrades to the description when the id matches nothing (launch scrolled out of history)", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell({ toolUseId: "toolu_gone" })]}
        commands={new Map([["toolu_other", CMD]])}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-task-detail")).toHaveTextContent("wait for scan completion");
    expect(screen.queryByTestId("running-task-intent")).not.toBeInTheDocument();
  });

  it("degrades when no join map is passed at all (a caller with no turns)", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell({ toolUseId: "toolu_sh" })]}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-task-detail")).toHaveTextContent("wait for scan completion");
  });

  it("prefers a command the task carries itself over anything we reconstruct", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell({ toolUseId: "toolu_sh", command: "npm run build" })]}
        commands={new Map([["toolu_sh", CMD]])}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-task-detail")).toHaveTextContent("npm run build");
  });

  it("rides an over-long command on ONE truncating row rather than wrapping the bar", () => {
    // 200 chars is herdctl's own cap on a Bash inputSummary, so this is the
    // longest string that can actually arrive.
    const long = `${"a".repeat(197)}...`;
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell({ toolUseId: "toolu_sh" })]}
        commands={new Map([["toolu_sh", long]])}
        onReveal={() => {}}
      />,
    );
    const detail = screen.getByTestId("running-task-detail");
    // Whole command present (never a partial one), on a single truncating line
    // that also carries it as a tooltip.
    expect(detail).toHaveTextContent(long);
    expect(detail.className).toContain("truncate");
    expect(detail.className).toContain("min-w-0");
    expect(detail).toHaveAttribute("title", long);
    // …and the intent chip beside it is bounded too, so a long description can't
    // squeeze the command out.
    expect(screen.getByTestId("running-task-intent").className).toContain("truncate");
  });

  it("leaves NON-shell roles untouched even when their id is in the map", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          task({
            id: "mon",
            type: "monitor_mcp",
            description: "errors in deploy.log",
            toolUseId: "toolu_sh",
          }),
        ]}
        commands={new Map([["toolu_sh", CMD]])}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-task-detail")).toHaveTextContent("errors in deploy.log");
    expect(screen.queryByText(CMD)).not.toBeInTheDocument();
  });

  it("shows the command in the COLLAPSED summary too, where one line is all there is", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[
          ...shells(4),
          shell({ id: "newest", toolUseId: "toolu_sh", startedAt: Date.now() }),
        ]}
        commands={new Map([["toolu_sh", CMD]])}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByTestId("running-work-summary")).toHaveTextContent(CMD);
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

/**
 * Stopping one piece of background work (#848).
 *
 * The load-bearing claim, and the reason most of these exist: THE CLICK IS NOT
 * WHAT REMOVES A ROW. The runtime emits its own terminal notification and the
 * registry evicts on it, which arrives here as a new `tasks` prop. So the bar
 * only ever HOLDS a row — and because a stop can genuinely be refused, a hold
 * that could never be released would be a bug, not a cosmetic one.
 *
 * Fixtures use the REAL discriminants for the same reason the rest of this file
 * does: `monitor_mcp` and `monitor_ws` share the `monitor` role and only one is
 * killable, so a test written against a friendly `"monitor"` would assert
 * against a payload production cannot send — and would miss the whole point of
 * carrying `stoppable` on the wire.
 */
describe("RunningWork bar — stopping background work (#848)", () => {
  const stopButtons = () => screen.queryAllByTestId("running-task-cancel");
  const confirmButton = () => screen.queryByTestId("running-work-confirm-stop");
  /** A stoppable background shell — the no-confirmation case. */
  const shell = (over: Partial<LiveBackgroundTask> = {}) =>
    task({ id: "t1", command: "npm test", ...over });
  /** A sub-agent as the REGISTRY sends it: `local_agent`, role `subagent`. */
  const subagentTask = (over: Partial<LiveBackgroundTask> = {}) =>
    task({ id: "task_sub", type: "local_agent", toolUseId: "toolu_a", ...over });

  it("offers no stop affordance at all when the caller passes no handler", () => {
    // The session cannot take a kill — better nothing than a button that no-ops.
    render(
      <RunningWork running={RUNNING} activity={activity()} tasks={[shell()]} onReveal={() => {}} />,
    );
    expect(stopButtons()).toHaveLength(0);
    expect(screen.queryByTestId("running-work-stop-all")).not.toBeInTheDocument();
  });

  it("stops a SHELL on one click, with no confirmation", () => {
    // Ed's policy: a shell is cheap to relaunch, so a confirmation here is
    // friction with nothing behind it.
    const onCancel = vi.fn();
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell({ id: "task_42" })]}
        onReveal={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("running-task-cancel"));
    expect(onCancel).toHaveBeenCalledWith("task_42");
    expect(confirmButton()).not.toBeInTheDocument();
  });

  it("holds the row at 'stopping…' and does NOT remove it", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell()]}
        onReveal={() => {}}
        onCancel={() => {}}
        stopping={new Set(["t1"])}
      />,
    );
    expect(screen.getByTestId("running-task-row")).toBeInTheDocument();
    expect(screen.getByText("stopping…")).toBeInTheDocument();
    expect(screen.queryByText("npm test")).not.toBeInTheDocument();
  });

  it("cannot be double-clicked into sending two stops", () => {
    const onCancel = vi.fn();
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell()]}
        onReveal={() => {}}
        onCancel={onCancel}
        stopping={new Set(["t1"])}
      />,
    );
    fireEvent.click(screen.getByTestId("running-task-cancel"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("says 'can't stop' when the stop was REFUSED, rather than hanging at stopping…", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell()]}
        onReveal={() => {}}
        onCancel={() => {}}
        stopFailed={new Map([["t1", "unsupported_type"]])}
      />,
    );
    expect(screen.getByText("can't stop")).toBeInTheDocument();
    expect(screen.queryByText("stopping…")).not.toBeInTheDocument();
  });

  it("leaves a refused row clickable, because retrying is all that is left", () => {
    const onCancel = vi.fn();
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell()]}
        onReveal={() => {}}
        onCancel={onCancel}
        stopFailed={new Map([["t1", "unsupported_type"]])}
      />,
    );
    const btn = screen.getByTestId("running-task-cancel");
    expect(btn).toHaveAttribute("data-stop-state", "failed");
    expect(btn).toHaveAttribute("title", expect.stringContaining("unsupported_type"));
    fireEvent.click(btn);
    expect(onCancel).toHaveBeenCalledWith("t1");
  });

  it("withholds the button on a monitor_mcp row, which the CLI cannot kill", () => {
    // The role is `monitor` for BOTH monitor flavours, so only `stoppable` can
    // distinguish them — this is the test that would fail if the flag were
    // re-derived client-side from the label.
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ id: "t1", type: "monitor_mcp", stoppable: false })]}
        onReveal={() => {}}
        onCancel={() => {}}
      />,
    );
    const row = screen.getByTestId("running-task-row");
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute("data-task-type", "monitor_mcp");
    expect(stopButtons()).toHaveLength(0);
  });

  it("DOES offer a stop on monitor_ws, which shares the same role", () => {
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ id: "t1", type: "monitor_ws", stoppable: true })]}
        onReveal={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(stopButtons()).toHaveLength(1);
  });

  it("still offers a stop when the server sends no `stoppable` field at all", () => {
    // A server older than the field. Absent reads as stoppable; if the runtime
    // then refuses, the reject path above covers it.
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell({ stoppable: undefined })]}
        onReveal={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(stopButtons()).toHaveLength(1);
  });

  it("copes when the task completes on its own between render and click", () => {
    // The idempotent-success race: the row is GONE from the next `tasks` prop
    // while its id is still held in `stopping`. Must not throw.
    const { rerender } = render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[shell(), task({ id: "t2" })]}
        onReveal={() => {}}
        onCancel={() => {}}
        stopping={new Set(["t1"])}
      />,
    );
    expect(() =>
      rerender(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={[task({ id: "t2" })]}
          onReveal={() => {}}
          onCancel={() => {}}
          stopping={new Set(["t1"])}
        />,
      ),
    ).not.toThrow();
    expect(screen.queryAllByTestId("running-task-row")).toHaveLength(1);
    expect(screen.queryByText("stopping…")).not.toBeInTheDocument();
  });

  describe("transcript-derived sub-agent rows", () => {
    it("stops one via the registry twin we dedupe away on toolUseId", () => {
      // Without the twin lookup the richest rows in the bar would be the only
      // ones you could not stop.
      const onCancel = vi.fn();
      render(
        <RunningWork
          running={RUNNING}
          activity={activity({ latestStep: "Read a.txt", stepCount: 1 })}
          tasks={[subagentTask()]}
          onReveal={() => {}}
          onCancel={onCancel}
        />,
      );
      // Deduped: the registry row is not rendered separately.
      expect(screen.queryAllByTestId("running-task-row")).toHaveLength(0);
      fireEvent.click(screen.getByTestId("running-task-cancel"));
      // A sub-agent CONFIRMS, so nothing is sent until the dialog is accepted.
      expect(onCancel).not.toHaveBeenCalled();
      fireEvent.click(confirmButton()!);
      expect(onCancel).toHaveBeenCalledWith("task_sub");
    });

    it("offers no stop when the twin is absent, so there is no id to send", () => {
      render(
        <RunningWork
          running={RUNNING}
          activity={activity()}
          tasks={[]}
          onReveal={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(screen.getByTestId("running-subagent-row")).toBeInTheDocument();
      expect(stopButtons()).toHaveLength(0);
    });

    it("holds a sub-agent row at 'stopping…' via its twin's id", () => {
      render(
        <RunningWork
          running={RUNNING}
          activity={activity({ latestStep: "Read a.txt", stepCount: 1 })}
          tasks={[subagentTask()]}
          onReveal={() => {}}
          onCancel={() => {}}
          stopping={new Set(["task_sub"])}
        />,
      );
      expect(screen.getByText("stopping…")).toBeInTheDocument();
      expect(screen.queryByText("Read a.txt")).not.toBeInTheDocument();
    });
  });
});

/**
 * The confirmation policy (#848), as Ed set it:
 *
 *  - **shells** stop on one click — cheap to relaunch, so a prompt is friction;
 *  - **sub-agents** confirm, because the row understates the damage: the kill
 *    cascades to everything the sub-agent started, and it may be forty steps in;
 *  - **Stop all** always confirms, whatever is in the bar, because it is the one
 *    action here that is both destructive and un-aimed.
 *
 * The case worth guarding hardest is CANCELLING. A declined confirmation must
 * leave nothing behind — no request, and no `stopping…` hold — or the user is
 * left with a greyed row for work they explicitly chose to keep running.
 */
describe("RunningWork bar — confirming a stop (#848)", () => {
  const confirmButton = () => screen.queryByTestId("running-work-confirm-stop");
  const dialog = () => screen.queryByRole("alertdialog");

  const withSubagent = (onCancel: (id: string) => void) =>
    render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ id: "task_sub", type: "local_agent", description: "audit the config" })]}
        onReveal={() => {}}
        onCancel={onCancel}
      />,
    );

  it("asks before stopping a sub-agent, and says the children die too", () => {
    const onCancel = vi.fn();
    withSubagent(onCancel);
    fireEvent.click(screen.getByTestId("running-task-cancel"));

    expect(dialog()).toBeInTheDocument();
    // The specific thing the ✕ cannot convey on its own.
    expect(screen.getByText(/everything it started/i)).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("sends the stop once the confirmation is accepted", () => {
    const onCancel = vi.fn();
    withSubagent(onCancel);
    fireEvent.click(screen.getByTestId("running-task-cancel"));
    fireEvent.click(confirmButton()!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("task_sub");
    expect(dialog()).not.toBeInTheDocument();
  });

  it("CANCELLING sends nothing and leaves no stopping… hold behind", () => {
    const onCancel = vi.fn();
    withSubagent(onCancel);
    fireEvent.click(screen.getByTestId("running-task-cancel"));
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));

    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog()).not.toBeInTheDocument();
    // The row is untouched: still live, still showing its own detail.
    expect(screen.queryByText("stopping…")).not.toBeInTheDocument();
    expect(screen.getByText("audit the config")).toBeInTheDocument();
    expect(screen.getByTestId("running-task-cancel")).toHaveAttribute("data-stop-state", "idle");
  });

  it("drops a pending confirmation when the bar empties, so it cannot come back stale", () => {
    // Rendering nothing is not unmounting — the parent keeps this component
    // mounted — so an open dialog's state would otherwise outlive the work it
    // was about and reopen over the NEXT burst of background work.
    const onCancel = vi.fn();
    const { rerender } = render(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ id: "task_sub", type: "local_agent" })]}
        onReveal={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("running-task-cancel"));
    expect(screen.queryByRole("alertdialog")).toBeInTheDocument();

    // All the work finishes while the dialog is open.
    rerender(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[]}
        onReveal={() => {}}
        onCancel={onCancel}
      />,
    );
    // ...and later, unrelated work starts.
    rerender(
      <RunningWork
        running={[]}
        activity={activity()}
        tasks={[task({ id: "later", command: "something else" })]}
        onReveal={() => {}}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape cancels too, and is equally inert", () => {
    const onCancel = vi.fn();
    withSubagent(onCancel);
    fireEvent.click(screen.getByTestId("running-task-cancel"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog()).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByText("stopping…")).not.toBeInTheDocument();
  });

  describe("Stop all", () => {
    const three = [
      task({ id: "t1", command: "one" }),
      task({ id: "t2", command: "two" }),
      task({ id: "t3", command: "three" }),
    ];
    const stopAll = () => screen.getByTestId("running-work-stop-all");

    it("appears only once more than one thing is running", () => {
      const { rerender } = render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={[task({ id: "t1" })]}
          onReveal={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(screen.queryByTestId("running-work-stop-all")).not.toBeInTheDocument();
      rerender(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={three}
          onReveal={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(stopAll()).toBeInTheDocument();
    });

    it("ALWAYS confirms — even for shells, which stop on one click individually", () => {
      const onCancel = vi.fn();
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={three}
          onReveal={() => {}}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(stopAll());
      expect(dialog()).toBeInTheDocument();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("fires ONE independent stop per task once confirmed, so partial failure reads right", () => {
      const onCancel = vi.fn();
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={three}
          onReveal={() => {}}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(stopAll());
      fireEvent.click(confirmButton()!);
      expect(onCancel.mock.calls.map(([id]) => id)).toEqual(["t1", "t2", "t3"]);
    });

    it("cancelling Stop all stops nothing at all", () => {
      const onCancel = vi.fn();
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={three}
          onReveal={() => {}}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(stopAll());
      fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
      expect(onCancel).not.toHaveBeenCalled();
      expect(screen.queryByText("stopping…")).not.toBeInTheDocument();
    });

    it("counts the sub-agents it is about to cascade through", () => {
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={[
            task({ id: "t1", command: "one" }),
            task({ id: "t2", type: "local_agent" }),
            task({ id: "t3", type: "remote_agent" }),
          ]}
          onReveal={() => {}}
          onCancel={() => {}}
        />,
      );
      fireEvent.click(stopAll());
      expect(screen.getByText(/2 sub-agents and everything they started/i)).toBeInTheDocument();
    });

    it("skips tasks that cannot be stopped and ones already stopping", () => {
      const onCancel = vi.fn();
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={[
            task({ id: "t1" }),
            task({ id: "t2", type: "monitor_mcp", stoppable: false }),
            task({ id: "t3" }),
          ]}
          onReveal={() => {}}
          onCancel={onCancel}
          stopping={new Set(["t3"])}
        />,
      );
      fireEvent.click(stopAll());
      fireEvent.click(confirmButton()!);
      expect(onCancel.mock.calls.map(([id]) => id)).toEqual(["t1"]);
    });

    it("still works while the bar is COLLAPSED, where it is the only way to stop", () => {
      // The #847 × #848 interaction: above the threshold the bar starts
      // collapsed, so no per-row ✕ is rendered at all. Stop all lives in the
      // header, which stays visible — without that, a fifteen-shell fan-out
      // (exactly the case that auto-collapses) would offer nothing to click.
      const onCancel = vi.fn();
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={shells(6)}
          onReveal={() => {}}
          onCancel={onCancel}
        />,
      );
      expect(screen.getByTestId("running-work-summary")).toBeInTheDocument();
      expect(screen.queryAllByTestId("running-task-cancel")).toHaveLength(0);

      fireEvent.click(screen.getByTestId("running-work-stop-all"));
      fireEvent.click(confirmButton()!);
      expect(onCancel).toHaveBeenCalledTimes(6);
    });

    it("hides itself when nothing left in the bar can be stopped", () => {
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={[
            task({ id: "t1", type: "monitor_mcp", stoppable: false }),
            task({ id: "t2", type: "monitor_mcp", stoppable: false }),
          ]}
          onReveal={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(screen.queryByTestId("running-work-stop-all")).not.toBeInTheDocument();
    });

    it("shows a partial failure as one refused row beside the rest still stopping", () => {
      render(
        <RunningWork
          running={[]}
          activity={activity()}
          tasks={three}
          onReveal={() => {}}
          onCancel={() => {}}
          stopping={new Set(["t1", "t3"])}
          stopFailed={new Map([["t2", "unsupported_type"]])}
        />,
      );
      expect(screen.getAllByText("stopping…")).toHaveLength(2);
      expect(screen.getByText("can't stop")).toBeInTheDocument();
    });
  });
});
