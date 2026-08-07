/**
 * `trimToPairedToolBoundary` — the fork copy's structural guard (issue #731).
 *
 * Forking mid-turn is not an accident to be interlocked away: the `fork_chat`
 * fan-out (#214) is invoked BY a keeper from inside its own running turn, so the
 * source transcript is ALWAYS a mid-flight snapshot there. What that snapshot can
 * end on is an assistant `tool_use` whose `tool_result` had not been written yet
 * — a shape the real Anthropic Messages API rejects on resume ("tool_use ids were
 * found without tool_result blocks"), i.e. a fork born unresumable.
 *
 * So the copy is cut back to the last point at which every `tool_use` has its
 * answer. Pure string→string; the source transcript is never involved.
 */
import { describe, it, expect } from "vitest";
import { trimToPairedToolBoundary } from "../../src/herdctl.js";

const line = (o: unknown): string => JSON.stringify(o);

const userText = (uuid: string, text: string) =>
  line({ uuid, type: "user", message: { role: "user", content: [{ type: "text", text }] } });

const assistantText = (uuid: string, id: string, text: string) =>
  line({
    uuid,
    type: "assistant",
    message: { id, role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
  });

const assistantToolUse = (uuid: string, id: string, toolId: string) =>
  line({
    uuid,
    type: "assistant",
    message: { id, role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Task" }] },
  });

const toolResult = (uuid: string, toolId: string) =>
  line({
    uuid,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId }] },
  });

describe("trimToPairedToolBoundary", () => {
  it("returns a fully paired transcript byte-identical (the idle-fork case)", () => {
    const raw =
      [
        userText("u1", "hello"),
        assistantToolUse("a1", "msg_1", "toolu_1"),
        toolResult("u2", "toolu_1"),
        assistantText("a2", "msg_2", "done"),
      ].join("\n") + "\n";
    // Identity matters: an idle fork must not be reshaped, reserialized, or have
    // its trailing-newline convention changed.
    expect(trimToPairedToolBoundary(raw)).toBe(raw);
  });

  it("drops a trailing tool_use that never got its result", () => {
    const head = [userText("u1", "hello"), assistantText("a1", "msg_1", "hi there")].join("\n");
    const raw = head + "\n" + assistantToolUse("a2", "msg_2", "toolu_open") + "\n";

    const out = trimToPairedToolBoundary(raw);
    expect(out).toBe(head + "\n");
    expect(out).not.toContain("toolu_open");
  });

  it("keeps a completed tool round-trip and only drops the unanswered one after it", () => {
    const kept = [
      userText("u1", "hello"),
      assistantToolUse("a1", "msg_1", "toolu_done"),
      toolResult("u2", "toolu_done"),
      assistantText("a2", "msg_2", "first answer"),
    ].join("\n");
    const raw = kept + "\n" + assistantToolUse("a3", "msg_3", "toolu_open") + "\n";

    const out = trimToPairedToolBoundary(raw);
    expect(out).toBe(kept + "\n");
    expect(out).toContain("toolu_done");
    expect(out).not.toContain("toolu_open");
  });

  it("rewinds past a whole turn when the unanswered tool_use is followed by more records", () => {
    const kept = [userText("u1", "hello"), assistantText("a1", "msg_1", "hi")].join("\n");
    const raw =
      [
        kept,
        assistantToolUse("a2", "msg_2", "toolu_open"),
        // A sibling text block of the same unfinished assistant message.
        assistantText("a3", "msg_2", "let me look that up"),
      ].join("\n") + "\n";

    expect(trimToPairedToolBoundary(raw)).toBe(kept + "\n");
  });

  it("keeps the transcript rather than emptying it when nothing is paired", () => {
    // Trimming would leave zero records — an empty chat is a worse outcome than a
    // suspect one, so the copy is handed back untouched.
    const raw = assistantToolUse("a1", "msg_1", "toolu_open") + "\n";
    expect(trimToPairedToolBoundary(raw)).toBe(raw);
  });

  it("ignores unparseable lines instead of treating them as an imbalance", () => {
    const raw = [userText("u1", "hello"), "not json at all"].join("\n") + "\n";
    expect(trimToPairedToolBoundary(raw)).toBe(raw);
  });

  it("pairs a sidechain (sub-agent) tool call like any other", () => {
    const raw =
      [
        userText("u1", "hello"),
        assistantToolUse("a1", "msg_1", "toolu_task"),
        line({
          uuid: "s1",
          isSidechain: true,
          type: "assistant",
          message: { id: "msg_s", role: "assistant", content: [{ type: "text", text: "working" }] },
        }),
        toolResult("u2", "toolu_task"),
      ].join("\n") + "\n";
    expect(trimToPairedToolBoundary(raw)).toBe(raw);
  });
});
