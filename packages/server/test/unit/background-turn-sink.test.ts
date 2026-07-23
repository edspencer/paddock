import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@herdctl/core";
import { isSidechainMessage } from "../../src/ws-turn.js";

/**
 * Coverage for the background sub-agent sidechain skip (`isSidechainMessage`).
 *
 * A background sub-agent (`Task` run_in_background) delivers its nested
 * `isSidechain` steps INLINE on the re-invocation stream (each carries a
 * `parent_tool_use_id` pointing at the spawning Task). The background sink skips
 * these from LIVE top-level rendering — matching the foreground/history path,
 * which never draws a sub-agent's nested steps as top-level rows (they surface
 * only via the subagents endpoint on card-expand). The attribution lives on the
 * top-level SDK message OR its nested `message` shell, so we check both.
 */
describe("isSidechainMessage", () => {
  it("is true when the top-level message carries a parent_tool_use_id", () => {
    const m = {
      type: "assistant",
      parent_tool_use_id: "toolu_task_123",
      message: { content: [{ type: "text", text: "nested step" }] },
    } as unknown as SDKMessage;
    expect(isSidechainMessage(m)).toBe(true);
  });

  it("is true when only the nested message shell carries a parent_tool_use_id", () => {
    const m = {
      type: "user",
      message: {
        parent_tool_use_id: "toolu_task_123",
        content: [{ type: "tool_result", tool_use_id: "toolu_inner" }],
      },
    } as unknown as SDKMessage;
    expect(isSidechainMessage(m)).toBe(true);
  });

  it("is false for a main-agent message (no parent_tool_use_id anywhere)", () => {
    const m = {
      type: "assistant",
      message: { content: [{ type: "text", text: "SYNTH: ..." }] },
    } as unknown as SDKMessage;
    expect(isSidechainMessage(m)).toBe(false);
  });

  it("is false when parent_tool_use_id is explicitly null (main agent)", () => {
    const m = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { parent_tool_use_id: null, content: [] },
    } as unknown as SDKMessage;
    expect(isSidechainMessage(m)).toBe(false);
  });

  it("is false for a system message (task_notification etc. are main-lane)", () => {
    const m = { type: "system", subtype: "task_notification" } as unknown as SDKMessage;
    expect(isSidechainMessage(m)).toBe(false);
  });
});
