import { describe, it, expect } from "vitest";
import { sliceTranscriptAtUuid } from "../../src/herdctl.js";

/**
 * Transcript-slice boundary rules for fork/revert (#451). Records are the Claude
 * Code JSONL shape: each line has `uuid`, `type`, and `message` (with `role`,
 * `content`, `stop_reason`). A turn spans several records.
 */
function line(o: unknown): string {
  return JSON.stringify(o);
}
function userPrompt(uuid: string, text: string): string {
  return line({ uuid, type: "user", message: { role: "user", content: text } });
}
function assistantText(uuid: string, id: string, text: string, stop = "end_turn"): string {
  return line({
    uuid,
    type: "assistant",
    message: { id, role: "assistant", stop_reason: stop, content: [{ type: "text", text }] },
  });
}
function assistantToolUse(uuid: string, id: string, name: string): string {
  return line({
    uuid,
    type: "assistant",
    message: { id, role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: uuid + "-tu", name }] },
  });
}
function toolResult(uuid: string): string {
  return line({
    uuid,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] },
  });
}
function taskNotification(uuid: string): string {
  return line({ uuid, type: "user", message: { role: "user", content: "<task-notification>bg</task-notification>" } });
}

/** A conversation: U1 → A1(tool)→result→A1b(done) → [task-notif] → U2(prompt) → A2(done). */
const raw =
  [
    userPrompt("u1", "first question"),
    assistantText("a1", "m1", "let me check", "tool_use"),
    assistantToolUse("a1b", "m1", "Bash"),
    toolResult("r1"),
    assistantText("a1c", "m2", "LAUNCHED1", "end_turn"),
    taskNotification("tn1"),
    userPrompt("u2", "second question"),
    assistantText("a2", "m3", "LAUNCHED2", "end_turn"),
  ].join("\n") + "\n";

function uuids(sliced: string | null): string[] {
  if (sliced == null) return [];
  return sliced
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).uuid as string);
}

describe("sliceTranscriptAtUuid — revert lands on a completed assistant turn (#451)", () => {
  it("fork (default) keeps the anchor user prompt as the last turn", () => {
    // Forking from a user prompt keeps it — the fork's keeper answers it.
    expect(uuids(sliceTranscriptAtUuid(raw, "u2"))).toEqual([
      "u1", "a1", "a1b", "r1", "a1c", "tn1", "u2",
    ]);
  });

  it("revert to a user prompt rewinds to the previous completed assistant turn", () => {
    // endOnCompletedAssistant=true: reverting to U2 must NOT leave U2 (or the
    // task-notification) dangling — it lands on A1's completed turn (LAUNCHED1).
    expect(uuids(sliceTranscriptAtUuid(raw, "u2", true))).toEqual([
      "u1", "a1", "a1b", "r1", "a1c",
    ]);
  });

  it("revert to an assistant turn keeps it (+ its own trailing tool calls)", () => {
    // Anchor is the assistant text that opened a tool turn: keep it, its tool_use
    // sibling (same message id), and the tool_result answering it.
    expect(uuids(sliceTranscriptAtUuid(raw, "a1", true))).toEqual(["u1", "a1", "a1b", "r1"]);
  });

  it("returns null for an unknown uuid", () => {
    expect(sliceTranscriptAtUuid(raw, "nope", true)).toBeNull();
  });

  it("reverting to the very first user prompt (no prior AI turn) falls back to keeping it", () => {
    expect(uuids(sliceTranscriptAtUuid(raw, "u1", true))).toEqual(["u1"]);
  });
});
