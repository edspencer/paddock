import { describe, it, expect } from "vitest";
import { extractLocalCommandOutput } from "../../src/ws.js";

/**
 * A `model:"<synthetic>"` assistant SDK message — the LIVE-stream shape a client-local
 * slash command (`/context`, `/usage`, …) returns its rendered output as (issue #158).
 */
function syntheticMessage(text: string): unknown {
  return {
    type: "assistant",
    session_id: "s",
    message: { model: "<synthetic>", content: [{ type: "text", text }] },
  };
}

/** The disk/canonical shape: a `system`/`local_command` entry wrapping stdout. */
function localCommandEntry(inner: string): unknown {
  return { type: "system", subtype: "local_command", content: `<local-command-stdout>${inner}</local-command-stdout>` };
}

describe("extractLocalCommandOutput — surfacing local-command output (#158)", () => {
  it("recovers output from a synthetic /context message (live-stream form)", () => {
    const table = "## Context Usage\n\n**Tokens:** 21.3k / 200k (11%)";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput(syntheticMessage(table) as any)).toBe(table);
  });

  it("recovers output from a system/local_command entry (disk form)", () => {
    const summary = "Total cost: $0.0000\nUsage: 0 input, 0 output";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput(localCommandEntry(summary) as any)).toBe(summary);
  });

  it("drops CC's trivial placeholder turns (e.g. the /compact continuation)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput(syntheticMessage("No response requested.") as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput(syntheticMessage("   ") as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput(localCommandEntry("   ") as any)).toBeNull();
  });

  it("ignores real (non-synthetic) assistant messages and other types", () => {
    const real = {
      type: "assistant",
      session_id: "s",
      message: { model: "claude-opus-4-8", content: [{ type: "text", text: "hi there" }] },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput(real as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput({ type: "result", session_id: "s" } as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractLocalCommandOutput({ type: "system", subtype: "init" } as any)).toBeNull();
  });
});
