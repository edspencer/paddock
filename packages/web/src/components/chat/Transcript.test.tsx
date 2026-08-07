import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TurnView } from "./Transcript";
import { type Turn, historyToTurns } from "./turnModel";
import type { HistoryMessage } from "../../lib/types";

function renderToolTurn(toolName: string, output: string) {
  const turn: Turn = {
    kind: "tool",
    id: "t1",
    tool: { toolName, output, isError: false },
  };
  return render(
    <MemoryRouter>
      <TurnView turn={turn} />
    </MemoryRouter>,
  );
}

describe("TurnView — Paddock MCP brand badge", () => {
  it("labels the badge with the TARGET project of a cross-project create_chat", () => {
    // A keeper in `paddock` creates a chat in `herdctl`: the badge must read the
    // result's target project, not the host project's brand name (the bug where
    // it always said "PADDOCK" regardless of target).
    renderToolTurn(
      "mcp__paddock_manage__create_chat",
      JSON.stringify({
        created: true,
        project: "herdctl",
        sessionId: "new-9",
        name: "Fix the thing",
        prompt: "please fix the thing",
      }),
    );
    // The badge text is the raw project slug ("herdctl"); CSS uppercases it to
    // "HERDCTL". The body's "in herdctl" line is a distinct, non-exact match.
    expect(screen.getByText("herdctl", { exact: true })).toBeInTheDocument();
    // It matches the open-chat link's target, so badge and body agree.
    expect(screen.getByRole("link", { name: /open chat/i })).toHaveAttribute(
      "href",
      "/projects/herdctl/chat/new-9",
    );
  });

  it("falls back to the Paddock brand label when the action carries no project", () => {
    renderToolTurn(
      "mcp__paddock_manage__fork_chat_batch",
      JSON.stringify({
        count: 1,
        source: "src-1",
        forks: [{ sessionId: "f1", prompt: "a poem about the sea" }],
      }),
    );
    expect(screen.getByText("Paddock", { exact: true })).toBeInTheDocument();
  });
});

describe("compaction boundary ordering (issue #630)", () => {
  /**
   * The records of one completed `/compact` in the order Claude Code writes them:
   * the continuation summary (stamped when compaction FINISHED) lands *above* the
   * command echo that triggered it. The `system`/`compact_boundary` line and the
   * `isMeta` `<local-command-caveat>` between them are dropped by core's JSONL
   * parser and so never reach the web; see ChatPane.turns.test.ts for the full
   * five-record layout.
   */
  const compaction: HistoryMessage[] = [
    {
      role: "user",
      uuid: "u-summary",
      timestamp: "2026-07-11T21:31:10.255Z",
      content:
        "This session is being continued from a previous conversation that ran out " +
        "of context. The summary below covers the earlier portion of the " +
        "conversation.\n\nSummary:\n1. Primary Request and Intent: a thing.",
    },
    {
      role: "user",
      uuid: "u-cmd",
      timestamp: "2026-07-11T21:29:47.574Z",
      content:
        "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
    },
    {
      role: "user",
      uuid: "u-stdout",
      timestamp: "2026-07-11T21:31:10.568Z",
      content: "<local-command-stdout>Compacted </local-command-stdout>",
    },
  ];

  it("draws the 🗜️ chip below the /compact chip, not above it", () => {
    const { container } = render(
      <MemoryRouter>
        {historyToTurns(compaction).map((t) => (
          <TurnView key={t.id} turn={t} />
        ))}
      </MemoryRouter>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("/compact");
    expect(text).toContain("conversation compacted");
    expect(text.indexOf("conversation compacted")).toBeGreaterThan(text.indexOf("/compact"));
    // Cosmetic only: the summary body stays tucked behind its collapsed
    // disclosure, exactly as before (issue #106).
    const details = container.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("This session is being continued");
  });
});
