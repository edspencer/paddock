/**
 * #853 — the join that recovers a background shell's COMMAND from the turns the
 * client already has.
 *
 * The bar's own rendering is pinned in `RunningWork.test.tsx`; this tier pins
 * the lookup: what counts as a Bash command, what is deliberately excluded (a
 * Read's `inputSummary` is a file path, not a command), and that the map is
 * stable across re-renders so the bar does not churn.
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShellCommands } from "./useShellCommands";
import type { ToolCall } from "../../lib/ws";

type Turn = { kind: string; tool?: ToolCall };

const toolTurn = (over: Partial<ToolCall>): Turn => ({
  kind: "tool",
  tool: { toolName: "Bash", output: "", isError: false, ...over },
});

describe("useShellCommands", () => {
  it("maps a Bash call's tool id to its command", () => {
    const { result } = renderHook(() =>
      useShellCommands([
        toolTurn({ toolUseId: "toolu_a", inputSummary: "sleep 60 && echo done" }),
      ]),
    );
    expect(result.current.get("toolu_a")).toBe("sleep 60 && echo done");
  });

  it("accepts the lowercase spelling herdctl also summarises", () => {
    const { result } = renderHook(() =>
      useShellCommands([toolTurn({ toolName: "bash", toolUseId: "toolu_a", inputSummary: "ls" })]),
    );
    expect(result.current.get("toolu_a")).toBe("ls");
  });

  it("ignores non-Bash tools, whose inputSummary is NOT a command", () => {
    // A Read summarises to a file path. Showing that as "the command a shell is
    // running" would be a confident lie, which is worse than showing nothing.
    const { result } = renderHook(() =>
      useShellCommands([
        toolTurn({ toolName: "Read", toolUseId: "toolu_r", inputSummary: "/etc/hosts" }),
        toolTurn({ toolName: "Task", toolUseId: "toolu_t", inputSummary: "audit the config" }),
      ]),
    );
    expect(result.current.size).toBe(0);
  });

  it("skips a call with no tool id — there would be nothing to key it on", () => {
    const { result } = renderHook(() => useShellCommands([toolTurn({ inputSummary: "ls" })]));
    expect(result.current.size).toBe(0);
  });

  it("skips an empty or whitespace-only summary rather than mapping a blank", () => {
    const { result } = renderHook(() =>
      useShellCommands([
        toolTurn({ toolUseId: "toolu_a", inputSummary: "" }),
        toolTurn({ toolUseId: "toolu_b", inputSummary: "   " }),
        toolTurn({ toolUseId: "toolu_c" }),
      ]),
    );
    expect(result.current.size).toBe(0);
  });

  it("ignores non-tool turns entirely", () => {
    const { result } = renderHook(() =>
      useShellCommands([
        { kind: "assistant" },
        { kind: "user" },
        toolTurn({ toolUseId: "toolu_a", inputSummary: "make test" }),
      ]),
    );
    expect([...result.current.entries()]).toEqual([["toolu_a", "make test"]]);
  });

  it("covers a PENDING call, which is the live-turn case", () => {
    // A shell launched in the current turn arrives as `chat:tool_start` — a
    // pending row that already carries `toolUseId` and `inputSummary` (#175).
    // If this were excluded, a command would only appear after a reload.
    const { result } = renderHook(() =>
      useShellCommands([
        toolTurn({ toolUseId: "toolu_a", inputSummary: "npm run build", pending: true }),
      ]),
    );
    expect(result.current.get("toolu_a")).toBe("npm run build");
  });

  it("keeps the same map across re-renders with the same turns", () => {
    const turns = [toolTurn({ toolUseId: "toolu_a", inputSummary: "ls" })];
    const { result, rerender } = renderHook(() => useShellCommands(turns));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
