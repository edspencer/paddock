/**
 * When a chat was last *actually* used, as opposed to when its file was last
 * touched (#863).
 *
 * ## The bug this exists to remove
 *
 * The chat list's "updated X ago" — and the order the list is in — came from
 * the transcript `.jsonl`'s filesystem **mtime**. That is a property of the
 * file, not of the conversation, and Paddock touches transcripts for reasons
 * that have nothing to do with anyone talking: discovery re-stats, attribution,
 * a resume appending a mode record, a relocation. Every one of those bumps the
 * mtime with no new message in the file. The visible result was days-old chats
 * announcing themselves as "updated a few minutes ago" — in *batches*,
 * phase-locked to a periodic task, because that is what actually moved them —
 * and jumping to the top of a list sorted by recency. Nothing was lost; the
 * ordering was simply not about what it claimed to be about.
 *
 * So: read the timestamp of the last real message **inside** the transcript,
 * and fall back to mtime only when there is no datable record to read.
 *
 * ## Why a tail read rather than a parse
 *
 * The value wanted is on the last qualifying line, so this seeks to the end and
 * walks backwards, stopping at the first line that qualifies. A transcript is
 * append-only, so that is a couple of pages of IO regardless of whether the
 * chat holds ten messages or ten thousand. `@herdctl/core` does compute this
 * during `extractSessionMetadata`, but as part of a whole-file parse the
 * listing path deliberately does not do — reusing it would have traded a
 * cosmetic bug for a real one.
 *
 * Results are memoised against mtime (the same LRU the subagent and usage
 * readers use). Note the irony, and that it is fine: a spurious touch — the
 * very thing this module exists to ignore — still invalidates the cache and
 * costs one tail read. It buys correctness in the other direction, where a
 * touch accompanies a genuine append, and a tail read is cheap enough that
 * paying it on a false alarm is not worth a subtler key.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { DiscoveredSession } from "@herdctl/core";
import { projectChatsDir } from "./transcripts.js";
import { mtimeCacheGet, mtimeCacheSet, statMtimeMs, type MtimeCache } from "./subagents.js";

/**
 * A session plus the timestamp of its last real message.
 *
 * A widening rather than a replacement, because `mtime` still has a job:
 * it is the cache key for auto-name, preview, sidechain detection and usage
 * throughout this package and inside herdctl. Overwriting it with the corrected
 * value would fix the display and silently break every one of those caches —
 * they would stop noticing that a file had changed.
 */
export interface SessionWithActivity extends DiscoveredSession {
  /** ISO 8601 timestamp of the last real message; absent if none was datable. */
  lastMessageAt?: string;
}

/** How much of the file's end to look at before widening the window. */
const TAIL_BYTES = 128 * 1024;
/** The second and last attempt — enough to clear a single enormous tool result. */
const WIDE_TAIL_BYTES = 4 * 1024 * 1024;

const cache: MtimeCache<string | undefined> = new Map();

/**
 * Does this record represent a human or the agent actually saying something?
 *
 * The exclusions are the point of the whole issue, not defensive noise. A
 * resume, a permission-mode change or a background agent finishing all append
 * records to a transcript **without any turn having happened**, and counting
 * those as activity reintroduces the same bug one layer up: a chat nobody has
 * touched in a week, freshly stamped, back at the top of the list.
 *
 * Exported because the `own → host` migration preview (#882) counts the same
 * records to show a diverged chat's two copies side by side. A second copy of
 * this rule would drift, and the two numbers would then disagree on screen
 * about what a message is.
 */
export function isConversationRecord(rec: {
  type?: unknown;
  isMeta?: unknown;
  origin?: { kind?: unknown };
}): boolean {
  // Drops `summary` title entries and every `type: "system"` control line
  // (local-command records, permission-mode changes, hook output).
  if (rec.type !== "user" && rec.type !== "assistant") return false;
  // Harness-injected synthetic user lines: skill bodies, slash-command
  // expansions, hook output. Nobody typed them.
  if (rec.isMeta === true) return false;
  // A spawned agent's stop/complete block. Real work, but not a turn in THIS
  // chat, and it lands without the user or the agent here saying anything.
  if (rec.origin?.kind === "task-notification") return false;
  return true;
}

/** The last `bytes` of `file`, plus whether that covered the whole thing. */
async function readTail(
  file: string,
  size: number,
  bytes: number,
): Promise<{ text: string; whole: boolean }> {
  const take = Math.min(bytes, size);
  const start = size - take;
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(take);
    await handle.read(buf, 0, take, start);
    // A byte offset can land mid-character; only the first line can be affected
    // and the caller discards it whenever `whole` is false.
    return { text: buf.toString("utf8"), whole: start === 0 };
  } finally {
    await handle.close();
  }
}

/** Walk a window backwards for the newest qualifying record's timestamp. */
function scanBackwards(text: string, whole: boolean): string | undefined {
  const lines = text.split("\n");
  // Seeking to a byte offset almost certainly landed inside a line. Dropping it
  // costs nothing (it is the OLDEST line in the window) and keeps a fragment
  // from being mistaken for a malformed record.
  if (!whole) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: { timestamp?: unknown; type?: unknown; isMeta?: unknown; origin?: { kind?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isConversationRecord(rec)) continue;
    const ts = rec.timestamp;
    if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) return ts;
  }
  return undefined;
}

/**
 * Timestamp of the last real message in a project chat's transcript.
 *
 * `undefined` — a missing file, an unreadable one, a transcript of nothing but
 * control records — is a legitimate answer meaning "nothing better than the
 * mtime", and every caller treats it that way.
 */
export async function lastMessageAt(
  projectDir: string,
  sessionId: string,
): Promise<string | undefined> {
  // Same guard as `readFirstUserText`: keep a session id from walking out of
  // `.chats/`.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined;
  const file = path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`);

  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs === undefined) return undefined;
  const cached = mtimeCacheGet(cache, file, mtimeMs);
  if (cached.hit) return cached.value;

  let found: string | undefined;
  try {
    const { size } = await fs.stat(file);
    if (size > 0) {
      const near = await readTail(file, size, TAIL_BYTES);
      found = scanBackwards(near.text, near.whole);
      // Nothing qualified, and there is more file to look at: one transcript
      // record can be megabytes (a large tool result), so the window can hold a
      // single unterminated line. One wider retry, then give up to the mtime.
      if (found === undefined && !near.whole) {
        const far = await readTail(file, size, WIDE_TAIL_BYTES);
        found = scanBackwards(far.text, far.whole);
      }
    }
  } catch {
    found = undefined;
  }

  mtimeCacheSet(cache, file, mtimeMs, found);
  return found;
}

/**
 * Attach `lastMessageAt` to each session and order them newest-first.
 *
 * The sort lives here rather than in the client because the client is not the
 * only reader: the MCP `list_chats` tool and the project-detail payload both
 * take the server's order as given. The comparison falls back to `mtime`
 * per-session rather than for the list as a whole, so a chat with no datable
 * record still sorts sensibly against ones that have.
 */
export async function withLastActivity(
  projectDir: string,
  sessions: readonly DiscoveredSession[],
): Promise<SessionWithActivity[]> {
  const enriched = await Promise.all(
    sessions.map(async (s) => {
      const at = await lastMessageAt(projectDir, s.sessionId).catch(() => undefined);
      return at === undefined ? { ...s } : { ...s, lastMessageAt: at };
    }),
  );
  // ISO-8601 sorts lexicographically in chronological order, but only against
  // another ISO-8601 string in the same shape — `Date.parse` rather than `<`,
  // because `lastMessageAt` comes out of a transcript written by Claude Code
  // and `mtime` out of `toISOString()`, and mixing offsets would otherwise
  // compare as text.
  return enriched.sort((a, b) => activityMs(b) - activityMs(a));
}

/** Epoch ms a session should be ordered by: its last message, else its mtime. */
export function activityMs(s: SessionWithActivity): number {
  return Date.parse(s.lastMessageAt ?? s.mtime) || 0;
}
