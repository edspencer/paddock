import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectChatsDir } from "../../src/transcripts.js";
import { readSessionTokenUsage, readSessionTokenUsageFile } from "../../src/usage.js";
import { estimateCostUsd, estimateCostUsdByModel } from "../../src/models.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/** An assistant transcript line with a usage block (and optional model). */
function assistant(
  id: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  model?: string,
): unknown {
  return { type: "assistant", message: { id, model, usage } };
}

describe("cumulative session token usage (issue #152)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-usage-");
  });
  afterEach(async () => {
    await rmTmpDir(projectDir);
  });

  async function write(sessionId: string, lines: unknown[]): Promise<string> {
    const dir = projectChatsDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return file;
  }

  it("sums output + input + cache across turns, and tracks last-turn context fill", async () => {
    const file = await write("s1", [
      { type: "user", message: { content: "hi" } },
      assistant("m1", {
        input_tokens: 100,
        output_tokens: 40,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 0,
      }),
      assistant("m2", {
        input_tokens: 50,
        output_tokens: 60,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2000,
      }),
    ]);

    const u = await readSessionTokenUsageFile(file);
    expect(u.hasData).toBe(true);
    expect(u.turnCount).toBe(2);
    // Cumulative across both turns.
    expect(u.inputTotal).toBe(150);
    expect(u.outputTotal).toBe(100);
    expect(u.cacheCreationTotal).toBe(1000);
    expect(u.cacheReadTotal).toBe(2000);
    // Context fill = last turn's input + cacheCreation + cacheRead (50 + 0 + 2000).
    expect(u.contextTokens).toBe(2050);
  });

  it("dedupes repeated message ids (keep-first), like core", async () => {
    const file = await write("s2", [
      assistant("m1", { input_tokens: 10, output_tokens: 5 }),
      // A repeated stream frame for the same message id must not be double-counted.
      assistant("m1", { input_tokens: 10, output_tokens: 5 }),
      assistant("m2", { input_tokens: 20, output_tokens: 7 }),
    ]);
    const u = await readSessionTokenUsageFile(file);
    expect(u.turnCount).toBe(2);
    expect(u.inputTotal).toBe(30);
    expect(u.outputTotal).toBe(12);
  });

  it("returns empty for a missing transcript", async () => {
    const u = await readSessionTokenUsage(projectDir, "does-not-exist");
    expect(u).toEqual({
      hasData: false,
      turnCount: 0,
      contextTokens: 0,
      inputTotal: 0,
      outputTotal: 0,
      cacheReadTotal: 0,
      cacheCreationTotal: 0,
      byModel: {},
    });
  });

  it("buckets token totals by the model each turn ran on", async () => {
    const file = await write("s-multi", [
      assistant("m1", { input_tokens: 100, output_tokens: 40 }, "claude-opus-4-8"),
      assistant("m2", { input_tokens: 50, output_tokens: 60 }, "claude-haiku-4-5-20251001"),
      assistant("m3", { input_tokens: 5, output_tokens: 5 }, "claude-haiku-4-5-20251001"),
    ]);
    const u = await readSessionTokenUsageFile(file);
    // Flat totals stay model-agnostic.
    expect(u.inputTotal).toBe(155);
    expect(u.outputTotal).toBe(105);
    // Per-model split: one Opus turn, two Haiku turns folded together.
    expect(u.byModel["claude-opus-4-8"]).toMatchObject({ inputTokens: 100, outputTokens: 40 });
    expect(u.byModel["claude-haiku-4-5-20251001"]).toMatchObject({
      inputTokens: 55,
      outputTokens: 65,
    });
  });

  it("files turns with no recorded model under the empty-string key", async () => {
    const file = await write("s-nomodel", [assistant("m1", { input_tokens: 10, output_tokens: 5 })]);
    const u = await readSessionTokenUsageFile(file);
    expect(u.byModel[""]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("rejects an unsafe session id (path traversal)", async () => {
    const u = await readSessionTokenUsage(projectDir, "../secret");
    expect(u.hasData).toBe(false);
  });

  it("resolves + memoizes by transcript path", async () => {
    await write("s3", [assistant("m1", { input_tokens: 100, output_tokens: 40 })]);
    const u = await readSessionTokenUsage(projectDir, "s3");
    expect(u.hasData).toBe(true);
    expect(u.inputTotal).toBe(100);
    expect(u.outputTotal).toBe(40);
  });
});

describe("estimateCostUsd (models)", () => {
  it("prices each token class separately at Opus 4.8 rates", () => {
    // Opus 4.8: input $5/1M, output $25/1M; cache-write 1.25×in, cache-read 0.1×in.
    const cost = estimateCostUsd("claude-opus-4-8", {
      inputTokens: 1_000_000, // $5.00
      outputTokens: 1_000_000, // $25.00
      cacheCreationTokens: 1_000_000, // $6.25 (5 × 1.25)
      cacheReadTokens: 1_000_000, // $0.50 (5 × 0.1)
    });
    expect(cost).toBeCloseTo(36.75, 6);
  });

  it("honours a model's own cache-read multiplier (Fable 5.1 reads at 0.025×)", () => {
    // Fable 5.1: input $10/1M, output $50/1M; cache-write 1.25×in = $12.50, but
    // cache-read is 0.025×in = $0.25/1M — a quarter of the standard 0.1× tenth.
    // Cache reads dominate a long chat, so the standard multiplier would bill
    // this 4× over.
    const cost = estimateCostUsd("claude-fable-5-1", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 1_000_000, // $0.25 (10 × 0.025), NOT $1.00
    });
    expect(cost).toBeCloseTo(0.25, 6);

    // Control: Fable 5 has no override, so it stays on the standard tenth.
    expect(
      estimateCostUsd("claude-fable-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(1.0, 6);
  });

  it("honours Opus 5.5's 0.05× cache-read multiplier", () => {
    // Opus 5.5: input $4/1M, output $20/1M; cache-read is 0.05×in = $0.20/1M —
    // half the standard 0.1× tenth. Second model to depart from the shared rate.
    const cost = estimateCostUsd("claude-opus-5-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 1_000_000, // $0.20 (4 × 0.05), NOT $0.40
    });
    expect(cost).toBeCloseTo(0.2, 6);

    // Control: Opus 5 has no override, so it stays on the standard tenth of its
    // own $5 base. Proves the override is per-model, not applied to all Opus.
    expect(
      estimateCostUsd("claude-opus-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.5, 6);
  });

  it("prices Sonnet 5 at the standard $2/$10, not the cancelled $3/$15 rise", () => {
    // Regression guard: we shipped $3/$15 for a price increase that was called
    // off. A full-class estimate catches a partial revert that fixes only one.
    const cost = estimateCostUsd("claude-sonnet-5", {
      inputTokens: 1_000_000, // $2.00
      outputTokens: 1_000_000, // $10.00
      cacheCreationTokens: 1_000_000, // $2.50 (2 × 1.25)
      cacheReadTokens: 1_000_000, // $0.20 (2 × 0.1)
    });
    expect(cost).toBeCloseTo(14.7, 6);
  });

  it("returns null for a model with no known pricing", () => {
    expect(
      estimateCostUsd("some-unknown-model", {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("estimateCostUsdByModel (models)", () => {
  it("prices each model group at its own rate and sums them", () => {
    // Regression for the live bug: a Haiku chat must NOT be billed at Opus rates.
    // Haiku (in $1/1M, out $5/1M): 1M in + 1M out = $1 + $5 = $6.
    const haikuOnly = estimateCostUsdByModel({
      "claude-haiku-4-5-20251001": {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    });
    expect(haikuOnly).toBeCloseTo(6, 6);

    // Mixed chat: Opus 1M in ($5) + Haiku 1M out ($5) = $10.
    const mixed = estimateCostUsdByModel({
      "claude-opus-4-8": {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-haiku-4-5-20251001": {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    });
    expect(mixed).toBeCloseTo(10, 6);
  });

  it("skips unpriced model groups but still returns the priced remainder", () => {
    const cost = estimateCostUsdByModel({
      "claude-haiku-4-5-20251001": {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "": { inputTokens: 500, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });
    expect(cost).toBeCloseTo(1, 6); // only the Haiku $1 counts; "" is unpriced
  });

  it("returns null when no group can be priced", () => {
    expect(
      estimateCostUsdByModel({
        "": { inputTokens: 100, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
    ).toBeNull();
    expect(estimateCostUsdByModel({})).toBeNull();
  });
});
