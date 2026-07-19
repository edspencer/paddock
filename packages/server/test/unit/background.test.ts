import { describe, it, expect } from "vitest";
import { enrichWithBackground } from "../../src/background.js";
import type { EnrichedMessage } from "../../src/subagents.js";

/** Terse EnrichedMessage builders. */
function tool(toolName: string, output: string, extra: Record<string, unknown> = {}): EnrichedMessage {
  return {
    role: "tool",
    content: "",
    timestamp: "2026-07-16T00:00:00Z",
    toolCall: { toolName, output, isError: false, ...extra },
  };
}
function notif(inner: string): EnrichedMessage {
  return {
    role: "user",
    content: `<task-notification>\n${inner}\n</task-notification>`,
    timestamp: "2026-07-16T00:00:01Z",
    origin: { kind: "task-notification" },
  };
}
function user(content: string): EnrichedMessage {
  return { role: "user", content, timestamp: "2026-07-16T00:00:00Z" };
}

describe("enrichWithBackground (issue #230)", () => {
  it("links a background Bash to its completion notification by task id", () => {
    const msgs = [
      user("start the server"),
      tool(
        "Bash",
        "Command running in background with ID: bmkcnswna. Output is being written to: /tmp/x/tasks/bmkcnswna.output. You will be notified when it completes.",
      ),
      notif(
        "<task-id>bmkcnswna</task-id>\n<output-file>/tmp/x/tasks/bmkcnswna.output</output-file>\n<status>completed</status>\n<summary>Background command \"Start server\" completed (exit code 0)</summary>",
      ),
    ];
    const out = enrichWithBackground(msgs);
    const tc = out[1].toolCall!;
    expect(tc.background).toBe(true);
    expect(tc.taskId).toBe("bmkcnswna");
    expect(tc.taskStatus).toBe("completed");
    expect(tc.taskResultSummary).toContain("exit code 0");
    // The folded notification is marked consumed so the web drops the pill.
    expect(out[2].bgConsumed).toBe(true);
  });

  it("groups Monitor events under the launching Monitor call", () => {
    const msgs = [
      tool("Monitor", "Monitor started (task by2uf7pij, timeout 600000ms). You will be notified on each event."),
      notif('<task-id>by2uf7pij</task-id>\n<summary>Monitor event: "whisper build"</summary>\n<event>whisper-cli BUILT</event>'),
      notif('<task-id>by2uf7pij</task-id>\n<summary>Monitor event: "whisper build"</summary>\n<event>[Monitor timed out — re-arm if needed.]</event>'),
    ];
    const out = enrichWithBackground(msgs);
    const tc = out[0].toolCall!;
    expect(tc.background).toBe(true);
    expect(tc.taskId).toBe("by2uf7pij");
    expect(tc.monitorEvents).toEqual(["whisper-cli BUILT", "[Monitor timed out — re-arm if needed.]"]);
    // Inferred from the timeout event (Monitors rarely carry an explicit <status>).
    expect(tc.taskStatus).toBe("timed out");
    expect(out[1].bgConsumed).toBe(true);
    expect(out[2].bgConsumed).toBe(true);
  });

  it("marks a persistent Monitor with no terminal event as persistent", () => {
    const msgs = [
      tool("Monitor", "Monitor started (task b85gbpypg, persistent — runs until TaskStop or session end)."),
    ];
    const out = enrichWithBackground(msgs);
    expect(out[0].toolCall!.taskStatus).toBe("persistent");
    expect(out[0].toolCall!.background).toBe(true);
  });

  it("flags a still-running background Bash with no notification yet", () => {
    const msgs = [tool("Bash", "Command running in background with ID: bwz4ndr0y. Output is being written to: /tmp/x.output.")];
    const out = enrichWithBackground(msgs);
    expect(out[0].toolCall!.background).toBe(true);
    expect(out[0].toolCall!.taskStatus).toBe("running");
    expect(out[0].toolCall!.taskResultSummary).toBeUndefined();
  });

  it("flags background-task ops (TaskStop) with a badge and recovered task id", () => {
    const msgs = [
      tool("TaskStop", '{"message":"Successfully stopped task: bmkcnswna (cd /opt && node …)"}'),
      tool("BashOutput", "some streamed output"),
    ];
    const out = enrichWithBackground(msgs);
    expect(out[0].toolCall!.background).toBe(true);
    expect(out[0].toolCall!.taskId).toBe("bmkcnswna");
    expect(out[1].toolCall!.background).toBe(true);
  });

  it("does NOT consume a notification whose task id has no launch", () => {
    const msgs = [
      tool("Read", "file contents"),
      notif("<task-id>orphan123</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>"),
    ];
    const out = enrichWithBackground(msgs);
    expect(out[1].bgConsumed).toBeUndefined();
  });

  it("passes a background-free transcript through unchanged (early return identity)", () => {
    const msgs = [user("hi"), tool("Read", "x"), tool("Grep", "y")];
    const out = enrichWithBackground(msgs);
    expect(out).toBe(msgs); // same reference — cheap early return
  });

  it("detects task-notifications by content even without an origin tag", () => {
    const raw: EnrichedMessage = {
      role: "user",
      content:
        "<task-notification>\n<task-id>bmkcnswna</task-id>\n<status>killed</status>\n<summary>Background command killed</summary>\n</task-notification>",
      timestamp: "2026-07-16T00:00:01Z",
    };
    const msgs = [tool("Bash", "Command running in background with ID: bmkcnswna. Output …"), raw];
    const out = enrichWithBackground(msgs);
    // The status STILL folds onto the launching tool block (the "killed" chip)…
    expect(out[0].toolCall!.taskStatus).toBe("killed");
    // …but a KILLED notification is NOT folded away (issue #301, Layer 2): it must
    // surface as a standalone affordance so the recovery UI can hang off it.
    expect(out[1].bgConsumed).toBeUndefined();
  });

  it("still folds a COMPLETED notification away (only killed/stopped surface)", () => {
    const raw: EnrichedMessage = {
      role: "user",
      content:
        "<task-notification>\n<task-id>done1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>",
      timestamp: "2026-07-16T00:00:01Z",
    };
    const msgs = [tool("Bash", "Command running in background with ID: done1. Output …"), raw];
    const out = enrichWithBackground(msgs);
    expect(out[0].toolCall!.taskStatus).toBe("completed");
    expect(out[1].bgConsumed).toBe(true);
  });

  it("keeps a STOPPED notification visible too (turn-boundary teardown)", () => {
    const raw: EnrichedMessage = {
      role: "user",
      content:
        "<task-notification>\n<task-id>stp1</task-id>\n<status>stopped</status>\n<summary>Background command was stopped by the user</summary>\n</task-notification>",
      timestamp: "2026-07-16T00:00:01Z",
    };
    const msgs = [tool("Bash", "Command running in background with ID: stp1. Output …"), raw];
    const out = enrichWithBackground(msgs);
    expect(out[0].toolCall!.taskStatus).toBe("stopped");
    expect(out[1].bgConsumed).toBeUndefined();
  });
});
