import { describe, it, expect } from "vitest";
import { extractUsage, pickTurnUsage, type TurnUsage } from "../../src/ws.js";

/** An assistant SDK message carrying a full usage block (with cache fields). */
function assistantMessage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): unknown {
  return { type: "assistant", session_id: "s", message: { model: "opus", usage } };
}

/** A terminal result SDK message; its top-level usage zeroes the cache fields. */
function resultMessage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): unknown {
  return { type: "result", subtype: "success", session_id: "s", usage };
}

/** Reduce a stream of SDK messages the way the ws.ts streaming callback does. */
function captureUsage(messages: unknown[]): TurnUsage | null {
  let seen: TurnUsage | null = null;
  for (const m of messages) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ex = extractUsage(m as any);
    if (ex.usage) seen = pickTurnUsage(seen, ex.usage);
  }
  return seen;
}

const contextOf = (u: TurnUsage) => u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;

describe("live turn usage capture keeps cache tokens (issue #165)", () => {
  it("does not let the cache-less result message clobber the assistant usage", () => {
    // The real-world repro: assistant block has cache tokens, the result block
    // that follows carries input_tokens but ZEROED cache fields.
    const seen = captureUsage([
      assistantMessage({
        input_tokens: 3071,
        output_tokens: 1200,
        cache_read_input_tokens: 16641,
        cache_creation_input_tokens: 1749,
      }),
      resultMessage({
        input_tokens: 3071,
        output_tokens: 1500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ]);

    expect(seen).not.toBeNull();
    // contextTokens must INCLUDE the cache tokens (the bug showed 3071).
    expect(contextOf(seen!)).toBe(21461);
    expect(seen!.cacheReadTokens).toBe(16641);
    expect(seen!.cacheCreationTokens).toBe(1749);
    // outputTokens keeps the largest (final cumulative) value seen.
    expect(seen!.outputTokens).toBe(1500);
  });

  it("still adopts the result block when it is the only usage seen this turn", () => {
    const seen = captureUsage([
      resultMessage({
        input_tokens: 500,
        output_tokens: 40,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ]);
    expect(seen).not.toBeNull();
    expect(contextOf(seen!)).toBe(500);
  });

  it("keeps the higher-context block regardless of message order", () => {
    const assistant: TurnUsage = {
      inputTokens: 3071,
      outputTokens: 1200,
      cacheReadTokens: 16641,
      cacheCreationTokens: 1749,
    };
    const cacheLessResult: TurnUsage = {
      inputTokens: 3071,
      outputTokens: 1500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    // result-before-assistant (defensive: order should not matter)
    const a = pickTurnUsage(cacheLessResult, assistant);
    expect(contextOf(a)).toBe(21461);
    // assistant-before-result (the real order)
    const b = pickTurnUsage(assistant, cacheLessResult);
    expect(contextOf(b)).toBe(21461);
  });
});
