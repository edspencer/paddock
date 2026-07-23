import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TurnView } from "./Transcript";
import type { Turn } from "./turnModel";

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
