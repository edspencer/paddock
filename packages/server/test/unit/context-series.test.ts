import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectChatsDir } from "../../src/transcripts.js";
import { readContextSeriesFile, readContextSeries } from "../../src/usage.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Per-message context series (issue #451): each assistant transcript record maps
 * its own `uuid` to that turn's context-window fill (input + cache_read +
 * cache_creation). All records of one assistant message share the same usage, so
 * every record's uuid resolves to the same fill.
 */
function assistant(
  uuid: string,
  msgId: string,
  fill: { input?: number; read?: number; create?: number },
): unknown {
  return {
    type: "assistant",
    uuid,
    message: {
      id: msgId,
      usage: {
        input_tokens: fill.input ?? 0,
        cache_read_input_tokens: fill.read ?? 0,
        cache_creation_input_tokens: fill.create ?? 0,
        output_tokens: 50,
      },
    },
  };
}

describe("per-message context series (issue #451)", () => {
  let projectDir: string;
  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-ctxseries-");
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

  it("keys each assistant record uuid to its context-window fill", async () => {
    const file = await write("s", [
      { type: "user", uuid: "u1", message: { content: "hi" } },
      assistant("a1", "m1", { input: 100, read: 20_000, create: 5_000 }),
      { type: "user", uuid: "u2", message: { content: "more" } },
      assistant("a2", "m2", { input: 200, read: 40_000, create: 8_000 }),
    ]);
    const series = await readContextSeriesFile(file);
    expect(series.get("a1")).toBe(25_100); // 100 + 20000 + 5000
    expect(series.get("a2")).toBe(48_200); // 200 + 40000 + 8000
    // user records carry no usage — absent from the series (callers forward-fill).
    expect(series.has("u1")).toBe(false);
    expect(series.has("u2")).toBe(false);
  });

  it("maps every record of a split assistant message to the same fill", async () => {
    // One assistant message written as several content-block records: same
    // message id + same usage, different uuids.
    const file = await write("s", [
      assistant("blk1", "m1", { input: 10, read: 1_000, create: 500 }),
      assistant("blk2", "m1", { input: 10, read: 1_000, create: 500 }),
      assistant("blk3", "m1", { input: 10, read: 1_000, create: 500 }),
    ]);
    const series = await readContextSeriesFile(file);
    expect(series.get("blk1")).toBe(1_510);
    expect(series.get("blk2")).toBe(1_510);
    expect(series.get("blk3")).toBe(1_510);
  });

  it("returns an empty map for a missing/unsafe session, and reads a real one", async () => {
    await write("good", [assistant("a1", "m1", { input: 1, read: 9, create: 0 })]);
    expect((await readContextSeries(projectDir, "does-not-exist")).size).toBe(0);
    expect((await readContextSeries(projectDir, "../escape")).size).toBe(0);
    const series = await readContextSeries(projectDir, "good");
    expect(series.get("a1")).toBe(10);
  });
});
