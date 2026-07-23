/**
 * Sub-agent (Task/Agent tool) transcript reader — issue #37.
 *
 * When a chat agent spawns a sub-agent via the `Task` tool (classic Claude Code)
 * or the `Agent` tool (Agent SDK), the sub-agent runs its own turn whose full
 * step-by-step transcript is written to disk alongside the parent session:
 *
 *   <projectDir>/.chats/<sessionId>/subagents/agent-<hex>.jsonl        // the steps
 *   <projectDir>/.chats/<sessionId>/subagents/agent-<hex>.meta.json    // linking sidecar
 *
 * The `.meta.json` sidecar is the key linking artifact:
 *   { "agentType", "description", "toolUseId", "spawnDepth" }
 * Its `toolUseId` ties the sub-agent transcript back to the parent turn's
 * `Task`/`Agent` tool_use block, so we can render each sub-agent's activity
 * underneath the tool block that launched it.
 *
 * herdctl deliberately filters these `isSidechain` files out of session
 * discovery (they'd clutter the top-level chat list), and its parsed
 * `ChatToolCall` carries neither the tool input nor the `toolUseId`. Rather than
 * change upstream, we read the raw transcript here (paddock already owns the
 * `.chats/` layout via `transcripts.ts`) and reuse core's exported
 * `parseSessionMessages` — the expensive jsonl→messages parsing — on each
 * sub-agent file. Discovery lives here; parsing stays in core.
 */
import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { parseSessionMessages, type ChatMessage, type ChatToolCall } from "@herdctl/core";
import { projectChatsDir } from "./transcripts.js";
import type { MessageSender } from "./message-provenance.js";
import type { TurnNotice } from "./turn-notice.js";
import {
  readSessionTokenUsage,
  readSessionTokenUsageFile,
  type SessionTokenUsage,
} from "./usage.js";
import { estimateCostUsdByModel, type TokenTotals } from "./models.js";

/** Tool names that launch a sub-agent. `Task` = classic Claude Code, `Agent` = Agent SDK. */
export const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

/**
 * A `Task`/`Agent` launch recovered LIVE from a raw SDK message's `tool_use`
 * block (issue #429). `subagentType`/`description` come straight from the tool
 * INPUT the launching assistant message carries — so a consumer can enrich the
 * live tool card with the real sub-agent type + title the instant it starts,
 * WITHOUT waiting for the history-path subagent-join (which only runs on reload).
 */
export interface SubagentLaunch {
  toolUseId: string;
  subagentType?: string;
  description?: string;
}

/**
 * Extract every `Task`/`Agent` `tool_use` block from a single raw SDK message,
 * with `subagent_type` + `description` read directly from the tool input. Returns
 * [] for any message that carries no sub-agent launch (the common case). This is
 * the live counterpart to {@link readTaskToolUses} (which recovers the same fields
 * from the transcript on disk): it lets ws-turn enrich the live `chat:tool_start`
 * / `chat:tool_call` frames as the launch streams, closing the "generic launch-ack
 * live, only enriches on refresh" gap (#429). The message shape is loosely typed
 * in core, so every field access is guarded.
 */
export function extractSubagentLaunches(m: unknown): SubagentLaunch[] {
  const content = (m as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: SubagentLaunch[] = [];
  for (const block of content) {
    const b = block as {
      type?: string;
      name?: string;
      id?: string;
      input?: { subagent_type?: unknown; description?: unknown };
    };
    if (b?.type === "tool_use" && b.name && SUBAGENT_TOOL_NAMES.has(b.name) && typeof b.id === "string") {
      out.push({
        toolUseId: b.id,
        subagentType: str(b.input?.subagent_type),
        description: str(b.input?.description),
      });
    }
  }
  return out;
}

/** Both sessionId and toolUseId are path segments — keep them inside `.chats/`. */
export const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// mtime-keyed memo (issue #147)
//
// Opening a sub-agent-bearing chat used to re-stream the whole main transcript a
// second time (to recover Task/Agent tool_use ids that core's parser drops) and
// read every sub-agent .jsonl in full — on *every* open, including a plain
// refresh of an unchanged chat. Transcripts are immutable except when a new turn
// appends (which bumps mtime), so memoize these per-file reads keyed on the
// file's mtime: a refresh of an unchanged chat now skips both the second parse
// and the sub-agent reads. Mirrors core's mtime caches (herdctl #351).
// ---------------------------------------------------------------------------

/** Max files retained per mtime cache (small structures; bound to cap memory). */
export const MTIME_CACHE_MAX = 64;

export type MtimeCache<T> = Map<string, { mtimeMs: number; value: T }>;

const taskUsesCache: MtimeCache<TaskToolUse[]> = new Map();
const durationCache: MtimeCache<number | undefined> = new Map();
const usageCache: MtimeCache<SessionTokenUsage> = new Map();

/** The file's mtime in epoch ms, or undefined if it can't be stat'd. */
export async function statMtimeMs(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Return the cached value if the recorded mtime still matches (LRU-touch on hit). */
export function mtimeCacheGet<T>(
  cache: MtimeCache<T>,
  file: string,
  mtimeMs: number,
): { hit: true; value: T } | { hit: false } {
  const entry = cache.get(file);
  if (entry && entry.mtimeMs === mtimeMs) {
    cache.delete(file);
    cache.set(file, entry); // re-insert to mark most-recently-used
    return { hit: true, value: entry.value };
  }
  return { hit: false };
}

/** Store a value against the file's mtime, evicting the least-recently-used past the cap. */
export function mtimeCacheSet<T>(cache: MtimeCache<T>, file: string, mtimeMs: number, value: T): void {
  cache.set(file, { mtimeMs, value });
  while (cache.size > MTIME_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** The parent-turn view of a sub-agent launch, recovered from the main transcript. */
export interface TaskToolUse {
  toolUseId: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
}

/** A sub-agent's `.meta.json` sidecar, plus the resolved path to its transcript. */
export interface SubagentMeta {
  toolUseId: string;
  agentType?: string;
  description?: string;
  spawnDepth?: number;
  /** Absolute path to the sibling `agent-<hex>.jsonl`. */
  transcriptPath: string;
}

/**
 * A paddock-enriched tool call: core's `ChatToolCall` plus the sub-agent fields
 * we recover for `Task`/`Agent` blocks. All additive and optional, so non-Task
 * tool calls (and older transcripts) are unaffected.
 */
export type EnrichedToolCall = ChatToolCall & {
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
  /** True when a sub-agent transcript exists on disk for this tool_use. */
  hasSubagent?: boolean;
  /**
   * The sub-agent's actual run time (first→last transcript timestamp), in ms.
   * The tool call's own `durationMs` only measures how long the *launch* took —
   * the Task/Agent tool returns immediately ("launched successfully") while the
   * sub-agent runs on — so this is the meaningful figure to surface.
   */
  subagentDurationMs?: number;
  /**
   * The sub-agent's estimated API-rate cost in USD, priced per-model from its own
   * transcript's cumulative token usage (issue #166). `null` when the sub-agent
   * ran on a model with no known pricing; `undefined` for a non-sub-agent tool.
   * A parent sub-agent's cost does not include its nested children's cost — each
   * sub-agent is priced from only its own transcript (see {@link subagentCosts}).
   */
  subagentCostUsd?: number | null;

  // Background-job / Monitor enrichment (issue #230), attached by `background.ts`.
  // All additive/optional; only present on background-class tool calls read from
  // history. See {@link enrichWithBackground}.
  /** True when this tool ran detached: a `run_in_background` launch, `Monitor`,
   *  or a background-task op (`BashOutput`/`TaskOutput`/`TaskStop`/`KillShell`). */
  background?: boolean;
  /** The background task id, parsed from the launch output (bg `Bash` / `Monitor`). */
  taskId?: string;
  /** Terminal state of the linked task: "completed" | "killed" | "timed out" |
   *  "persistent" | "running". Derived from the matching `<task-notification>`. */
  taskStatus?: string;
  /** The completion `<summary>` folded in from the matching task-notification
   *  (e.g. `Background command "…" completed (exit code 0)`). */
  taskResultSummary?: string;
  /** For `Monitor`: the streamed `<event>` lines, in order, grouped by task id. */
  monitorEvents?: string[];

  // Per-tool detail enrichment (issue #237), attached by `tooldetails.ts` from the
  // raw transcript's `{input, toolUseResult}` sidecar (both dropped by herdctl).
  // All additive/optional; present only on history-hydrated tool calls of the
  // matching type, undefined otherwise (incl. the live path before reload).

  /** Inline diff for an `Edit`/`MultiEdit`/`Write` (issue #232 → #237), now sourced
   *  from `toolUseResult.structuredPatch` (real file line numbers). */
  editDiff?: EditDiff;
  /** File + line-range for a `Read` — drives the `basename · lines a–b of N` header. */
  readInfo?: ReadInfo;
  /** Split stdout/stderr + status affordances for a `Bash` (issue #237). */
  bashDetails?: BashDetails;
  /** Match/file counts for a `Grep`/`Glob` (issue #237). */
  searchInfo?: SearchInfo;
  /** Status transition for a `TaskUpdate` (issue #237). */
  taskUpdate?: TaskUpdateInfo;
  /** Subject/description for a `TaskCreate` (issue #237). */
  taskCreate?: TaskCreateInfo;
};

/**
 * One line of a rendered diff: added (`+`), removed (`-`), or unchanged context,
 * with the real source line numbers recovered from the transcript's git-style
 * hunks (issue #237). `oldLine` is set on context + deletions, `newLine` on
 * context + additions.
 */
export interface DiffLine {
  t: "+" | "-" | " ";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** One git-style hunk with real file offsets (`@@ -oldStart,oldLines +newStart,newLines @@`). */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/**
 * A structured diff for an edit tool call (issue #232 → generalized #237). Sourced
 * from `toolUseResult.structuredPatch` — the git-style hunks Claude Code already
 * computed, with **real file line numbers** — so the hand-rolled LCS diff is gone.
 * `Edit`/`MultiEdit` carry one hunk per changed region; `Write` carries the
 * whole-file create as additions.
 */
export interface EditDiff {
  filePath?: string;
  kind: "edit" | "multiedit" | "write";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True when a hunk was truncated for size; the stats still reflect the full edit. */
  truncated?: boolean;
  /** True when the file changed between the read and the edit (`toolUseResult.userModified`). */
  userModified?: boolean;
}

/** File + line-range recovered for a `Read` (issue #237). */
export interface ReadInfo {
  filePath?: string;
  basename?: string;
  /** 1-based first line returned. */
  startLine?: number;
  /** Number of lines returned. */
  numLines?: number;
  /** Total lines in the file. */
  totalLines?: number;
  /** True when the read target is an image file (by extension) — issue #239. */
  isImage?: boolean;
  /**
   * The read target's path relative to the project dir, set only when it's an
   * image that resolves INSIDE the project dir so the web can render it inline via
   * the raw file endpoint (issue #239). Absent for a non-image read, an image
   * outside the project dir, or a scratch chat (no servable file endpoint).
   */
  projectRelPath?: string;
}

/** Split output + status affordances recovered for a `Bash` (issue #237). */
export interface BashDetails {
  /** Present (with `stderr`) only when there IS stderr to split out; else undefined
   *  and the generic merged `output` renders. */
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  /** Human-readable exit hint, e.g. "No matches found". */
  returnCodeInterpretation?: string;
  /** Short git affordance from `gitOperation`, e.g. "push → main". */
  gitHint?: string;
}

/** Match/file counts recovered for a `Grep`/`Glob` (issue #237). */
export interface SearchInfo {
  kind: "grep" | "glob";
  numFiles?: number;
  /** Grep content-mode: number of matching lines. */
  numLines?: number;
  /** Glob: total matches found (may exceed the returned/`truncated` set). */
  totalMatches?: number;
  truncated?: boolean;
}

/** Status transition recovered for a `TaskUpdate` (issue #237). */
export interface TaskUpdateInfo {
  taskId?: string;
  updatedFields?: string[];
  from?: string;
  to?: string;
}

/** Subject/description recovered for a `TaskCreate` (issue #237). */
export interface TaskCreateInfo {
  taskId?: string;
  subject?: string;
  description?: string;
}

export type EnrichedMessage = Omit<ChatMessage, "toolCall"> & {
  toolCall?: EnrichedToolCall;
  /** True when this `<task-notification>` was folded into a background tool block
   *  (issue #230), so the web suppresses the standalone status pill. */
  bgConsumed?: boolean;
  /** Who injected this machine-added turn (issue #290); absent ⇒ human-typed. */
  sender?: MessageSender;
  /** A surfaced turn-ending condition (issue #329): a subscription/usage-limit
   *  hit recovered from the transcript on reload. Present only on the synthetic
   *  notice message appended by the history endpoint; the web renders it as a
   *  distinct notice turn instead of an assistant bubble. */
  notice?: TurnNotice;
};

/**
 * Stream the main session transcript and recover, in file order, every
 * `Task`/`Agent` tool_use that was **paired** with a tool_result. Pairing is
 * tracked so the returned list aligns 1:1 with herdctl's parsed tool messages
 * (which only exist for paired calls): an in-flight/unpaired launch at the tail
 * is simply omitted until the turn completes, keeping the positional join exact.
 */
export async function readTaskToolUses(
  projectDir: string,
  sessionId: string,
): Promise<TaskToolUse[]> {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  return readTaskUsesFromFile(path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`));
}

/**
 * Recover paired Task/Agent tool_uses (in order) from an arbitrary transcript
 * file — the main session file, or a sub-agent's own transcript (which lets a
 * sub-agent's nested launches be enriched for recursive expansion).
 */
async function readTaskUsesFromFile(file: string): Promise<TaskToolUse[]> {
  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(taskUsesCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const value = await readTaskUsesFromFileUncached(file);
  if (mtimeMs !== undefined) mtimeCacheSet(taskUsesCache, file, mtimeMs, value);
  return value;
}

async function readTaskUsesFromFileUncached(file: string): Promise<TaskToolUse[]> {
  const byId = new Map<string, TaskToolUse>();
  const order: string[] = [];
  const resultIds = new Set<string>();

  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: { message?: { content?: unknown } };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const content = parsed.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as {
          type?: string;
          name?: string;
          id?: string;
          tool_use_id?: string;
          input?: { subagent_type?: unknown; description?: unknown; prompt?: unknown };
        };
        if (b?.type === "tool_use" && b.name && SUBAGENT_TOOL_NAMES.has(b.name) && b.id) {
          if (!byId.has(b.id)) {
            order.push(b.id);
            byId.set(b.id, {
              toolUseId: b.id,
              subagentType: str(b.input?.subagent_type),
              description: str(b.input?.description),
              prompt: str(b.input?.prompt),
            });
          }
        } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          resultIds.add(b.tool_use_id);
        }
      }
    }
  } catch {
    return [];
  } finally {
    rl.close();
    stream.destroy();
  }

  return order.filter((id) => resultIds.has(id)).map((id) => byId.get(id)!);
}

/**
 * Live sub-agent enrichment for a tool frame (issue #429). When the tool is a
 * `Task`/`Agent` launch this turn already recovered (via {@link extractSubagentLaunches}),
 * return the real sub-agent type + title plus `hasSubagent: true`, so the client
 * renders the enriched, expandable card the moment the launch streams — instead of
 * the generic "Agent · <ms>" launch-ack that only filled in on refresh. A safe
 * spread for any non-sub-agent tool (returns an empty object). `hasSubagent` is set
 * optimistically: a `Task`/`Agent` launch is expected to write a sub-agent
 * transcript, and the client's expand path degrades gracefully (a "waiting…"
 * placeholder) until the sidecar appears on disk.
 */
export function subagentLaunchFields(
  launches: Map<string, SubagentLaunch>,
  toolName: string,
  toolUseId: string | undefined,
): { subagentType?: string; description?: string; hasSubagent?: boolean } {
  if (!toolUseId || !SUBAGENT_TOOL_NAMES.has(toolName)) return {};
  const l = launches.get(toolUseId);
  return { subagentType: l?.subagentType, description: l?.description, hasSubagent: true };
}

/**
 * Read the `subagents/*.meta.json` sidecars for a session, keyed by `toolUseId`.
 * Returns an empty map when the session has no sub-agents (the common case) or
 * the directory is missing/unreadable.
 */
export async function listSubagents(
  projectDir: string,
  sessionId: string,
): Promise<Map<string, SubagentMeta>> {
  const out = new Map<string, SubagentMeta>();
  if (!SAFE_SEGMENT.test(sessionId)) return out;
  const dir = path.join(projectChatsDir(projectDir), sessionId, "subagents");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".meta.json")) continue;
    const raw = await fs.readFile(path.join(dir, entry), "utf8").catch(() => null);
    if (raw === null) continue;
    let meta: {
      toolUseId?: unknown;
      agentType?: unknown;
      description?: unknown;
      spawnDepth?: unknown;
    };
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof meta.toolUseId !== "string") continue;
    out.set(meta.toolUseId, {
      toolUseId: meta.toolUseId,
      agentType: str(meta.agentType),
      description: str(meta.description),
      spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : undefined,
      // The transcript is the sidecar's sibling: agent-<hex>.meta.json → agent-<hex>.jsonl
      transcriptPath: path.join(dir, entry.replace(/\.meta\.json$/, ".jsonl")),
    });
  }
  return out;
}

/**
 * Parse a single sub-agent's transcript into messages, reusing core's parser.
 * Returns [] when the `toolUseId` doesn't correspond to a known sub-agent or the
 * transcript is missing. Both segments are validated to stay inside `.chats/`.
 */
export async function readSubagentMessages(
  projectDir: string,
  sessionId: string,
  toolUseId: string,
): Promise<EnrichedMessage[]> {
  if (!SAFE_SEGMENT.test(sessionId) || !SAFE_SEGMENT.test(toolUseId)) return [];
  const subagents = await listSubagents(projectDir, sessionId);
  const meta = subagents.get(toolUseId);
  if (!meta) return [];
  const messages = await parseSessionMessages(meta.transcriptPath).catch(
    () => [] as ChatMessage[],
  );
  if (!hasSubagentTool(messages)) return messages;
  // A sub-agent may itself spawn sub-agents (spawnDepth > 1). Their sidecars are
  // flat in the SAME session's subagents/ dir, so enriching this transcript's own
  // Task/Agent blocks against `subagents` lets the UI expand them recursively.
  const taskUses = await readTaskUsesFromFile(meta.transcriptPath);
  const [durations, costs] = await Promise.all([
    subagentDurations(subagents),
    subagentCosts(subagents),
  ]);
  return attachSubagentFields(messages, taskUses, subagents, durations, costs);
}

/**
 * Enrich a session's parsed messages: attach the recovered sub-agent fields
 * (`toolUseId`, `subagentType`, `description`, `prompt`, `hasSubagent`) to every
 * `Task`/`Agent` tool message, joining by file order. Non-Task tool calls and
 * sessions without sub-agents pass through unchanged (a cheap early return).
 */
export async function enrichWithSubagents(
  projectDir: string,
  sessionId: string,
  messages: ChatMessage[],
): Promise<EnrichedMessage[]> {
  if (!hasSubagentTool(messages)) return messages;
  const [taskUses, subagents] = await Promise.all([
    readTaskToolUses(projectDir, sessionId),
    listSubagents(projectDir, sessionId),
  ]);
  const [durations, costs] = await Promise.all([
    subagentDurations(subagents),
    subagentCosts(subagents),
  ]);
  return attachSubagentFields(messages, taskUses, subagents, durations, costs);
}

/**
 * Compute each sub-agent's run time (ms) from the first→last timestamp in its
 * own transcript. Keyed by toolUseId. Runs once per session on chat open (only
 * over that session's sub-agent files), so the cost is bounded to the open chat.
 */
async function subagentDurations(
  subagents: Map<string, SubagentMeta>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    [...subagents.values()].map(async (m) => {
      const ms = await readSubagentDurationMs(m.transcriptPath);
      if (ms !== undefined) out.set(m.toolUseId, ms);
    }),
  );
  return out;
}

/**
 * The elapsed wall-clock of a sub-agent transcript: the delta between its first
 * and last `timestamp`. Scans for timestamps without a full JSON parse; returns
 * undefined if the file is missing or has < 2 timestamps.
 */
async function readSubagentDurationMs(file: string): Promise<number | undefined> {
  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(durationCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const value = await readSubagentDurationMsUncached(file);
  // Cache even undefined (missing/malformed) so a repeat open of an unchanged,
  // duration-less transcript doesn't re-read the whole file every time.
  if (mtimeMs !== undefined) mtimeCacheSet(durationCache, file, mtimeMs, value);
  return value;
}

async function readSubagentDurationMsUncached(file: string): Promise<number | undefined> {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (raw === null) return undefined;
  const matches = [...raw.matchAll(/"timestamp":"([^"]+)"/g)];
  if (matches.length < 2) return undefined;
  const first = Date.parse(matches[0][1]);
  const last = Date.parse(matches[matches.length - 1][1]);
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return undefined;
  return last - first;
}

/**
 * Compute each sub-agent's estimated API-rate cost (USD) from its own transcript,
 * keyed by toolUseId. Reuses the same primitives as the per-chat cost: accumulate
 * per-model token usage over the sub-agent transcript ({@link readSessionTokenUsageFile})
 * then price it per-model ({@link estimateCostUsdByModel}). Like durations, this
 * runs once per session on chat open and only over that session's sub-agent files.
 *
 * A parent sub-agent's cost reflects only its own transcript's usage — nested
 * children run in their own sibling transcripts, so their cost is priced under
 * their own tool_use ids, not folded into the parent (acceptable first cut).
 */
async function subagentCosts(
  subagents: Map<string, SubagentMeta>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  await Promise.all(
    [...subagents.values()].map(async (m) => {
      out.set(m.toolUseId, await readSubagentCostUsd(m.transcriptPath));
    }),
  );
  return out;
}

/**
 * Cumulative token usage of a single sub-agent transcript, memoized on its mtime.
 * The shared primitive behind both the per-block cost ({@link readSubagentCostUsd})
 * and the chat-total roll-up ({@link readSessionTokenUsageWithSubagents}), so a
 * chat open parses each sub-agent file at most once.
 */
async function readSubagentUsageFile(file: string): Promise<SessionTokenUsage> {
  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(usageCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const usage = await readSessionTokenUsageFile(file);
  if (mtimeMs !== undefined) mtimeCacheSet(usageCache, file, mtimeMs, usage);
  return usage;
}

/** The estimated cost of a sub-agent transcript, priced per-model from its usage. */
async function readSubagentCostUsd(file: string): Promise<number | null> {
  const usage = await readSubagentUsageFile(file);
  return estimateCostUsdByModel(usage.byModel);
}

/**
 * A chat's cumulative token usage *including every sub-agent it spawned* (issue
 * #242).
 *
 * The per-chat cost/token headline (issue #152) originally priced only the main
 * transcript, but a chat's `Task`/`Agent` sub-agents run in their own sibling
 * transcripts (`.chats/<sessionId>/subagents/agent-*.jsonl`) — so a chat that
 * fanned work out to sub-agents under-reported its true spend, sometimes by ~90%.
 * This folds those transcripts back in: the four token totals and the per-model
 * buckets gain every sub-agent's usage, so both the token figure and the
 * per-model-priced dollar estimate reflect the whole chat.
 *
 * `contextTokens` and `turnCount` stay main-only: those describe the parent's
 * last-turn context-window fill (what the ContextMeter shows), a distinct concept
 * from lifetime spend — each sub-agent has its own, separate context window.
 *
 * No double-counting: herdctl writes sub-agent (`isSidechain`) turns to the
 * sibling files, never into the main transcript, so `main + sub-agents` is a
 * clean sum. Nested sub-agents (spawnDepth > 1) sit flat in the same `subagents/`
 * dir, so their usage is included too. Returns the main usage unchanged when the
 * chat spawned no sub-agents (the common case — a cheap early return).
 */
export async function readSessionTokenUsageWithSubagents(
  projectDir: string,
  sessionId: string,
): Promise<SessionTokenUsage> {
  const main = await readSessionTokenUsage(projectDir, sessionId);
  if (!SAFE_SEGMENT.test(sessionId)) return main;
  const dir = path.join(projectChatsDir(projectDir), sessionId, "subagents");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const files = entries.filter((e) => e.endsWith(".jsonl"));
  if (files.length === 0) return main;
  const subUsages = await Promise.all(
    files.map((f) => readSubagentUsageFile(path.join(dir, f))),
  );
  return mergeSubagentUsage(main, subUsages);
}

/**
 * Fold sub-agent usages into a *copy* of the main usage. Builds fresh token
 * buckets rather than mutating `main.byModel` / the sub-agents' cached objects —
 * both come straight out of mtime caches and must stay pristine. Pricing stays
 * per-model (buckets keyed by `message.model`), so a sub-agent that ran on a
 * different, pricier model than the parent is costed at its own rate.
 */
function mergeSubagentUsage(
  main: SessionTokenUsage,
  subs: SessionTokenUsage[],
): SessionTokenUsage {
  const byModel: Record<string, TokenTotals> = {};
  const add = (model: string, t: TokenTotals) => {
    const b = (byModel[model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    b.inputTokens += t.inputTokens;
    b.outputTokens += t.outputTokens;
    b.cacheReadTokens += t.cacheReadTokens;
    b.cacheCreationTokens += t.cacheCreationTokens;
  };
  for (const [model, t] of Object.entries(main.byModel)) add(model, t);

  let { hasData, inputTotal, outputTotal, cacheReadTotal, cacheCreationTotal } = main;
  for (const s of subs) {
    if (!s.hasData) continue;
    hasData = true;
    inputTotal += s.inputTotal;
    outputTotal += s.outputTotal;
    cacheReadTotal += s.cacheReadTotal;
    cacheCreationTotal += s.cacheCreationTotal;
    for (const [model, t] of Object.entries(s.byModel)) add(model, t);
  }

  return {
    hasData,
    turnCount: main.turnCount,
    contextTokens: main.contextTokens,
    inputTotal,
    outputTotal,
    cacheReadTotal,
    cacheCreationTotal,
    byModel,
  };
}

/** True when any message is a Task/Agent tool call worth enriching. */
function hasSubagentTool(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.toolCall && SUBAGENT_TOOL_NAMES.has(m.toolCall.toolName));
}

/**
 * Attach recovered sub-agent fields to each Task/Agent tool message by joining
 * against `taskUses` in file order (both are file-ordered; only paired uses are
 * present, so the join stays aligned). Other messages pass through untouched.
 */
function attachSubagentFields(
  messages: ChatMessage[],
  taskUses: TaskToolUse[],
  subagents: Map<string, SubagentMeta>,
  durations: Map<string, number>,
  costs: Map<string, number | null>,
): EnrichedMessage[] {
  let i = 0;
  return messages.map((m) => {
    if (!m.toolCall || !SUBAGENT_TOOL_NAMES.has(m.toolCall.toolName)) return m;
    // An in-flight (`pending`) tool_use has no matching tool_result, so
    // `readTaskToolUses` (paired-only) omits it — core@5.24.0 nonetheless injects
    // the unpaired pending message into the parsed stream so it's visible on
    // rehydration (herdctl#399). Skip it here so it does NOT consume a `taskUses`
    // slot and shift every following completed sub-agent's enrichment onto the
    // wrong call (the parallel-sub-agent case: a still-running Agent would else
    // inherit a finished sibling's `hasSubagent`/`toolUseId` and wrongly render as
    // expandable). It falls through unenriched → the generic running sub-agent box,
    // matching the live `chat:tool_start` path.
    if (m.toolCall.pending) return m;
    const use = taskUses[i++];
    if (!use) return m;
    return {
      ...m,
      toolCall: {
        ...m.toolCall,
        toolUseId: use.toolUseId,
        subagentType: use.subagentType,
        description: use.description,
        prompt: use.prompt,
        hasSubagent: subagents.has(use.toolUseId),
        subagentDurationMs: durations.get(use.toolUseId),
        subagentCostUsd: costs.get(use.toolUseId),
      },
    };
  });
}

/** Coerce a JSON value to a trimmed non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}
