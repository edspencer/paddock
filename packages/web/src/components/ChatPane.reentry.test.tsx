import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPane, type ChatPaneProps } from "./ChatPane";
import type { HistoryMessage } from "../lib/types";
import { makeModelsResponse, historyResult } from "../test/factories";

// The re-entry card on the chat page. The socket and API mocks are the minimum
// ChatPane needs to open a chat and send; see ChatPane.test.tsx for the rest.
vi.mock("../lib/ws", () => ({
  chatClient: {
    state: "open",
    onBackgroundWork: (_sessionId: string, cb: (tasks: unknown[]) => void) => {
      cb([]);
      return () => {};
    },
    onStopTaskResult: () => () => {},
    onState: (cb: (s: string) => void) => {
      cb("open");
      return () => {};
    },
    subscribe: () => ({ setSessionId: () => {}, unsubscribe: () => {} }),
    send: () => {},
    setQueued: () => {},
  },
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getModels: async () => makeModelsResponse(),
      chatContext: async () => null,
      projectCommands: async () => [],
      transcriptionStatus: async () => ({ available: false, mode: "off" as const, model: "" }),
    },
  };
});

beforeEach(() => localStorage.clear());

describe("ChatPane: re-entry card", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "fix the flaky test", timestamp: "2026-06-21T10:00:00Z" },
    { role: "assistant", content: "Fixed. Push it?", timestamp: "2026-06-21T10:00:01Z" },
  ];
  const verdict = {
    verdict: "could-continue" as const,
    reason: "push awaits your OK",
    turnCompletedAt: "2026-06-21T10:00:01Z",
    judgedAt: "2026-06-21T10:00:05Z",
  };
  const open = (over: Partial<ChatPaneProps> = {}) =>
    render(
      <ChatPane
        projectSlug="proj"
        initialSessionId="sess-1"
        loadHistory={vi.fn().mockResolvedValue(historyResult(history))}
        goal="Make the login test reliable."
        verdict={verdict}
        {...over}
      />,
    );

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders no card for a new chat, even after its first message", async () => {
    render(<ChatPane projectSlug="proj" />);
    await userEvent.type(screen.getByPlaceholderText(/Message Claude/i), "hello");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect(screen.queryByRole("region", { name: "Chat summary" })).toBeNull();
  });

  it("is a collapsible bar above the transcript on a narrow pane", async () => {
    open();
    const region = await screen.findByRole("region", { name: "Chat summary" });
    expect(region).toHaveAttribute("data-placement", "bar");
    // The bar sits before the transcript, not inside its scroll area.
    expect(region.compareDocumentPosition(screen.getByText("Fixed. Push it?"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(within(region).getByRole("button"));
    expect(within(region).getByText("fix the flaky test")).toBeInTheDocument();
    expect(within(region).getByText("Could continue — push awaits your OK")).toBeInTheDocument();
  });

  it("is pinned in the right margin when the transcript area is wide enough", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1400,
    } as DOMRect);
    open();
    const region = await screen.findByRole("region", { name: "Chat summary" });
    expect(region).toHaveAttribute("data-placement", "margin");
    expect(region.parentElement).toHaveClass("absolute", "right-6", "bottom-6");
    expect(screen.getAllByRole("region", { name: "Chat summary" })).toHaveLength(1);
    expect(within(region).getByText("Make the login test reliable.")).toBeInTheDocument();
  });

  it("hides Where it stands while a turn runs, keeping the Goal and the new ask", async () => {
    localStorage.setItem("paddock:reentry-expanded", "1");
    open();
    const region = await screen.findByRole("region", { name: "Chat summary" });
    expect(within(region).getByText("Where it stands")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/Message Claude/i), "yes, push");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
    expect(within(region).queryByText("Where it stands")).toBeNull();
    expect(within(region).getByText("Make the login test reliable.")).toBeInTheDocument();
    expect(within(region).getByText("yes, push")).toBeInTheDocument();
  });
});
