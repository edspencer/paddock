import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TurnRow, TurnView } from "./Transcript";
import {
  PermissionDecisionsContext,
  TurnActionsContext,
  type TurnActionsValue,
} from "./chatContexts";
import { type Turn, historyToTurns } from "./turnModel";
import type { HistoryMessage, PermissionDecision } from "../../lib/types";

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

describe("TurnView — full tool input", () => {
  const command = `${"x".repeat(250)}\necho done`;

  function renderBash() {
    const turn: Turn = {
      kind: "tool",
      id: "t1",
      tool: {
        toolName: "Bash",
        inputSummary: command.slice(0, 200),
        input: { command, timeout: 60000 },
        output: "done",
        isError: false,
      },
    };
    return render(
      <MemoryRouter>
        <TurnView turn={turn} />
      </MemoryRouter>,
    );
  }

  it("shows every argument verbatim once the card is expanded", () => {
    renderBash();
    expect(screen.queryByText(command)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    // The string argument keeps its full length and line break; a non-string
    // argument renders as JSON. The output still follows the input.
    expect(
      screen.getByText((_, el) => el?.tagName === "PRE" && el.textContent === command),
    ).toBeInTheDocument();
    expect(screen.getByText("timeout")).toBeInTheDocument();
    expect(screen.getByText("60000")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("shows an empty string argument as a visible empty string", () => {
    render(
      <MemoryRouter>
        <TurnView
          turn={{
            kind: "tool",
            id: "t1",
            tool: { toolName: "Grep", input: { pattern: "" }, output: "", isError: false },
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText('""')).toBeInTheDocument();
  });

  it("leaves the input to a specialised body rather than repeating it", () => {
    const input = { file_path: "/x/a.ts", old_string: "before", new_string: "after" };
    const renderEdit = (withDiff: boolean) =>
      render(
        <MemoryRouter>
          <TurnView
            turn={{
              kind: "tool",
              id: withDiff ? "e1" : "e2",
              tool: {
                toolName: "Edit",
                input,
                output: "ok",
                isError: false,
                editDiff: withDiff
                  ? { kind: "edit", additions: 1, deletions: 1, hunks: [] }
                  : undefined,
              },
            }}
          />
        </MemoryRouter>,
      );

    const { unmount } = renderEdit(true);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("old_string")).not.toBeInTheDocument();
    unmount();

    // Control: with no diff to show, the generic body carries the input.
    renderEdit(false);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("old_string")).toBeInTheDocument();
    expect(screen.getByText("before")).toBeInTheDocument();
  });
});

describe("TurnView — permission decision (#971)", () => {
  const decision: PermissionDecision = {
    toolUseId: "toolu_1",
    toolName: "Write",
    subject: "/home/u/.claude/notes.md",
    outcome: "deny",
    requestedAt: 0,
    decidedAt: 0,
  };
  const writeTurn = (extra: object = {}): Turn => ({
    kind: "tool",
    id: "t1",
    tool: { toolName: "Write", toolUseId: "toolu_1", output: "denied", isError: true, ...extra },
  });

  it("shows the decision a history row carries above its tool card", () => {
    render(
      <MemoryRouter>
        <TurnView turn={writeTurn({ permission: decision })} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("permission-decision")).toHaveTextContent("Denied");
  });

  it("falls back to a live decision for the same tool_use", () => {
    render(
      <MemoryRouter>
        <PermissionDecisionsContext.Provider
          value={new Map([["toolu_1", { ...decision, outcome: "once" }]])}
        >
          <TurnView turn={writeTurn()} />
          <TurnView turn={{ ...writeTurn(), id: "t2", tool: { ...writeTurn().tool, toolUseId: "x" } }} />
        </PermissionDecisionsContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId("permission-decision")).toHaveLength(1);
    expect(screen.getByText("Allowed once")).toBeInTheDocument();
  });

  it("shows nothing for a tool call with no prompt", () => {
    renderToolTurn("Read", "file contents");
    expect(screen.queryByTestId("permission-decision")).not.toBeInTheDocument();
  });
});

describe("TurnRow — per-message deep link", () => {
  const UUID = "8f14e45f-ceea-467a-9a3f-1b2c3d4e5f60";

  /** One transcript record; `extra` adds a SECOND message carrying the same uuid. */
  function messages(extra = false): HistoryMessage[] {
    const base: HistoryMessage[] = [
      {
        role: "assistant",
        uuid: UUID,
        timestamp: "2026-08-12T09:00:00.000Z",
        content: "the first half of one record",
      },
    ];
    if (extra) {
      base.push({
        role: "assistant",
        uuid: UUID,
        timestamp: "2026-08-12T09:00:00.000Z",
        content: "the second half of the SAME record",
      });
    }
    return base;
  }

  function renderTurns(msgs: HistoryMessage[], overrides: Partial<TurnActionsValue> = {}) {
    const actions: TurnActionsValue = {
      onFork: vi.fn(),
      onRevert: vi.fn(),
      linkTo: (uuid) => `https://paddock.test/projects/p/chat/sess-1#m-${uuid}`,
      focused: null,
      ...overrides,
    };
    const view = render(
      <MemoryRouter>
        <TurnActionsContext.Provider value={actions}>
          {historyToTurns(msgs).map((t) => (
            <TurnRow key={t.id} turn={t} />
          ))}
        </TurnActionsContext.Provider>
      </MemoryRouter>,
    );
    return { ...view, actions };
  }

  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  it("makes the time/context pill a real link to the message", () => {
    renderTurns(messages());
    // A real anchor with a real href is the whole point: it is what makes
    // right-click → "Copy link address" and ⌘-click → new tab work.
    expect(screen.getByRole("link", { name: /copy a link to this message/i })).toHaveAttribute(
      "href",
      `https://paddock.test/projects/p/chat/sess-1#m-${UUID}`,
    );
  });

  it("puts the anchor id on the FIRST row of a record only", () => {
    // One JSONL record can render as several turns (`uuid`, `uuid#1`, …). If each
    // carried the id, the document would hold duplicates and a browser jump would
    // land on whichever came first anyway — so only the first row is the anchor.
    const { container } = renderTurns(messages(true));
    expect(container.querySelectorAll(`#m-${UUID}`)).toHaveLength(1);
    // Both rows still offer the pill; both copy the same record-level link.
    const links = screen.getAllByRole("link", { name: /copy a link to this message/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", links[1].getAttribute("href")!);
  });

  it("copies the link on a plain click instead of navigating", async () => {
    renderTurns(messages());
    const link = screen.getByRole("link", { name: /copy a link to this message/i });
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, ev);
    expect(writeText).toHaveBeenCalledWith(
      `https://paddock.test/projects/p/chat/sess-1#m-${UUID}`,
    );
    expect(ev.defaultPrevented).toBe(true);
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });

  it("leaves a modified click to the browser", () => {
    // ⌘/ctrl-click must open the link in a new tab, which means NOT swallowing
    // the event — the one case where the anchor behaves as an ordinary anchor.
    // The href is same-document here, as it is in real use: you are already on
    // the chat the link points into.
    renderTurns(messages(), {
      linkTo: (uuid) => `${window.location.href.split("#")[0]}#m-${uuid}`,
    });
    const link = screen.getByRole("link", { name: /copy a link to this message/i });
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    fireEvent(link, ev);
    expect(writeText).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("scrolls to and flashes the focused message", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = renderTurns(messages(), {
      focused: { uuid: UUID, nonce: 1 },
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(container.querySelector(`#m-${UUID}`)).toHaveClass("reveal-flash");
  });

  it("offers no link on a live turn, which has no reload-stable id yet", () => {
    // A streaming turn carries an ephemeral `t<n>` id, so a link to it would break
    // on the next reload. Same gate that already hides fork/revert there.
    render(
      <MemoryRouter>
        <TurnActionsContext.Provider
          value={{
            onFork: vi.fn(),
            onRevert: vi.fn(),
            linkTo: () => "https://paddock.test/x",
            focused: null,
          }}
        >
          <TurnRow
            turn={{ kind: "assistant", id: "t1", text: "still typing", timestamp: "2026-08-12T09:00:00.000Z" } as Turn}
          />
        </TurnActionsContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /copy a link to this message/i })).toBeNull();
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
