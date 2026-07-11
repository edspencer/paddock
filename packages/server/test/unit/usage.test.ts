import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectChatsDir } from "../../src/transcripts.js";
import { readSessionTokenUsage, readSessionTokenUsageFile } from "../../src/usage.js";
import { estimateCostUsd } from "../../src/models.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/** An assistant transcript line with a usage block. */
function assistant(
  id: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): unknown {
  return { type: "assistant", message: { id, usage } };
}

describe("cumulative session token usage (issue #NNN)", () => {
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
    });
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
