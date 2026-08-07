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

/**
 * Max files retained per mtime cache.
 *
 * Was 64, which a real project blows straight through: one live-scale project
 * holds 514 transcript files across 234 chats, so a single sweep of
 * `/chats/usage` evicted every entry before the next sweep could reuse one — the
 * cache was pure overhead. Measured on that corpus (issue #537), raising the cap
 * took the warm full-project usage call from ~440ms to ~29ms.
 *
 * The entries are token tallies and tool-use records, not transcript text, so
 * this is cheap: forcing every one of the 1,515 sessions in that corpus through
 * both the usage and sub-agent-listing paths and then running GC retained
 * **1.4 MB** at this cap versus **1.3 MB** at 64 — a ~0.1 MB difference for a
 * 15× speedup.
 */
export const MTIME_CACHE_MAX = 1024;

export type MtimeCache<T> = Map<string, { mtimeMs: number; value: T }>;

const taskUsesCache: MtimeCache<TaskToolUses> = new Map();
const factsCache: MtimeCache<SubagentTranscriptFacts> = new Map();
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
  /**
   * This sub-agent's own agent id (the `<hex>` of its `agent-<hex>` transcript),
   * and — when it was itself spawned by another sub-agent — that parent sub-agent's
   * agent id (`parentAgentId` in the sidecar; absent for a depth-1 sub-agent whose
   * parent is the main session). Together these form the sub-agent tree used for the
   * recursive per-card cost rollup (see {@link subagentCosts}).
   */
  agentId?: string;
  parentAgentId?: string;
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
   * The sub-agent's estimated API-rate cost in USD (issue #166), as the RECURSIVE
   * total of this sub-agent plus every sub-agent it (transitively) spawned — priced
   * per-model from the merged token usage of its whole subtree (see
   * {@link subagentCosts}). `null` when the entire subtree has no priceable usage;
   * `undefined` for a non-sub-agent tool. Cost only: {@link subagentDurationMs}
   * stays per-agent because nested children run in parallel (overlapping wall-clock),
   * so summing durations would mislead — dollars are additive regardless.
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
   * outside the project dir.
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
  /** Context-window fill (tokens) as of this message — the nearest assistant
   *  turn's `input + cache_read + cache_creation`, forward-filled across the
   *  turns between (issue #451). Drives the per-message hover meter + the
   *  fork/revert-from-here anchor. Absent before the first assistant turn. */
  contextTokens?: number;
  /** A surfaced turn-ending condition (issue #329): a subscription/usage-limit
   *  hit recovered from the transcript on reload. Present only on the synthetic
   *  notice message appended by the history endpoint; the web renders it as a
   *  distinct notice turn instead of an assistant bubble. */
  notice?: TurnNotice;
};

/**
 * Task/Agent launches recovered from one transcript, split by whether the launch
 * has come back yet.
 *
 * They are kept apart because they join to herdctl's parsed messages by DIFFERENT
 * cursors: core emits one message per paired call, plus a `pending:true` message
 * for each still-unpaired launch. Interleaving them in a single list is what used
 * to misalign a completed sub-agent that ran in parallel with a live one.
 */
export interface TaskToolUses {
  /** Launches with a matching tool_result, in file order. */
  paired: TaskToolUse[];
  /** Launches still in flight (no tool_result yet), in file order. */
  pending: TaskToolUse[];
  /** What of this transcript belongs to a sub-agent's own lane — see {@link SidechainLines}. */
  sidechain: SidechainLines;
}

/**
 * The sub-agent-lane content of one transcript (issue #727).
 *
 * A sub-agent's steps belong INSIDE its Task card, served by the subagents
 * endpoint — never as top-level rows of the parent transcript. The live path
 * enforces that in five places via `isSidechainMessage` (`ws-turn.ts`), but the
 * history path had no equivalent: `@herdctl/core`'s parser treats `isSidechain`
 * as a whole-SESSION property (a sidechain gets its own file) and drops the
 * per-line flag from the `ChatMessage` it returns, so any sidechain line written
 * INTO a main transcript is parsed as a first-class message and served by
 * `/messages`. This recovers the markers from the raw transcript, which is the
 * only place they survive.
 *
 * Recovered in the same pass as the Task launches above, so it costs no extra I/O.
 */
export interface SidechainLines {
  /** `uuid` of every sidechain line — the key `ChatMessage.uuid` joins on. */
  uuids: Set<string>;
  /** `tool_use.id` of every Task/Agent launched FROM a sidechain line (a sub-agent
   *  spawning its own sub-agent). Dropped from the parent's join so the file-order
   *  alignment survives losing the sidechain messages. */
  taskIds: Set<string>;
}

/**
 * Stream the main session transcript and recover, in file order, every
 * `Task`/`Agent` tool_use that was **paired** with a tool_result. Pairing is
 * tracked so the returned list aligns 1:1 with herdctl's parsed tool messages
 * for completed calls.
 *
 * Paired-only by design — {@link readTaskUsesFromFile} exposes the in-flight
 * launches separately, and mixing them here would break that alignment.
 */
export async function readTaskToolUses(
  projectDir: string,
  sessionId: string,
): Promise<TaskToolUse[]> {
  return (await readTaskUsesForSession(projectDir, sessionId)).paired;
}

/**
 * Both halves of a session's Task/Agent launches. `sessionId` is a path segment,
 * so it is validated here — every caller reaches the transcript through this.
 */
async function readTaskUsesForSession(
  projectDir: string,
  sessionId: string,
): Promise<TaskToolUses> {
  if (!SAFE_SEGMENT.test(sessionId)) return emptyTaskToolUses();
  return readTaskUsesFromFile(path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`));
}

/**
 * Recover Task/Agent tool_uses (in order, split paired vs in-flight) from an
 * arbitrary transcript file — the main session file, or a sub-agent's own
 * transcript (which lets a sub-agent's nested launches be enriched for recursive
 * expansion).
 */
async function readTaskUsesFromFile(file: string): Promise<TaskToolUses> {
  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(taskUsesCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const value = await readTaskUsesFromFileUncached(file);
  if (mtimeMs !== undefined) mtimeCacheSet(taskUsesCache, file, mtimeMs, value);
  return value;
}

function emptyTaskToolUses(): TaskToolUses {
  return { paired: [], pending: [], sidechain: { uuids: new Set(), taskIds: new Set() } };
}

/**
 * True when a raw transcript LINE was written on a sub-agent's own lane.
 *
 * Two markers, because the writers disagree: Claude Code stamps `isSidechain:
 * true` (plus an `agentId`) on the line, while the SDK message stream — which
 * `isSidechainMessage` in `ws-turn.ts` reads live, and which the test harness
 * mirrors onto disk — carries `parent_tool_use_id`. Either is conclusive.
 *
 * Exported because EVERY file-order join over a main transcript has to agree with
 * {@link dropSidechainMessages} about which lines exist: a scan that keeps a
 * sidechain line while the parsed message list has dropped it shifts the whole
 * join by one (#727).
 */
export function isSidechainLine(parsed: {
  isSidechain?: unknown;
  parent_tool_use_id?: unknown;
  message?: { parent_tool_use_id?: unknown };
}): boolean {
  if (parsed.isSidechain === true) return true;
  return Boolean(parsed.parent_tool_use_id ?? parsed.message?.parent_tool_use_id);
}

async function readTaskUsesFromFileUncached(file: string): Promise<TaskToolUses> {
  const byId = new Map<string, TaskToolUse>();
  const order: string[] = [];
  const resultIds = new Set<string>();
  const sidechain: SidechainLines = { uuids: new Set(), taskIds: new Set() };

  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: {
        uuid?: unknown;
        isSidechain?: unknown;
        parent_tool_use_id?: unknown;
        message?: { content?: unknown; parent_tool_use_id?: unknown };
      };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // A sub-agent's OWN transcript is sidechain top to bottom, so this only ever
      // marks anything on a MAIN session file — which is the only place the
      // distinction means something (issue #727).
      const onSidechain = isSidechainLine(parsed);
      if (onSidechain && typeof parsed.uuid === "string") sidechain.uuids.add(parsed.uuid);
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
          if (onSidechain) sidechain.taskIds.add(b.id);
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
    return emptyTaskToolUses();
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    paired: order.filter((id) => resultIds.has(id)).map((id) => byId.get(id)!),
    pending: order.filter((id) => !resultIds.has(id)).map((id) => byId.get(id)!),
    sidechain,
  };
}

/**
 * Drop a session's sub-agent sidechain steps from its parsed history (issue
 * #727) — the history-path counterpart of the live path's `isSidechainMessage`
 * filter, and the same invariant: a sub-agent's steps render INSIDE its Task
 * card (via the subagents endpoint), never as top-level rows of the parent.
 *
 * Joins on `uuid`, the source line's own id, which `@herdctl/core` preserves on
 * every parsed message (and, for a paired tool message, takes from the
 * originating `tool_use` entry — so a sidechain tool call matches on the same
 * line that made it sidechain). Rides the mtime-cached transcript scan, and
 * short-circuits to the identity for the overwhelmingly common transcript with
 * no sidechain lines at all, so this costs nothing on the normal path.
 *
 * A transcript that is sidechain top to bottom is not a parent with leaked steps
 * — it IS a sub-agent's own session, the shape Claude Code writes as its own
 * `agent-<hex>.jsonl`. herdctl keeps those out of session discovery, but if one
 * is ever reached directly it should render its content, not an empty chat, so
 * a drop that would empty the history is refused.
 */
export async function dropSidechainMessages<T extends ChatMessage>(
  projectDir: string,
  sessionId: string,
  messages: T[],
): Promise<T[]> {
  const { sidechain } = await readTaskUsesForSession(projectDir, sessionId);
  if (sidechain.uuids.size === 0) return messages;
  const kept = messages.filter((m) => !(m.uuid && sidechain.uuids.has(m.uuid)));
  return kept.length === 0 ? messages : kept;
}

/** The same launches minus any a sub-agent made on its own sidechain lane. */
function withoutSidechainLaunches(uses: TaskToolUses): TaskToolUses {
  const { taskIds } = uses.sidechain;
  if (taskIds.size === 0) return uses;
  const keep = (u: TaskToolUse): boolean => !taskIds.has(u.toolUseId);
  return { ...uses, paired: uses.paired.filter(keep), pending: uses.pending.filter(keep) };
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
      parentAgentId?: unknown;
    };
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof meta.toolUseId !== "string") continue;
    // This sub-agent's own id is the `<hex>` of its `agent-<hex>.meta.json` filename
    // (the sidecar records only its PARENT's id, not its own); `parentAgentId` links
    // it to the sub-agent that spawned it. Together they build the tree for the cost
    // rollup. An empty id (a malformed name) is dropped to undefined.
    const agentId = entry.replace(/^agent-/, "").replace(/\.meta\.json$/, "") || undefined;
    out.set(meta.toolUseId, {
      toolUseId: meta.toolUseId,
      agentType: str(meta.agentType),
      description: str(meta.description),
      spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : undefined,
      agentId,
      parentAgentId: str(meta.parentAgentId),
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
  const [rawTaskUses, subagents] = await Promise.all([
    readTaskUsesForSession(projectDir, sessionId),
    listSubagents(projectDir, sessionId),
  ]);
  // The join is by FILE ORDER, so it has to see the same launches the caller's
  // message list does. {@link dropSidechainMessages} has already removed the
  // sidechain rows from that list, so a nested launch a sub-agent made on its own
  // lane must come out of the cursor too — leaving it in would shift every
  // following top-level sub-agent's enrichment onto the wrong card (#727).
  const taskUses = withoutSidechainLaunches(rawTaskUses);
  const [durations, costs] = await Promise.all([
    subagentDurations(subagents),
    subagentCosts(subagents),
  ]);
  return attachSubagentFields(messages, taskUses, subagents, durations, costs);
}

/**
 * How long a sub-agent transcript with no terminal `end_turn` may stay quiet
 * before we stop calling it live (issue #725).
 *
 * A sub-agent that was interrupted — its keeper killed, the box restarted — never
 * writes an `end_turn`, so without this fallback its card would advertise "still
 * running" forever and its duration would never appear. The window has to be
 * comfortably longer than the longest gap a WORKING sub-agent can leave between
 * transcript lines, which is one slow tool call (a full test suite, a long build),
 * not one slow model response. Ten minutes clears that with room to spare, and the
 * `end_turn` check below means the overwhelming majority of finished sub-agents
 * (392 of the 483 real transcripts this was measured against) never wait for it at
 * all — they are recognised as finished the instant their last line lands.
 */
const SUBAGENT_STALE_MS = 10 * 60_000;

/** What one read of a sub-agent transcript tells us. Both facts are mtime-derived,
 *  so both are safe to memoize against the file's mtime; the age comparison that
 *  turns them into a liveness verdict is deliberately NOT cached (it depends on
 *  `now`, not on the file). */
interface SubagentTranscriptFacts {
  /** First→last `timestamp` delta, or undefined with < 2 timestamps. */
  durationMs?: number;
  /** True when the last line is an assistant entry with `stop_reason: "end_turn"` —
   *  a sub-agent's agent loop cannot continue past one, so this is its terminal
   *  marker. (A sub-agent transcript has NO `type: "result"` line: zero of the 483
   *  real ones checked did, so "has a result line" is not a usable signal here.) */
  endsWithEndTurn: boolean;
}

/**
 * Compute each FINISHED sub-agent's run time (ms) from the first→last timestamp
 * in its own transcript. Keyed by toolUseId. Runs once per session on chat open
 * (only over that session's sub-agent files), so the cost is bounded to the open
 * chat.
 *
 * A sub-agent that still looks live is deliberately left OUT of the map (issue
 * #725). `subagentDurationMs` is not merely cosmetic — it is the client's
 * finished signal (`useRunningSubagents` drops any card that carries one) — and
 * it is derived from a transcript that is still growing, so publishing it for a
 * running sub-agent both freezes a bogus part-way number onto the card and
 * evicts it from the running-sub-agents bar for the rest of the run. #622 fixed
 * that for the `pending` branch of {@link attachSubagentFields} by omitting the
 * field; the `paired` branch below it kept stamping one, and because the SDK
 * backgrounds sub-agents, the launching `Task` pairs within milliseconds while
 * the sub-agent keeps working — so a live sub-agent reaches the paired branch as
 * a matter of course. Gating at the source fixes both branches by construction.
 */
async function subagentDurations(
  subagents: Map<string, SubagentMeta>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const now = Date.now();
  await Promise.all(
    [...subagents.values()].map(async (m) => {
      const ms = await readFinishedSubagentDurationMs(m.transcriptPath, now);
      if (ms !== undefined) out.set(m.toolUseId, ms);
    }),
  );
  return out;
}

/**
 * The elapsed wall-clock of a FINISHED sub-agent transcript, or undefined when it
 * is missing, has < 2 timestamps, or still looks live (see {@link SUBAGENT_STALE_MS}).
 */
async function readFinishedSubagentDurationMs(
  file: string,
  now: number,
): Promise<number | undefined> {
  const mtimeMs = await statMtimeMs(file);
  const facts = await readSubagentFacts(file, mtimeMs);
  if (facts.durationMs === undefined) return undefined;
  // No mtime (the file vanished between the stat and the read) ⇒ nothing is
  // writing to it, so fall back to the structural check alone.
  const quietMs = mtimeMs === undefined ? Infinity : now - mtimeMs;
  if (!facts.endsWithEndTurn && quietMs < SUBAGENT_STALE_MS) return undefined;
  return facts.durationMs;
}

async function readSubagentFacts(
  file: string,
  mtimeMs: number | undefined,
): Promise<SubagentTranscriptFacts> {
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(factsCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const value = await readSubagentFactsUncached(file);
  // Cache even the empty result (missing/malformed) so a repeat open of an
  // unchanged, duration-less transcript doesn't re-read the whole file every time.
  if (mtimeMs !== undefined) mtimeCacheSet(factsCache, file, mtimeMs, value);
  return value;
}

async function readSubagentFactsUncached(file: string): Promise<SubagentTranscriptFacts> {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (raw === null) return { endsWithEndTurn: false };
  return { durationMs: transcriptSpanMs(raw), endsWithEndTurn: endsWithEndTurn(raw) };
}

/** First→last `timestamp` delta. Scans for timestamps without a full JSON parse. */
function transcriptSpanMs(raw: string): number | undefined {
  const matches = [...raw.matchAll(/"timestamp":"([^"]+)"/g)];
  if (matches.length < 2) return undefined;
  const first = Date.parse(matches[0][1]);
  const last = Date.parse(matches[matches.length - 1][1]);
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return undefined;
  return last - first;
}

/** True when the transcript's last non-empty line is an assistant entry that
 *  stopped with `end_turn`. Only that line is JSON-parsed. */
function endsWithEndTurn(raw: string): boolean {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        message?: { stop_reason?: unknown };
      };
      return parsed.type === "assistant" && parsed.message?.stop_reason === "end_turn";
    } catch {
      // A torn final line means the writer is mid-append — definitively not settled.
      return false;
    }
  }
  return false;
}

/**
 * Compute each sub-agent's estimated API-rate cost (USD), keyed by toolUseId, as
 * the RECURSIVE total of the sub-agent PLUS every sub-agent it (transitively)
 * spawned. Runs once per session on chat open, over that session's sub-agent files.
 *
 * The sub-agent tree comes from the `.meta.json` sidecars: each carries its
 * `parentAgentId`, and its own agent id is its `agent-<hex>` transcript name (see
 * {@link listSubagents}). For each node we merge the per-model token usage across
 * its whole subtree, then price once ({@link estimateCostUsdByModel}). Merging
 * TOKEN USAGE (rather than summing already-priced dollars) is what keeps an
 * unpriced-model descendant from zeroing out its priced neighbours: the result is
 * `null` only when the entire subtree has no priceable usage (e.g. a leaf that ran
 * on a model with no known pricing and spawned nothing), and a number otherwise.
 *
 * COST ONLY. Duration is deliberately NOT rolled up ({@link subagentDurations}
 * stays per-agent): nested children run in PARALLEL, so their wall-clock overlaps
 * the parent's and each other's — summing durations would badly overstate elapsed
 * time. Dollar cost, by contrast, is additive regardless of concurrency, so a
 * subtree total is meaningful. The chat grand-total
 * ({@link readSessionTokenUsageWithSubagents}) is a SEPARATE value that already
 * flat-sums every sub-agent once (issue #242) — untouched here, and no
 * double-count, since these per-card subtree totals are never summed together.
 */
async function subagentCosts(
  subagents: Map<string, SubagentMeta>,
): Promise<Map<string, number | null>> {
  const metas = [...subagents.values()];
  // 1. Each sub-agent's OWN per-model token usage (parallel, mtime-memoized reads).
  const ownByModel = new Map<string, Record<string, TokenTotals>>();
  await Promise.all(
    metas.map(async (m) => {
      const usage = await readSubagentUsageFile(m.transcriptPath);
      ownByModel.set(m.toolUseId, usage.byModel);
    }),
  );
  // 2. Build the tree: agentId → meta, and parentAgentId → child agentIds. A
  //    depth-1 sub-agent has no parentAgentId (its parent is the main session), so
  //    it's a root; only links to a KNOWN sub-agent id form an edge.
  const metaByAgentId = new Map<string, SubagentMeta>();
  for (const m of metas) if (m.agentId) metaByAgentId.set(m.agentId, m);
  const childrenOf = new Map<string, string[]>();
  for (const m of metas) {
    if (m.agentId && m.parentAgentId && metaByAgentId.has(m.parentAgentId)) {
      const kids = childrenOf.get(m.parentAgentId) ?? [];
      kids.push(m.agentId);
      childrenOf.set(m.parentAgentId, kids);
    }
  }
  // 3. For each node, DFS its subtree (self + all transitive descendants), merging
  //    per-model usage, then price once. `seen` guards against a malformed cyclic link.
  const out = new Map<string, number | null>();
  for (const m of metas) {
    const merged: Record<string, TokenTotals> = {};
    const seen = new Set<string>();
    const visit = (toolUseId: string, agentId?: string): void => {
      mergeByModelInto(merged, ownByModel.get(toolUseId) ?? {});
      if (!agentId) return;
      for (const childId of childrenOf.get(agentId) ?? []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        const child = metaByAgentId.get(childId);
        if (child) visit(child.toolUseId, child.agentId);
      }
    };
    if (m.agentId) seen.add(m.agentId);
    visit(m.toolUseId, m.agentId);
    out.set(m.toolUseId, estimateCostUsdByModel(merged));
  }
  return out;
}

/** Add one per-model usage map into a running accumulator (mirrors the fold in
 *  {@link mergeSubagentUsage}). Used by the recursive cost rollup. */
function mergeByModelInto(
  target: Record<string, TokenTotals>,
  src: Record<string, TokenTotals>,
): void {
  for (const [model, t] of Object.entries(src)) {
    const b = (target[model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    b.inputTokens += t.inputTokens;
    b.outputTokens += t.outputTokens;
    b.cacheReadTokens += t.cacheReadTokens;
    b.cacheCreationTokens += t.cacheCreationTokens;
  }
}

/**
 * Cumulative token usage of a single sub-agent transcript, memoized on its mtime.
 * The shared primitive behind both the per-card cost rollup ({@link subagentCosts})
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
  taskUses: TaskToolUses,
  subagents: Map<string, SubagentMeta>,
  durations: Map<string, number>,
  costs: Map<string, number | null>,
): EnrichedMessage[] {
  let i = 0;
  let p = 0;
  return messages.map((m) => {
    if (!m.toolCall || !SUBAGENT_TOOL_NAMES.has(m.toolCall.toolName)) return m;
    // An in-flight (`pending`) tool_use has no matching tool_result yet, and
    // core@5.24.0 injects it into the parsed stream so it stays visible on
    // rehydration (herdctl#399). It is joined off its OWN cursor against the
    // in-flight launches, never off the paired one — consuming a paired slot here
    // would shift every following completed sub-agent's enrichment onto the wrong
    // call (the parallel case: a running Agent inheriting a finished sibling's
    // `toolUseId`/`hasSubagent` and wrongly rendering as expandable).
    //
    // Enriching it at all is what keeps the running-sub-agents bar alive across a
    // re-mount: the bar's candidates need `toolUseId` + `hasSubagent`, which the
    // live `chat:tool_start` frame supplies but rehydration used to drop — so
    // navigating away from a running chat and back emptied the bar for the rest of
    // the run, with no way to recover short of the sub-agent finishing (#622).
    if (m.toolCall.pending) {
      const use = taskUses.pending[p++];
      if (!use) return m;
      return {
        ...m,
        toolCall: {
          ...m.toolCall,
          toolUseId: use.toolUseId,
          subagentType: use.subagentType,
          description: use.description,
          prompt: use.prompt,
          // Optimistic, exactly as the live path does (see `subagentLaunchFields`):
          // the sidecar may not be on disk for the first moment of the run, and the
          // client's expand/poll paths already degrade to "starting…" until it is.
          hasSubagent: true,
          // Deliberately NO `subagentDurationMs`: it is derived from the first→last
          // timestamp of a transcript that is still growing, so setting it here
          // would both freeze a bogus part-way duration onto the card AND mark the
          // sub-agent finished — `useRunningSubagents` drops any card that has one.
        },
      };
    }
    const use = taskUses.paired[i++];
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
        // Same hazard as the `pending` branch above, and for the same reason:
        // a PAIRED `Task` does NOT mean the sub-agent is done — the SDK
        // backgrounds it, so the tool_result lands in milliseconds while the
        // sub-agent keeps working. `durations` is therefore gated on liveness at
        // its source ({@link subagentDurations}) and holds an entry only for a
        // sub-agent whose transcript has actually settled, so a still-running one
        // gets `undefined` here and keeps its place in the bar (#725).
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
