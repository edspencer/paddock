/**
 * Cumulative per-chat token usage — issue #152.
 *
 * `@herdctl/core`'s `extractSessionUsage` streams a transcript but keeps only the
 * *last* assistant turn's `input + cache_read + cache_creation` — the current
 * context-window fill level that drives the ContextRing / ContextMeter. It
 * deliberately overwrites (`=`) each turn and never reads `output_tokens`, so it
 * can't answer "how many tokens did this whole chat consume?".
 *
 * This module reads the same transcript in one pass and *accumulates* (`+=`)
 * every assistant turn's input, output, cache-read and cache-creation tokens, so
 * a chat's lifetime token cost (and a ballpark dollar figure at API rates) can be
 * shown alongside the context-fill gauge. It lives in paddock — not upstream —
 * because paddock already owns the `.chats/` layout and reads these transcripts
 * directly (see {@link ./transcripts.ts} and {@link ./subagents.ts}); the core
 * `SessionUsage` shape and its consumers are left untouched.
 *
 * Correctness notes:
 *  - Dedupe by `message.id` exactly like core: streaming writes the same message
 *    id more than once, and both the cumulative sums and the last-turn fill count
 *    each assistant message at most once (keep-first, matching core).
 *  - The last-turn `contextTokens` is tracked in the same pass so callers get the
 *    context-fill number without a second core call.
 */
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { projectChatsDir } from "./transcripts.js";
import type { TokenTotals } from "./models.js";

/** sessionId is a path segment — keep it inside `.chats/`. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A chat's context fill (last turn) plus its cumulative lifetime token totals. */
export interface SessionTokenUsage {
  /** True once at least one assistant turn carried a usage block. */
  hasData: boolean;
  /** Number of assistant turns (unique message ids) with usage. */
  turnCount: number;
  /**
   * Context-window fill as of the last completed turn:
   * `input + cache_read + cache_creation` of the final assistant message. This
   * matches core's `SessionUsage.inputTokens` so the ring/meter math is unchanged.
   */
  contextTokens: number;
  /** Cumulative uncached input tokens across every turn. */
  inputTotal: number;
  /** Cumulative output tokens across every turn. */
  outputTotal: number;
  /** Cumulative cache-read input tokens across every turn. */
  cacheReadTotal: number;
  /** Cumulative cache-creation (write) input tokens across every turn. */
  cacheCreationTotal: number;
  /**
   * The same token totals split by the model that produced them (keyed by the
   * `message.model` on each assistant turn). A chat can span models — the
   * composer switches model per turn, and the running model may differ from the
   * project default — so cost must be priced per-model, not at one blended rate.
   * The flat `*Total` fields above stay model-agnostic for the token headline.
   */
  byModel: Record<string, TokenTotals>;
}

const EMPTY: SessionTokenUsage = {
  hasData: false,
  turnCount: 0,
  contextTokens: 0,
  inputTotal: 0,
  outputTotal: 0,
  cacheReadTotal: 0,
  cacheCreationTotal: 0,
  byModel: {},
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Stream a transcript file and accumulate cumulative token usage. Deduplicates
 * assistant messages by `message.id` (keep-first) so repeated stream frames for
 * one message are counted once. Returns {@link EMPTY} for a missing/unreadable
 * file (parity with core, which returns a zeroed summary).
 */
export async function readSessionTokenUsageFile(file: string): Promise<SessionTokenUsage> {
  const seenIds = new Set<string>();
  let hasData = false;
  let contextTokens = 0;
  let inputTotal = 0;
  let outputTotal = 0;
  let cacheReadTotal = 0;
  let cacheCreationTotal = 0;
  const byModel: Record<string, TokenTotals> = {};

  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: {
        type?: string;
        message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
      };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed.type !== "assistant") continue;
      const message = parsed.message;
      if (!message) continue;
      // Deduplicate by message id (keep-first), exactly like core.
      const id = typeof message.id === "string" ? message.id : undefined;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      const usage = message.usage;
      if (!usage) continue;
      hasData = true;
      const input = num(usage.input_tokens);
      const output = num(usage.output_tokens);
      const cacheCreation = num(usage.cache_creation_input_tokens);
      const cacheRead = num(usage.cache_read_input_tokens);
      inputTotal += input;
      outputTotal += output;
      cacheCreationTotal += cacheCreation;
      cacheReadTotal += cacheRead;
      // Bucket the same tokens under the model that produced them, so cost is
      // priced per-model rather than at one blended rate. Turns with no recorded
      // model land under "" and are treated as unpriced downstream.
      const model = typeof message.model === "string" ? message.model : "";
      const bucket = (byModel[model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      bucket.inputTokens += input;
      bucket.outputTokens += output;
      bucket.cacheReadTokens += cacheRead;
      bucket.cacheCreationTokens += cacheCreation;
      // Context fill of this turn — the last one to run wins (matches core).
      contextTokens = input + cacheCreation + cacheRead;
    }
  } catch {
    return EMPTY;
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    hasData,
    turnCount: seenIds.size,
    contextTokens,
    inputTotal,
    outputTotal,
    cacheReadTotal,
    cacheCreationTotal,
    byModel,
  };
}

/**
 * mtime-keyed cache of cumulative usage, keyed by transcript path. A session's
 * totals only change when its transcript grows (and its mtime bumps), so the
 * chat-list build (which needs every session's usage for its rings) skips
 * re-scanning unchanged transcripts. A `stat` is negligible next to a full-file
 * walk, so we always derive the stamp here — one consistent mtime source across
 * both the bulk and single-chat endpoints. One entry per file; a fresh mtime
 * overwrites the stale one.
 */
const cache = new Map<string, { mtime: number; usage: SessionTokenUsage }>();

/**
 * Cumulative token usage for a chat, resolved from `<projectDir>/.chats/`.
 * Memoized on the transcript's mtime. Returns {@link EMPTY} for an unsafe
 * session id or a session with no transcript yet.
 */
export async function readSessionTokenUsage(
  projectDir: string,
  sessionId: string,
): Promise<SessionTokenUsage> {
  if (!SAFE_SEGMENT.test(sessionId)) return EMPTY;
  const file = path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`);
  const mtime = await fs
    .stat(file)
    .then((s) => s.mtimeMs)
    .catch(() => 0);
  if (!mtime) return EMPTY;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.usage;
  const usage = await readSessionTokenUsageFile(file);
  cache.set(file, { mtime, usage });
  return usage;
}

/**
 * Per-message context-window fill, keyed by the transcript record `uuid` that the
 * messages DTO carries (issue #451). For every `type:"assistant"` record we store
 * `input + cache_read + cache_creation` — the context-window fill at that turn.
 *
 * A single assistant message is written across several JSONL records (one per
 * content block: text, tool_use, …), each with its own `uuid` but the SAME
 * message-level `usage`, so keying by record `uuid` resolves any of a message's
 * turn ids to the identical fill. Callers forward-fill the value across the
 * non-assistant records between turns (user prompts, tool results) to answer
 * "how full was the context as of this point" for every message.
 *
 * This is a SEPARATE pass from {@link readSessionTokenUsageFile} on purpose: it
 * only runs on the open-chat messages path, never the chat-list rings, so the
 * list DTO stays lean. It rides its own mtime cache below.
 */
export async function readContextSeriesFile(file: string): Promise<Map<string, number>> {
  const series = new Map<string, number>();
  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: {
        type?: string;
        uuid?: unknown;
        message?: { usage?: Record<string, unknown> };
      };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed.type !== "assistant") continue;
      const uuid = typeof parsed.uuid === "string" ? parsed.uuid : undefined;
      const usage = parsed.message?.usage;
      if (!uuid || !usage) continue;
      series.set(
        uuid,
        num(usage.input_tokens) +
          num(usage.cache_creation_input_tokens) +
          num(usage.cache_read_input_tokens),
      );
    }
  } catch {
    return series;
  } finally {
    rl.close();
    stream.destroy();
  }
  return series;
}

/** mtime-keyed cache of the per-message context series (see {@link readContextSeriesFile}). */
const seriesCache = new Map<string, { mtime: number; series: Map<string, number> }>();

/**
 * Per-message context series for a chat, resolved from `<projectDir>/.chats/`.
 * Memoized on the transcript's mtime (parity with {@link readSessionTokenUsage}).
 * Returns an empty map for an unsafe session id or a session with no transcript.
 */
export async function readContextSeries(
  projectDir: string,
  sessionId: string,
): Promise<Map<string, number>> {
  if (!SAFE_SEGMENT.test(sessionId)) return new Map();
  const file = path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`);
  const mtime = await fs
    .stat(file)
    .then((s) => s.mtimeMs)
    .catch(() => 0);
  if (!mtime) return new Map();
  const hit = seriesCache.get(file);
  if (hit && hit.mtime === mtime) return hit.series;
  const series = await readContextSeriesFile(file);
  seriesCache.set(file, { mtime, series });
  return series;
}
