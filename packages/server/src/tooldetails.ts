/**
 * Unified tool-call detail enrichment — issue #237.
 *
 * herdctl's parsed `ChatToolCall` surfaces only `{toolName, inputSummary, output,
 * isError, durationMs}` and discards two rich sources present on ~100% of tool
 * calls in the raw Claude Code transcript:
 *
 *   1. the tool's full `input` (raw args), and
 *   2. a structured `toolUseResult` sidecar written as a **top-level field** on the
 *      `tool_result` line (Edit `structuredPatch`, Read `file`, Bash stdout/stderr,
 *      Grep/Glob counts, Task* transitions, …).
 *
 * We'd recovered raw transcript data three times in one-off modules — `subagents.ts`
 * (#37: Task input), `background.ts` (#230: task-notification correlation),
 * `editdiff.ts` (#232: Edit diff). This module **generalizes that recovery into one
 * shared pass**: a single mtime-cached raw-JSONL stream recovers `{input,
 * toolUseResult}` for every paired tool_use and **positionally joins** it onto
 * herdctl's parsed tool messages (same paired-only, file-ordered invariant
 * `attachSubagentFields`/`enrichWithEdits` rely on; defensive `toolName` check).
 *
 * Recovery is generic; per-tool structured fields are derived here and rendered by
 * a small set of gated branches in `ToolBlock`. No herdctl change. History-hydrated
 * only (the live WS frame carries none of this) — enrichment applies on reload,
 * consistent with #230/#232, and any tool without the sidecar degrades to the
 * generic block.
 *
 * `enrichWithToolDetails` is the single orchestrator the history routes call: it
 * composes `enrichWithSubagents` (sub-agent sidecars — a separate concern) → this
 * pass → `enrichWithBackground` (task-notification folding).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { projectChatsDir } from "./transcripts.js";
import { fileKind } from "./projects.js";
import { enrichWithSubagents } from "./subagents.js";
import { enrichWithBackground } from "./background.js";
import { enrichWithLocalCommands } from "./localcommand.js";
import {
  SAFE_SEGMENT,
  statMtimeMs,
  mtimeCacheGet,
  mtimeCacheSet,
  type MtimeCache,
  type EnrichedMessage,
  type EnrichedToolCall,
  type EditDiff,
  type DiffLine,
  type DiffHunk,
  type ReadInfo,
  type BashDetails,
  type SearchInfo,
  type TaskUpdateInfo,
  type TaskCreateInfo,
} from "./subagents.js";

/** Tool names we derive structured detail for. Others still consume a join slot
 *  (so positional alignment holds) but carry no extra fields. */
const EDIT_TOOL_NAMES = new Set(["Edit", "MultiEdit", "Write"]);
const DETAIL_TOOL_NAMES = new Set([
  ...EDIT_TOOL_NAMES,
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "TaskUpdate",
  "TaskCreate",
]);

/** Cap rendered diff lines per edit tool call (stats stay exact; `truncated` flags it). */
const MAX_DIFF_LINES = 400;

/** The structured fields we derive for one paired tool_use, keyed for the join. */
interface ToolDetail {
  toolName: string;
  editDiff?: EditDiff;
  readInfo?: ReadInfo;
  bashDetails?: BashDetails;
  searchInfo?: SearchInfo;
  taskUpdate?: TaskUpdateInfo;
  taskCreate?: TaskCreateInfo;
}

const detailsCache: MtimeCache<ToolDetail[]> = new Map();

// --- small coercers -------------------------------------------------------

/** Coerce to a trimmed non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v;
  return t.length ? t : undefined;
}
/** Coerce a string|number id to a string, else undefined. */
function id(v: unknown): string | undefined {
  if (typeof v === "string" && v.length) return v;
  if (typeof v === "number") return String(v);
  return undefined;
}
/** Coerce to a finite number, else undefined. */
function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/** Coerce to a finite number, else 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;

// --- per-tool derivation --------------------------------------------------

/**
 * Build the structured diff from `toolUseResult.structuredPatch` — the git-style
 * hunks Claude Code already computed, with real file line numbers. Deletions carry
 * an `oldLine`, additions a `newLine`, context both. Stats count all lines; a
 * global render budget caps line count (`truncated`).
 */
function editDiffFromResult(toolName: string, input: Rec, result: Rec | undefined): EditDiff | undefined {
  const patch = result?.structuredPatch;
  if (!Array.isArray(patch)) return undefined;
  const filePath = str(input.file_path) ?? str(result?.filePath);
  const kind: EditDiff["kind"] =
    toolName === "Write" ? "write" : toolName === "MultiEdit" ? "multiedit" : "edit";

  let additions = 0;
  let deletions = 0;
  let budget = MAX_DIFF_LINES;
  let truncated = false;
  const hunks: DiffHunk[] = [];

  for (const rawHunk of patch) {
    const h = asRec(rawHunk);
    if (!h) continue;
    const oldStart = num(h.oldStart);
    const newStart = num(h.newStart);
    let oldNo = oldStart;
    let newNo = newStart;
    const lines: DiffLine[] = [];
    const rawLines = Array.isArray(h.lines) ? h.lines : [];
    for (const ln of rawLines) {
      if (typeof ln !== "string") continue;
      const marker = ln[0];
      const text = ln.slice(1);
      if (marker === "+") {
        additions++;
        if (budget > 0) {
          lines.push({ t: "+", text, newLine: newNo });
          budget--;
        } else truncated = true;
        newNo++;
      } else if (marker === "-") {
        deletions++;
        if (budget > 0) {
          lines.push({ t: "-", text, oldLine: oldNo });
          budget--;
        } else truncated = true;
        oldNo++;
      } else if (marker === "\\") {
        // "\ No newline at end of file" — a jsdiff meta line, not real content.
        continue;
      } else {
        if (budget > 0) {
          lines.push({ t: " ", text, oldLine: oldNo, newLine: newNo });
          budget--;
        } else truncated = true;
        oldNo++;
        newNo++;
      }
    }
    hunks.push({
      oldStart,
      oldLines: num(h.oldLines),
      newStart,
      newLines: num(h.newLines),
      lines,
    });
  }

  return {
    filePath,
    kind,
    additions,
    deletions,
    hunks,
    truncated: truncated || undefined,
    userModified: result?.userModified === true || undefined,
  };
}

/** File + line-range for a Read. Derivable from `input.file_path` alone (basename),
 *  enriched with the range when the `toolUseResult.file` sidecar is present. */
function readInfoFromResult(input: Rec, result: Rec | undefined): ReadInfo | undefined {
  const file = asRec(result?.file);
  const filePath = str(input.file_path) ?? str(file?.filePath);
  if (!filePath && !file) return undefined;
  return {
    filePath,
    basename: filePath ? (filePath.split("/").pop() ?? filePath) : undefined,
    startLine: numOpt(file?.startLine),
    numLines: numOpt(file?.numLines),
    totalLines: numOpt(file?.totalLines),
    // Image detection is extension-based, so it's transcript-only (cache-safe).
    // The servable `projectRelPath` depends on the project dir and is filled in at
    // join time (see `attachToolDetails`).
    isImage: filePath && fileKind(filePath) === "image" ? true : undefined,
  };
}

/**
 * The read target's path relative to `baseDir` (the project dir), or undefined if
 * it isn't an absolute path inside it. Used to point the web's inline `<img>` at
 * the raw file endpoint, which resolves names against the same project dir — with
 * its own traversal guard as a second line of defence (issue #239).
 */
function servableRelPath(baseDir: string, absPath: string | undefined): string | undefined {
  if (!absPath || !path.isAbsolute(absPath)) return undefined;
  const rel = path.relative(baseDir, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel;
}

/** Turn `gitOperation` (e.g. `{push:{branch:"main"}}`) into a short hint "push → main". */
function gitOperationHint(op: unknown): string | undefined {
  const rec = asRec(op);
  if (!rec) return undefined;
  const entry = Object.entries(rec)[0];
  if (!entry) return undefined;
  const [name, detail] = entry;
  const branch = str(asRec(detail)?.branch);
  return branch ? `${name} → ${branch}` : name;
}

/** Split stdout/stderr + status affordances for a Bash. Only produced when there's
 *  something beyond a clean stdout to show (else the generic output renders). */
function bashDetailsFromResult(result: Rec | undefined): BashDetails | undefined {
  if (!result) return undefined;
  const stderr = str(result.stderr);
  const interrupted = result.interrupted === true;
  const returnCodeInterpretation = str(result.returnCodeInterpretation);
  const gitHint = gitOperationHint(result.gitOperation);
  if (!stderr && !interrupted && !returnCodeInterpretation && !gitHint) return undefined;
  return {
    // Carry stdout only when we're splitting off a stderr, so the render can show
    // both distinctly without doubling every clean Bash call's payload.
    stdout: stderr ? str(result.stdout) : undefined,
    stderr,
    interrupted: interrupted || undefined,
    returnCodeInterpretation,
    gitHint,
  };
}

/** Match/file counts for a Grep/Glob. */
function searchInfoFromResult(toolName: string, result: Rec | undefined): SearchInfo | undefined {
  if (!result) return undefined;
  if (toolName === "Grep") {
    const mode = str(result.mode);
    const info: SearchInfo = {
      kind: "grep",
      numFiles: numOpt(result.numFiles),
      numLines: mode === "content" ? numOpt(result.numLines) : undefined,
      truncated: result.appliedLimit ? true : undefined,
    };
    return info.numFiles !== undefined || info.numLines !== undefined ? info : undefined;
  }
  // Glob
  const info: SearchInfo = {
    kind: "glob",
    numFiles: numOpt(result.numFiles),
    totalMatches: numOpt(result.totalMatches),
    truncated: result.truncated === true || undefined,
  };
  return info.numFiles !== undefined || info.totalMatches !== undefined ? info : undefined;
}

/** Status transition for a TaskUpdate. */
function taskUpdateFromResult(result: Rec | undefined): TaskUpdateInfo | undefined {
  if (!result) return undefined;
  const sc = asRec(result.statusChange);
  const updatedFields = Array.isArray(result.updatedFields)
    ? result.updatedFields.filter((x): x is string => typeof x === "string")
    : undefined;
  const info: TaskUpdateInfo = {
    taskId: id(result.taskId),
    updatedFields: updatedFields?.length ? updatedFields : undefined,
    from: str(sc?.from),
    to: str(sc?.to),
  };
  if (!info.taskId && !info.from && !info.to && !info.updatedFields) return undefined;
  return info;
}

/** Subject/description for a TaskCreate. */
function taskCreateFromResult(input: Rec, result: Rec | undefined): TaskCreateInfo | undefined {
  const task = asRec(result?.task);
  const subject = str(task?.subject) ?? str(input.subject);
  const description = str(input.description) ?? str(input.prompt);
  const taskId = id(task?.id);
  if (!subject && !description && !taskId) return undefined;
  return { taskId, subject, description };
}

/** Derive the per-tool structured fields for one recovered tool_use. */
function deriveDetail(toolName: string, input: Rec, result: Rec | undefined): ToolDetail {
  const detail: ToolDetail = { toolName };
  if (EDIT_TOOL_NAMES.has(toolName)) detail.editDiff = editDiffFromResult(toolName, input, result);
  else if (toolName === "Read") detail.readInfo = readInfoFromResult(input, result);
  else if (toolName === "Bash") detail.bashDetails = bashDetailsFromResult(result);
  else if (toolName === "Grep" || toolName === "Glob")
    detail.searchInfo = searchInfoFromResult(toolName, result);
  else if (toolName === "TaskUpdate") detail.taskUpdate = taskUpdateFromResult(result);
  else if (toolName === "TaskCreate") detail.taskCreate = taskCreateFromResult(input, result);
  return detail;
}

/** The additive fields to spread onto the tool call, or null if none were derived. */
function extraFields(detail: ToolDetail): Partial<EnrichedToolCall> | null {
  const extra: Partial<EnrichedToolCall> = {};
  if (detail.editDiff) extra.editDiff = detail.editDiff;
  if (detail.readInfo) extra.readInfo = detail.readInfo;
  if (detail.bashDetails) extra.bashDetails = detail.bashDetails;
  if (detail.searchInfo) extra.searchInfo = detail.searchInfo;
  if (detail.taskUpdate) extra.taskUpdate = detail.taskUpdate;
  if (detail.taskCreate) extra.taskCreate = detail.taskCreate;
  return Object.keys(extra).length ? extra : null;
}

// --- recovery + join ------------------------------------------------------

/** Recover per-tool details (file-ordered, paired-only) from a session transcript. */
export async function readToolDetails(projectDir: string, sessionId: string): Promise<ToolDetail[]> {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  return readToolDetailsFromFile(path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`));
}

async function readToolDetailsFromFile(file: string): Promise<ToolDetail[]> {
  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(detailsCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const value = await readToolDetailsFromFileUncached(file);
  if (mtimeMs !== undefined) mtimeCacheSet(detailsCache, file, mtimeMs, value);
  return value;
}

interface RawUse {
  toolName: string;
  input: Rec;
}

async function readToolDetailsFromFileUncached(file: string): Promise<ToolDetail[]> {
  const byId = new Map<string, RawUse>();
  const order: string[] = [];
  const resultIds = new Set<string>();
  // `toolUseResult` is a top-level field on the tool_result line, correlated to
  // the tool_use via the (single) tool_result block's `tool_use_id`.
  const resultById = new Map<string, Rec>();

  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: { message?: { content?: unknown }; toolUseResult?: unknown };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const content = parsed.message?.content;
      if (!Array.isArray(content)) continue;

      // Collect this line's tool_result ids first — a single one lets us pin the
      // line-level `toolUseResult` unambiguously (parallel results are rare and
      // simply skip the sidecar rather than mis-attribute it).
      const lineResultIds: string[] = [];
      for (const block of content) {
        const b = block as {
          type?: string;
          name?: string;
          id?: string;
          tool_use_id?: string;
          input?: Rec;
        };
        if (b?.type === "tool_use" && b.name && DETAIL_TOOL_NAMES.has(b.name) && b.id) {
          if (!byId.has(b.id)) {
            order.push(b.id);
            byId.set(b.id, { toolName: b.name, input: b.input ?? {} });
          }
        } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          resultIds.add(b.tool_use_id);
          lineResultIds.push(b.tool_use_id);
        }
      }
      const tur = asRec(parsed.toolUseResult);
      if (tur && lineResultIds.length === 1) resultById.set(lineResultIds[0], tur);
    }
  } catch {
    return [];
  } finally {
    rl.close();
    stream.destroy();
  }

  return order
    .filter((tid) => resultIds.has(tid))
    .map((tid) => {
      const use = byId.get(tid)!;
      return deriveDetail(use.toolName, use.input, resultById.get(tid));
    });
}

/** True when any parsed message is a tool call we derive detail for. */
function hasDetailTool(messages: EnrichedMessage[]): boolean {
  return messages.some((m) => m.toolCall && DETAIL_TOOL_NAMES.has(m.toolCall.toolName));
}

/**
 * Attach recovered per-tool detail to each detail-bearing tool message. The
 * recovered details and the parsed messages are joined **per tool name, in file
 * order** — the same paired-only/file-ordered invariant `enrichWithEdits`/
 * `attachSubagentFields` rely on (which filter both sides to their tool set),
 * bucketed by name so the defensive `toolName` match is intrinsic AND a tool herdctl
 * happens to drop from its parsed stream (e.g. an interrupted, empty-output Bash)
 * only misaligns its own family, never the whole tail. Sub-agent fields already
 * attached by `enrichWithSubagents` are preserved (Task/Agent aren't in
 * `DETAIL_TOOL_NAMES`). Detail-free sessions pass through unchanged.
 */
export async function attachToolDetails(
  projectDir: string,
  sessionId: string,
  messages: EnrichedMessage[],
): Promise<EnrichedMessage[]> {
  if (!hasDetailTool(messages)) return messages;
  const details = await readToolDetails(projectDir, sessionId);
  // Bucket the recovered details by tool name, preserving file order within each.
  const byName = new Map<string, ToolDetail[]>();
  for (const d of details) {
    const arr = byName.get(d.toolName);
    if (arr) arr.push(d);
    else byName.set(d.toolName, [d]);
  }
  const cursor = new Map<string, number>();
  return messages.map((m) => {
    const tc = m.toolCall;
    if (!tc || !DETAIL_TOOL_NAMES.has(tc.toolName)) return m;
    const i = cursor.get(tc.toolName) ?? 0;
    cursor.set(tc.toolName, i + 1);
    const detail = byName.get(tc.toolName)?.[i];
    if (!detail) return m;
    let extra = extraFields(detail);
    if (!extra) return m;
    // For an image Read inside the project dir, add the servable relative path so
    // the web can render it inline (issue #239). Clone rather than mutate the
    // cached `detail.readInfo`. Scratch chats pass their scratchDir as projectDir;
    // the web still gates on a real project slug before rendering.
    if (extra.readInfo?.isImage) {
      const rel = servableRelPath(projectDir, extra.readInfo.filePath);
      if (rel) extra = { ...extra, readInfo: { ...extra.readInfo, projectRelPath: rel } };
    }
    return { ...m, toolCall: { ...tc, ...extra } };
  });
}

/**
 * The single history-enrichment orchestrator (issue #237). Composes the three
 * server-side passes so the routes call one function: sub-agent recovery (#37) →
 * generalized per-tool detail (#237, subsuming #232's edit diff) → background /
 * task-notification folding (#230) → local-command stdout recovery (#158).
 */
export async function enrichWithToolDetails(
  projectDir: string,
  sessionId: string,
  messages: EnrichedMessage[],
): Promise<EnrichedMessage[]> {
  const withSubagents = await enrichWithSubagents(projectDir, sessionId, messages);
  const withDetails = await attachToolDetails(projectDir, sessionId, withSubagents);
  const withBackground = enrichWithBackground(withDetails);
  return enrichWithLocalCommands(projectDir, sessionId, withBackground);
}
