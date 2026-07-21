/**
 * Unit tests for turn-notice classification (issue #329) — the logic that turns
 * a silently-dead-ending keeper turn (a synthetic usage-limit message, or a
 * terminal error result) into a surfaced {@link TurnNotice}.
 *
 * Two halves:
 *  - PURE classifiers (`classifySyntheticText` / `classifyResult` /
 *    `noticeFromMessage`) pinned against the exact on-box shapes.
 *  - `scanTranscriptNotice` driven through a temp JSONL file so the
 *    history-hydration "trailing dead-end" rule is deterministic.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifySyntheticText,
  classifyResult,
  noticeFromMessage,
  errorNotice,
  scanTranscriptNotice,
} from "../../src/turn-notice.js";

// The real on-box synthetic session-limit text (chat 6b87fdbe), · included.
const LIMIT = "You've hit your session limit · resets 7:10pm (America/New_York)";

// A synthetic assistant SDK message with the given text block(s).
const synthetic = (text: string) => ({
  type: "assistant",
  message: {
    role: "assistant",
    model: "<synthetic>",
    stop_reason: "stop_sequence",
    content: [{ type: "text", text }],
  },
});
// A JSONL line for the transcript scanner.
const syntheticLine = (text: string) => JSON.stringify(synthetic(text));
const realAssistantLine = (text: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: text } });

describe("classifySyntheticText (#329)", () => {
  it("classifies the session-limit message as a non-retryable usage_limit + parses the reset clause", () => {
    const n = classifySyntheticText(LIMIT);
    expect(n).toMatchObject({
      kind: "usage_limit",
      retryable: false,
      resetTime: "7:10pm (America/New_York)",
    });
    expect((n as { message: string }).message).toContain("session limit");
  });

  it("matches a reworded 'usage limit' message and tolerates no reset clause", () => {
    const n = classifySyntheticText("You've hit your usage limit");
    expect(n).toMatchObject({ kind: "usage_limit", retryable: false });
    expect((n as { resetTime?: string }).resetTime).toBeUndefined();
  });

  it("declines 'No response requested.' (a suppressed placeholder, never a bubble)", () => {
    expect(classifySyntheticText("No response requested.")).toBe("declined");
  });

  it("declines any other non-limit synthetic placeholder", () => {
    expect(classifySyntheticText("Some other synthetic note")).toBe("declined");
  });

  it("returns null for empty text", () => {
    expect(classifySyntheticText("   ")).toBeNull();
  });
});

describe("classifyResult (#329)", () => {
  it("classifies error_max_turns as a retryable max_turns notice with the subtype detail", () => {
    expect(classifyResult({ subtype: "error_max_turns" })).toMatchObject({
      kind: "max_turns",
      retryable: true,
      detail: "error_max_turns",
    });
  });

  // #329 REGRESSION: a `subtype:"success"` result with `is_error:true` is a
  // turn that RECOVERED from a transient mid-turn API error and still produced a
  // normal reply — NOT a failure. (`SDKResultSuccess` is typed `is_error: boolean`
  // and the runtime stamps it true on a recovered success; herdctl's own success
  // computation keys off the subtype, so ours must too.) It must NOT flag, or a
  // false "turn failed" banner renders beneath a perfectly good reply.
  it("returns null for a success result flagged is_error:true (recovered mid-turn API error, #329 regression)", () => {
    expect(classifyResult({ subtype: "success", is_error: true })).toBeNull();
  });

  it("classifies any error_* subtype as a generic error notice", () => {
    expect(classifyResult({ subtype: "error_during_execution" })).toMatchObject({ kind: "error" });
    // A real error result always ALSO carries is_error:true — still classified.
    expect(classifyResult({ subtype: "error_during_execution", is_error: true })).toMatchObject({
      kind: "error",
    });
  });

  it("classifies success === false as an error notice", () => {
    expect(classifyResult({ success: false })).toMatchObject({ kind: "error" });
  });

  it("treats a bare is_error:true (no subtype) as an error — defensive fallback", () => {
    expect(classifyResult({ is_error: true })).toMatchObject({ kind: "error" });
  });

  it("returns null for a successful result", () => {
    expect(classifyResult({ subtype: "success", is_error: false, success: true })).toBeNull();
    expect(classifyResult({ subtype: "success" })).toBeNull();
  });
});

describe("noticeFromMessage (#329)", () => {
  it("surfaces a usage_limit from a synthetic assistant message", () => {
    expect(noticeFromMessage(synthetic(LIMIT))).toMatchObject({ kind: "usage_limit" });
  });

  it("suppresses a synthetic 'No response requested.' (returns null)", () => {
    expect(noticeFromMessage(synthetic("No response requested."))).toBeNull();
  });

  it("ignores a real assistant message", () => {
    expect(
      noticeFromMessage({ type: "assistant", message: { model: "claude-opus-4-8", content: "hi" } }),
    ).toBeNull();
  });

  it("surfaces an error from a terminal error result and null from a success result", () => {
    expect(noticeFromMessage({ type: "result", subtype: "error_max_turns" })).toMatchObject({
      kind: "max_turns",
    });
    expect(noticeFromMessage({ type: "result", subtype: "success" })).toBeNull();
  });

  it("returns null for a recovered-success result (subtype success + is_error:true, #329 regression)", () => {
    // The exact terminal shape a session-mode turn emits after recovering from a
    // mid-turn "Connection closed mid-response" API hiccup and finishing normally.
    expect(
      noticeFromMessage({ type: "result", subtype: "success", is_error: true } as never),
    ).toBeNull();
  });

  it("ignores unrelated message types", () => {
    expect(noticeFromMessage({ type: "system" })).toBeNull();
    expect(noticeFromMessage({ type: "user", message: { content: "hi" } })).toBeNull();
  });
});

describe("errorNotice (#329)", () => {
  it("builds a retryable error notice carrying the raw message as detail", () => {
    expect(errorNotice("ECONNRESET reaching api.anthropic.com")).toMatchObject({
      kind: "error",
      retryable: true,
      detail: "ECONNRESET reaching api.anthropic.com",
    });
  });
  it("omits detail for an empty message", () => {
    expect(errorNotice("   ").detail).toBeUndefined();
  });
});

describe("scanTranscriptNotice (#329)", () => {
  const withFile = async (lines: string[], fn: (p: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(tmpdir(), "turn-notice-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    try {
      await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("surfaces a trailing usage-limit dead-end (the #329 repro shape)", async () => {
    await withFile(
      [
        realAssistantLine("earlier real reply"),
        JSON.stringify({ type: "user", message: { content: "hi?" } }),
        syntheticLine(LIMIT),
        syntheticLine("No response requested."),
        syntheticLine(LIMIT),
      ],
      async (file) => {
        const n = await scanTranscriptNotice(file);
        expect(n).toMatchObject({ kind: "usage_limit", resetTime: "7:10pm (America/New_York)" });
      },
    );
  });

  it("clears the notice when a real assistant reply follows the limit (turn recovered)", async () => {
    await withFile(
      [syntheticLine(LIMIT), realAssistantLine("the keeper answered after the reset")],
      async (file) => {
        expect(await scanTranscriptNotice(file)).toBeNull();
      },
    );
  });

  it("returns null for a transcript with no synthetic dead-end", async () => {
    await withFile([realAssistantLine("all good")], async (file) => {
      expect(await scanTranscriptNotice(file)).toBeNull();
    });
  });

  it("a lone 'No response requested.' placeholder is not surfaced", async () => {
    await withFile([syntheticLine("No response requested.")], async (file) => {
      expect(await scanTranscriptNotice(file)).toBeNull();
    });
  });

  it("returns null (never throws) for a missing file", async () => {
    expect(await scanTranscriptNotice("/no/such/transcript.jsonl")).toBeNull();
  });
});
