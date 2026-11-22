import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatVerdict } from "../../lib/types";
import type { Turn } from "./turnModel";
import {
  ReentryBar,
  ReentryMarginCard,
  lastAskOf,
  readReentryExpanded,
} from "./ReentryCard";

const verdict: ChatVerdict = {
  verdict: "could-continue",
  reason: "tests pass, push awaits your OK",
  goal: "Fix the flaky login test.",
  turnCompletedAt: "2026-11-05T10:00:00.000Z",
  judgedAt: "2026-11-05T10:00:04.000Z",
};

beforeEach(() => localStorage.clear());

describe("lastAskOf", () => {
  const user = (content: string, over: Partial<Turn> = {}) =>
    ({ kind: "user", id: content, content, ...over }) as Turn;

  it("picks the latest human-typed message, skipping everything else", () => {
    const turns: Turn[] = [
      user("first ask"),
      user("the real   last\n ask"),
      { kind: "assistant", id: "a", content: "reply", streaming: false },
      { kind: "tool", id: "t", tool: { toolName: "Bash", output: "", isError: false } },
      { kind: "notification", id: "n", summary: "Task done", status: "completed" },
      { kind: "command", id: "c", command: "/compact" },
      { kind: "commandOutput", id: "o", content: "out" },
      { kind: "compact", id: "k", summary: "summary" },
      user("sent by another chat", {
        sender: { kind: "chat", project: "p", sessionId: "x" },
      } as Partial<Turn>),
      user("   "),
    ];
    expect(lastAskOf(turns)).toBe("the real last ask");
  });

  it("drops the preload context block from a first message", () => {
    const wrapped =
      "<project-context>\nOVERVIEW\n</project-context>\n\nMy request:\nMigrate the db";
    expect(lastAskOf([user(wrapped)])).toBe("Migrate the db");
  });

  it("is undefined with no user message", () => {
    expect(lastAskOf([])).toBeUndefined();
    expect(
      lastAskOf([{ kind: "assistant", id: "a", content: "hi", streaming: false }]),
    ).toBeUndefined();
  });
});

describe("ReentryMarginCard", () => {
  it("shows Goal, Last ask and Where it stands in a labelled region", () => {
    render(
      <ReentryMarginCard goal={verdict.goal} lastAsk="push it" verdict={verdict} running={false} />,
    );
    const region = screen.getByRole("region", { name: "Chat summary" });
    expect(region).toHaveAttribute("data-placement", "margin");
    expect(within(region).getByText("Fix the flaky login test.")).toBeInTheDocument();
    expect(within(region).getByText("push it")).toBeInTheDocument();
    expect(
      within(region).getByText("Could continue — tests pass, push awaits your OK"),
    ).toBeInTheDocument();
  });

  it("hides Where it stands while a turn runs", () => {
    render(
      <ReentryMarginCard goal={verdict.goal} lastAsk="push it" verdict={verdict} running />,
    );
    expect(screen.getByText("Fix the flaky login test.")).toBeInTheDocument();
    expect(screen.getByText("push it")).toBeInTheDocument();
    expect(screen.queryByText("Where it stands")).toBeNull();
  });

  it("omits Goal and Where it stands with no verdict, and renders nothing with no ask", () => {
    const { rerender, container } = render(
      <ReentryMarginCard lastAsk="push it" running={false} />,
    );
    expect(screen.getByText("Last ask")).toBeInTheDocument();
    expect(screen.queryByText("Goal")).toBeNull();
    expect(screen.queryByText("Where it stands")).toBeNull();
    rerender(<ReentryMarginCard running={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ReentryBar", () => {
  const props = { goal: verdict.goal, lastAsk: "push it", verdict, running: false };

  it("collapsed shows one line: the Goal, else the Last ask", () => {
    const { rerender } = render(<ReentryBar {...props} />);
    const region = screen.getByRole("region", { name: "Chat summary" });
    expect(region).toHaveAttribute("data-placement", "bar");
    const toggle = within(region).getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Goal: Fix the flaky login test.");
    expect(screen.queryByText("Where it stands")).toBeNull();
    rerender(<ReentryBar lastAsk="push it" running={false} />);
    expect(screen.getByRole("button")).toHaveTextContent("Last ask: push it");
  });

  it("expands from the keyboard to all three lines, and remembers it", async () => {
    const { unmount } = render(<ReentryBar {...props} />);
    const toggle = screen.getByRole("button");
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Goal")).toBeInTheDocument();
    expect(screen.getByText("Last ask")).toBeInTheDocument();
    expect(screen.getByText("Where it stands")).toBeInTheDocument();
    expect(readReentryExpanded()).toBe(true);
    unmount();

    render(<ReentryBar {...props} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button"));
    expect(readReentryExpanded()).toBe(false);
    expect(screen.queryByText("Where it stands")).toBeNull();
  });
});
