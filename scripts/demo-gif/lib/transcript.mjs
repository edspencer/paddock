/**
 * transcript.mjs — builders for Claude Code transcript JSONL lines.
 *
 * Paddock renders chats by parsing the transcript files Claude Code writes; the
 * demo seed hand-authors those files so the UI has something rich to show. The
 * shapes below are the ones `packages/server/src/tooldetails.ts` actually reads
 * — each one is annotated with the rule that makes it render, because most of
 * them fail *silently* when you get them wrong.
 *
 * ── The three rules that cost the most time to rediscover ───────────────────
 *
 *  1. `toolUseResult` is a TOP-LEVEL key on the tool_result line — a sibling of
 *     `message`, not a field inside it. Snake_case `tool_use_result` is a
 *     different, older shape that @herdctl/core matches FIRST and returns early
 *     on, so using it silently bypasses everything here.
 *
 *  2. `tool_result.content` MUST be a non-empty string. Core drops empty results
 *     entirely (`blockContent.length > 0`), which leaves the tool card spinning
 *     "pending" forever AND desynchronises the detail cursor — `attachToolDetails`
 *     joins details to cards positionally within each tool-name bucket, so one
 *     dropped result slides every later card of that tool onto the wrong data.
 *
 *  3. One tool_result block per line. `readToolDetails` only records the sidecar
 *     when the line carries exactly one result id; two results on one line means
 *     the sidecar is discarded.
 */
import crypto from "node:crypto";

/**
 * Deterministic id generator. The seed must be reproducible across runs so a
 * re-shoot diffs cleanly and job-record ids stay stable, hence a counter-based
 * hash rather than crypto.randomUUID().
 */
export function makeIds(namespace) {
  let n = 0;
  const h = (label) =>
    crypto.createHash("sha256").update(`${namespace}:${label}:${n++}`).digest("hex");
  return {
    /** RFC-4122-shaped v4 uuid, deterministic. Used for session ids. */
    uuid(label = "") {
      const x = h(`uuid:${label}`);
      return [
        x.slice(0, 8),
        x.slice(8, 12),
        `4${x.slice(13, 16)}`,
        ((parseInt(x[16], 16) & 0x3) | 0x8).toString(16) + x.slice(17, 20),
        x.slice(20, 32),
      ].join("-");
    },
    toolId(label = "") {
      return `toolu_${h(`tool:${label}`).slice(0, 16)}`;
    },
    msgId(label = "") {
      return `msg_${h(`msg:${label}`).slice(0, 16)}`;
    },
    agentId(label = "") {
      return `agent-${h(`agent:${label}`).slice(0, 16)}`;
    },
  };
}

/**
 * A clock that hands out monotonically increasing ISO timestamps, so a chat's
 * turns read as a plausible sequence and `subagentDurationMs` (last minus first
 * timestamp in the sub-agent file) comes out to a sensible number.
 */
export function clock(startIso, stepMs = 1500) {
  let t = Date.parse(startIso);
  return {
    next(advanceMs = stepMs) {
      const iso = new Date(t).toISOString();
      t += advanceMs;
      return iso;
    },
    peek: () => new Date(t).toISOString(),
  };
}

const j = (obj) => `${JSON.stringify(obj)}\n`;

/** Token usage block. `contextTokens` = input + cache_creation + cache_read of
 *  the LAST assistant turn (output_tokens is excluded); cost accumulates over
 *  every turn. So make the cache_read figure grow across a chat. */
export const usage = (input, output, cacheRead = 0, cacheCreate = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
});

export function userLine(ctx, content) {
  return j({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content },
    uuid: ctx.ids.uuid(`u:${content.slice(0, 24)}`),
    timestamp: ctx.clock.next(),
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    version: "2.1.167",
    gitBranch: ctx.gitBranch ?? "main",
    userType: "external",
  });
}

export function assistantText(ctx, text, use, advanceMs) {
  return j({
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    message: {
      // Dedupe is keep-first on message.id — reusing an id silently drops the
      // line from the usage tally, so every message needs a distinct one.
      id: ctx.ids.msgId(text.slice(0, 24)),
      role: "assistant",
      model: ctx.model,
      content: [{ type: "text", text }],
      usage: use,
    },
    uuid: ctx.ids.uuid(`a:${text.slice(0, 24)}`),
    timestamp: ctx.clock.next(advanceMs),
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
  });
}

export function assistantToolUse(ctx, { name, id, input, use, advanceMs }) {
  return j({
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    message: {
      id: ctx.ids.msgId(`use:${id}`),
      role: "assistant",
      model: ctx.model,
      content: [{ type: "tool_use", id, name, input }],
      usage: use,
    },
    uuid: ctx.ids.uuid(`tu:${id}`),
    timestamp: ctx.clock.next(advanceMs),
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
  });
}

/**
 * A paired tool_result. `content` must be non-empty (rule 2 above) — we throw
 * rather than let the caller discover it as a permanently-spinning card.
 */
export function toolResult(ctx, { id, content, result, advanceMs }) {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`tool_result.content must be a non-empty string (tool ${id})`);
  }
  const obj = {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
    },
    uuid: ctx.ids.uuid(`tr:${id}`),
    timestamp: ctx.clock.next(advanceMs),
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
  };
  if (result !== undefined) obj.toolUseResult = result;
  return j(obj);
}

/**
 * Emit a tool_use + its tool_result as one unit — the only correct ordering.
 *
 * The card's displayed duration is the gap between the two lines' timestamps, so
 * `durationMs` has to advance the clock on the tool_use line; advancing it on the
 * result instead leaves every card reading the default step (a subtle way to get
 * a transcript where every tool took suspiciously exactly 1.5s).
 */
export function toolCall(ctx, { name, id, input, content, result, use, durationMs = 1500 }) {
  return (
    assistantToolUse(ctx, { name, id, input, use, advanceMs: durationMs }) +
    toolResult(ctx, { id, content, result, advanceMs: 400 })
  );
}

// ── toolUseResult builders, one per renderer ────────────────────────────────

/** Edit / Write / MultiEdit → red-green diff with real gutter line numbers.
 *  `lines` entries are prefixed " ", "+" or "-"; additions/deletions are counted
 *  from those prefixes, and oldStart/newStart drive the @@ hunk header. */
export const editResult = (filePath, hunks) => ({
  filePath,
  userModified: false,
  structuredPatch: hunks,
});

/** Read of an image → inline <img>. `isImage` is decided purely by the file
 *  EXTENSION on input.file_path, but the browser then fetches the file through
 *  the project's raw-file endpoint — so the PNG must genuinely exist inside the
 *  project directory or the card renders a broken image.
 *
 *  Deliberately no `file` block: that field drives the "lines a–b of N" range
 *  chip, which is meaningful for text but renders as a nonsense "lines 1–1 of 1"
 *  on an image. */
export const readImageResult = () => ({ type: "image" });

/** Grep → "24 lines · 7 files". numLines is ONLY carried when mode is exactly
 *  "content"; any other mode silently drops it. */
export const grepResult = (numFiles, numLines, filenames = []) => ({
  mode: "content",
  numFiles,
  numLines,
  filenames,
});

/** Bash → the rich stdout/stderr body. Needs at least one of stderr /
 *  interrupted / returnCodeInterpretation / gitOperation, otherwise it degrades
 *  to a plain output block. Note stdout is only carried when stderr is present. */
export const bashResult = ({ stdout = "", stderr = "", returnCodeInterpretation, gitOperation }) => {
  const r = { stdout, stderr, interrupted: false };
  if (returnCodeInterpretation) r.returnCodeInterpretation = returnCodeInterpretation;
  if (gitOperation) r.gitOperation = gitOperation;
  return r;
};
