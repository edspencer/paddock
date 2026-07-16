/**
 * Edit-diff enrichment — issue #232.
 *
 * `Edit`/`MultiEdit`/`Write` tool calls render as a plain block today: herdctl's
 * parsed `ChatToolCall` carries only the file path (`inputSummary`) and a success
 * string (`output`) — never the before/after content, so you can't see *what*
 * changed without leaving the chat.
 *
 * The change material IS in the raw transcript's `tool_use.input`
 * (`old_string`/`new_string`, or `content` for `Write`). We recover it the same
 * way `subagents.ts` recovers `Task` inputs and `background.ts` correlates task
 * ids — read the raw JSONL, positionally join to herdctl's parsed tool messages
 * (both filtered to edit tools, in file order, paired-only) — then compute a
 * compact line-level diff server-side and attach it to the `toolCall`. No herdctl
 * change; no diff dependency (a small LCS line-diff).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { projectChatsDir } from "./transcripts.js";
import {
  SAFE_SEGMENT,
  statMtimeMs,
  mtimeCacheGet,
  mtimeCacheSet,
  type MtimeCache,
  type EnrichedMessage,
  type EditDiff,
  type DiffLine,
} from "./subagents.js";

/** Tool names that mutate a file and carry a renderable diff. */
const EDIT_TOOL_NAMES = new Set(["Edit", "MultiEdit", "Write"]);

/** Cap rendered diff lines per tool call (stats stay exact; `truncated` flags it). */
const MAX_DIFF_LINES = 400;

/** The recovered diff for one paired edit tool_use, in file order. */
interface EditToolUse {
  toolUseId: string;
  toolName: string;
  diff: EditDiff;
}

const editUsesCache: MtimeCache<EditToolUse[]> = new Map();

/** Coerce a JSON value to a string, else "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Split into lines without a spurious trailing empty element for a final newline. */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line-level diff of `a` → `b` via LCS: unchanged lines are context (` `), the
 * rest are deletions (`-`) then additions (`+`). O(n·m) — fine for edit snippets.
 */
function lineDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: "-", text: a[i++] });
    } else {
      out.push({ t: "+", text: b[j++] });
    }
  }
  while (i < n) out.push({ t: "-", text: a[i++] });
  while (j < m) out.push({ t: "+", text: b[j++] });
  return out;
}

/** Count add/del lines across hunks. */
function tally(hunks: { lines: DiffLine[] }[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.t === "+") additions++;
      else if (l.t === "-") deletions++;
    }
  }
  return { additions, deletions };
}

/** Truncate rendered lines to MAX_DIFF_LINES across hunks; returns whether it cut. */
function capHunks(hunks: { lines: DiffLine[] }[]): boolean {
  let budget = MAX_DIFF_LINES;
  let truncated = false;
  for (const h of hunks) {
    if (h.lines.length > budget) {
      h.lines = h.lines.slice(0, Math.max(0, budget));
      truncated = true;
    }
    budget -= h.lines.length;
  }
  return truncated;
}

/** Build the structured diff from a recovered edit tool_use input. */
function diffFromInput(toolName: string, input: Record<string, unknown>): EditDiff {
  const filePath = str(input.file_path) || undefined;
  let kind: EditDiff["kind"];
  let hunks: { lines: DiffLine[] }[];

  if (toolName === "Write") {
    kind = "write";
    // Whole-file create/overwrite — the transcript records no prior content, so
    // render it as all-additions.
    hunks = [{ lines: splitLines(str(input.content)).map((text) => ({ t: "+" as const, text })) }];
  } else if (toolName === "MultiEdit") {
    kind = "multiedit";
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
    hunks = edits.map((e) => ({
      lines: lineDiff(splitLines(str(e.old_string)), splitLines(str(e.new_string))),
    }));
  } else {
    kind = "edit";
    hunks = [{ lines: lineDiff(splitLines(str(input.old_string)), splitLines(str(input.new_string))) }];
  }

  const { additions, deletions } = tally(hunks);
  const truncated = capHunks(hunks);
  return { filePath, kind, additions, deletions, hunks, truncated };
}

/** Recover paired edit tool_uses (in file order) from a session transcript. */
export async function readEditToolUses(
  projectDir: string,
  sessionId: string,
): Promise<EditToolUse[]> {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  return readEditUsesFromFile(path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`));
}

async function readEditUsesFromFile(file: string): Promise<EditToolUse[]> {
  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(editUsesCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const value = await readEditUsesFromFileUncached(file);
  if (mtimeMs !== undefined) mtimeCacheSet(editUsesCache, file, mtimeMs, value);
  return value;
}

async function readEditUsesFromFileUncached(file: string): Promise<EditToolUse[]> {
  const byId = new Map<string, EditToolUse>();
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
          input?: Record<string, unknown>;
        };
        if (b?.type === "tool_use" && b.name && EDIT_TOOL_NAMES.has(b.name) && b.id) {
          if (!byId.has(b.id)) {
            order.push(b.id);
            byId.set(b.id, {
              toolUseId: b.id,
              toolName: b.name,
              diff: diffFromInput(b.name, b.input ?? {}),
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

/** True when any parsed message is an edit tool call worth enriching. */
function hasEditTool(messages: EnrichedMessage[]): boolean {
  return messages.some((m) => m.toolCall && EDIT_TOOL_NAMES.has(m.toolCall.toolName));
}

/**
 * Attach a recovered `editDiff` to every `Edit`/`MultiEdit`/`Write` tool message,
 * joining against `readEditToolUses` by file order (both are file-ordered and
 * paired-only, so the positional join stays aligned — same technique as the
 * sub-agent join). A defensive tool-name check skips any misaligned entry. Other
 * messages and edit-free sessions pass through unchanged (cheap early return).
 */
export async function enrichWithEdits(
  projectDir: string,
  sessionId: string,
  messages: EnrichedMessage[],
): Promise<EnrichedMessage[]> {
  if (!hasEditTool(messages)) return messages;
  const uses = await readEditToolUses(projectDir, sessionId);
  let i = 0;
  return messages.map((m) => {
    if (!m.toolCall || !EDIT_TOOL_NAMES.has(m.toolCall.toolName)) return m;
    const use = uses[i++];
    if (!use || use.toolName !== m.toolCall.toolName) return m;
    return { ...m, toolCall: { ...m.toolCall, editDiff: use.diff } };
  });
}
