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
  messageProducedReply,
  suppressNoticeAfterReply,
  type TurnNotice,
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

describe("messageProducedReply (#380)", () => {
  it("is true for a real assistant reply with end_turn + non-empty text", () => {
    expect(
      messageProducedReply({
        type: "assistant",
        message: { model: "claude-opus-4-8", stop_reason: "end_turn", content: [{ type: "text", text: "Hi." }] },
      }),
    ).toBe(true);
  });

  it("is true for a real assistant reply with text and NO stop_reason (runtime omits it)", () => {
    expect(
      messageProducedReply({ type: "assistant", message: { model: "claude-opus-4-8", content: "Hi." } }),
    ).toBe(true);
  });

  it("is false for a synthetic assistant message (a placeholder / limit is not a reply)", () => {
    expect(
      messageProducedReply({
        type: "assistant",
        message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "limit" }] },
      }),
    ).toBe(false);
  });

  it("is false for an assistant message with empty text", () => {
    expect(
      messageProducedReply({ type: "assistant", message: { model: "claude-opus-4-8", stop_reason: "end_turn", content: "   " } }),
    ).toBe(false);
  });

  // #394: a tool-heavy turn carries its visible prose in a message that ALSO makes
  // a tool call (`stop_reason:"tool_use"`). That message DID show the user real
  // text, so it counts as a produced reply — the old text+`end_turn` gate wrongly
  // excluded it, leaving a false "turn failed" banner beneath the answer.
  it("is TRUE for a text-bearing tool_use assistant message (stop_reason:'tool_use', #394)", () => {
    expect(
      messageProducedReply({
        type: "assistant",
        message: { model: "claude-opus-4-8", stop_reason: "tool_use", content: [{ type: "text", text: "Here you go, calling a tool…" }] },
      }),
    ).toBe(true);
  });

  // #394: a tool-only assistant message (a bare tool_use, no text) is NOT prose —
  // it must not flip the reply flag on its own.
  it("is false for a tool_use assistant message with NO text block (#394)", () => {
    expect(
      messageProducedReply({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
        },
      }),
    ).toBe(false);
  });

  // #394: a terminal `end_turn` message that is THINKING-ONLY (zero text) is not a
  // reply by itself — but see the accumulation test below: prior text in the turn
  // already flipped the flag, so the turn still counts.
  it("is false for a thinking-only end_turn assistant message (zero text, #394)", () => {
    expect(
      messageProducedReply({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "wrapping up" }],
        },
      }),
    ).toBe(false);
  });

  it("is false for non-assistant messages", () => {
    expect(messageProducedReply({ type: "result", subtype: "success" })).toBe(false);
    expect(messageProducedReply({ type: "user", message: { content: "hi" } })).toBe(false);
  });
});

// #394: the live paths (`ws.ts`) OR-accumulate `messageProducedReply` across every
// message of a turn (`producedReply = producedReply || messageProducedReply(m)`).
// These pin the whole-turn behaviour for the exact tool-heavy shapes that used to
// paint a false banner — text-on-a-tool_use message + a thinking-only terminal — vs
// a genuinely empty turn that must STILL surface the error.
describe("turn-level producedReply accumulation (#394)", () => {
  // Fold the predicate over a turn's messages the way ws.ts does.
  const turnProducedReply = (messages: unknown[]): boolean =>
    messages.reduce<boolean>((acc, m) => acc || messageProducedReply(m as never), false);

  it("counts a turn whose prose rides on a tool_use message, ending thinking-only + error result", () => {
    const turn = [
      // Prose lives on the message that ALSO makes the tool call.
      { type: "assistant", message: { model: "claude-opus-4-8", stop_reason: "tool_use", content: [
        { type: "text", text: "On it — reading the file now." },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "notes.md" } },
      ] } },
      // Paired tool result (a user line — never a reply).
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "…" }] } },
      // Terminal end_turn message is THINKING-ONLY (zero text).
      { type: "assistant", message: { model: "claude-opus-4-8", stop_reason: "end_turn", content: [
        { type: "thinking", thinking: "Done; nothing more to add." },
      ] } },
      // The benign terminal error result that used to paint the false banner.
      { type: "result", subtype: "error_during_execution", is_error: true },
    ];
    expect(turnProducedReply(turn)).toBe(true);
  });

  it("does NOT count a genuinely empty turn (no assistant text anywhere) — error still surfaces", () => {
    const turn = [
      // A bare tool_use (no text) then a thinking-only terminal — no prose at all.
      { type: "assistant", message: { model: "claude-opus-4-8", stop_reason: "tool_use", content: [
        { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      ] } },
      { type: "assistant", message: { model: "claude-opus-4-8", stop_reason: "end_turn", content: [
        { type: "thinking", thinking: "hit the cap" },
      ] } },
      { type: "result", subtype: "error_max_turns", is_error: true },
    ];
    expect(turnProducedReply(turn)).toBe(false);
    // …so the terminal error result is NOT suppressed → banner shows.
    const notice = noticeFromMessage(turn[turn.length - 1] as never);
    expect(notice).toMatchObject({ kind: "max_turns" });
    expect(suppressNoticeAfterReply(notice as TurnNotice, turnProducedReply(turn))).toBe(false);
  });
});

describe("suppressNoticeAfterReply (#380)", () => {
  const notice = (kind: TurnNotice["kind"]): TurnNotice => ({ kind, message: "x", retryable: kind !== "usage_limit" });

  it("suppresses an error/max_turns dead-end once a reply was produced", () => {
    expect(suppressNoticeAfterReply(notice("error"), true)).toBe(true);
    expect(suppressNoticeAfterReply(notice("max_turns"), true)).toBe(true);
  });

  it("does NOT suppress when no reply was produced", () => {
    expect(suppressNoticeAfterReply(notice("error"), false)).toBe(false);
    expect(suppressNoticeAfterReply(notice("max_turns"), false)).toBe(false);
  });

  it("NEVER suppresses a usage_limit — a session-limit stop is real even beside a reply", () => {
    expect(suppressNoticeAfterReply(notice("usage_limit"), true)).toBe(false);
    expect(suppressNoticeAfterReply(notice("usage_limit"), false)).toBe(false);
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
