import { describe, it, expect } from "vitest";
import { historyToTurns } from "./ChatPane";
import type { HistoryMessage } from "../lib/types";

/** Terse HistoryMessage builder — only `role` is required. */
function msg(o: Partial<HistoryMessage> & Pick<HistoryMessage, "role">): HistoryMessage {
  return { content: "", timestamp: "2026-01-01T00:00:00Z", ...o };
}

const toolCall = (toolName: string, output = "") => ({
  toolName,
  output,
  isError: false,
});

describe("historyToTurns (issue #135: stable per-message id)", () => {
  it("keys each turn id on the source message's uuid", () => {
    const turns = historyToTurns([
      msg({ role: "user", content: "hi", uuid: "u-1" }),
      msg({ role: "assistant", content: "yo", uuid: "u-2" }),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u-1", "u-2"]);
    expect(turns.map((t) => t.kind)).toEqual(["user", "assistant"]);
  });

  it("disambiguates sibling messages that share one uuid with a #n suffix", () => {
    // e.g. an assistant entry with two tool_uses parses into two tool messages
    // that share the entry's uuid — the id must still be unique per turn.
    const turns = historyToTurns([
      msg({ role: "tool", uuid: "u-x", toolCall: toolCall("Bash", "a") }),
      msg({ role: "tool", uuid: "u-x", toolCall: toolCall("Read", "b") }),
      msg({ role: "tool", uuid: "u-x", toolCall: toolCall("Grep", "c") }),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u-x", "u-x#1", "u-x#2"]);
    expect(new Set(turns.map((t) => t.id)).size).toBe(3); // all unique
  });

  it("is reload-stable: the same transcript yields identical ids", () => {
    const input = [
      msg({ role: "user", uuid: "a" }),
      msg({ role: "tool", uuid: "b", toolCall: toolCall("X") }),
      msg({ role: "tool", uuid: "b", toolCall: toolCall("Y") }),
      msg({ role: "assistant", uuid: "c" }),
    ];
    expect(historyToTurns(input).map((t) => t.id)).toEqual(
      historyToTurns(input).map((t) => t.id),
    );
  });

  it("falls back to a unique generated id when a message has no uuid", () => {
    const turns = historyToTurns([msg({ role: "user" }), msg({ role: "assistant" })]);
    expect(turns[0].id).toBeTruthy();
    expect(turns[1].id).toBeTruthy();
    expect(turns[0].id).not.toBe(turns[1].id);
  });

  it("renders a `<task-notification>` user message as a subtle notification turn (issue #181)", () => {
    const notification = [
      "<task-notification>",
      "<task-id>a28e47ea552aa4a31</task-id>",
      "<status>killed</status>",
      '<summary>Agent "Map current unread + persistence" was stopped by user</summary>',
      "<note>A task-notification fires each time this agent stops…</note>",
      "</task-notification>",
    ].join("\n");
    const turns = historyToTurns([msg({ role: "user", uuid: "n-1", content: notification })]);
    expect(turns[0].kind).toBe("notification");
    expect(turns[0].id).toBe("n-1");
    // The raw XML is replaced by the human-readable summary.
    expect(turns[0]).toMatchObject({
      summary: 'Agent "Map current unread + persistence" was stopped by user',
    });
  });

  it("leaves a genuine user message that merely mentions the tag as a user bubble", () => {
    const turns = historyToTurns([
      msg({ role: "user", uuid: "u-9", content: "why does <task-notification> show up?" }),
    ]);
    expect(turns[0].kind).toBe("user");
  });

  it("rebuilds a send_file tool call as a `file` turn, keyed on its uuid", () => {
    const envelope = JSON.stringify({
      paddockSendFile: 1,
      filename: "a.txt",
      kind: "text",
      source: "inline",
      content: "hello",
    });
    const turns = historyToTurns([
      msg({
        role: "tool",
        uuid: "f-1",
        toolCall: toolCall("mcp__paddock__send_file", envelope),
      }),
    ]);
    expect(turns[0].kind).toBe("file");
    expect(turns[0].id).toBe("f-1");
  });
});
