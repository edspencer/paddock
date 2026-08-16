/**
 * The `own → host` transcript migration — the READ half (#882).
 *
 * Flipping `claude.transcripts` from `own` to `host` on an instance that has
 * been used is #708: every pre-flip chat vanishes from the list, files intact
 * but unreachable. This module answers the two questions the guided migration
 * asks BEFORE anything moves:
 *
 *   1. "Is there anything to migrate?"  → {@link probeMigration}   (the banner)
 *   2. "What exactly would happen?"     → {@link buildMigrationPlan} (the table)
 *
 * Nothing here writes, moves or deletes. The execute half — quiesce, move,
 * write `claude.transcripts: host` — is a separate change; see
 * `docs/DESIGN-transcripts-migration.md` §4 for its ordering and commit point.
 *
 * ## The probe asks "is `.chats/` non-empty?", not "is anything new?"
 *
 * The design's first draft short-circuited on the first chat present in
 * `.chats/` and absent from the host store. That is a narrower question than
 * the banner asks, and §10.1 corrects it: a user who adopted their CLI history
 * and then kept working in both places has **zero** such chats — every id
 * exists on both sides — and would never see the banner, despite being exactly
 * the person #882 was opened for.
 *
 * The real predicate comes from the migration's own postcondition (§5): the
 * redirect symlink `pointChatsDirAt` plants on the next boot is declined
 * outright if `.chats/` is a real directory holding **anything**
 * (`transcripts.ts:145`), so every entry must move — including a chat that is
 * byte-identical on both sides. Identity means there is no decision for the
 * user to make; it does not mean there is no work to do. So the probe readdirs
 * `.chats/` and nothing else: one syscall batch per project, no host-store read
 * at all.
 *
 * ## The classifier is staged so cost tracks conflicts, not chat count
 *
 * | Stage | Work | Rules out |
 * |---|---|---|
 * | 0 | `readdir` both sides | an id only in `.chats/` is `new` — no `stat`, no read |
 * | 1 | `stat` both sides | equal size **and** mtime ⇒ identical, no row |
 * | 2 | tail-read the shorter side's last `uuid`, then a **bounded probe** of the longer side in a 32 KB window ending at byte `shorter.size` | a hit ⇒ `fast-forward` |
 * | 3 | full scan of the longer side for that uuid | hit ⇒ `fast-forward` (rewritten history); miss ⇒ `diverged` |
 *
 * Stage 2 is the load-bearing part and the reason the table is affordable at
 * all. A transcript is append-only, so a genuine ancestor's last record *ends
 * at byte offset `shorter.size`* in its descendant — the uuid is at a known
 * offset and does not need to be searched for. Measured 298 hits / 0 misses
 * over 300 real transcripts (design §0.3). The full scan survives only to
 * *confirm divergence*, never to confirm a fast-forward, and it draws from a
 * shared per-request byte budget so a pathological instance degrades to
 * `unknown` rows rather than to an unbounded read. Nothing is silently
 * truncated: `scanBudgetExhausted` and `totals.unknown` are the disclosure.
 */
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { encodedTranscriptDir, projectChatsDir, type TranscriptsMode } from "./transcripts.js";
import { isConversationRecord } from "./last-activity.js";

/**
 * The three-state classification the modal's table renders, plus the budget
 * escape hatch.
 *
 * `unknown` is not a fourth kind of conflict — it is "we stopped looking", and
 * it is treated as `diverged` (default unchecked) because that is the
 * conservative direction.
 */
export type MigrationState = "new" | "fast-forward" | "diverged" | "unknown";

/** Why the banner is not offered. */
export type MigrationIneligibleReason =
  | "already-host"
  | "env-shadowed"
  | "profile-paranoid"
  | "nothing-pending"
  | "scan-failed";

/** Non-fatal conditions the modal should surface. */
export type MigrationWarningCode =
  | "host-store-unreadable"
  | "chats-dir-unreadable"
  | "env-shadowed"
  | "memory-collision"
  | "unexpected-entries";

/** The env var that shadows `claude.transcripts` — see `config.ts:1481`. */
export const TRANSCRIPTS_ENV_VAR = "PADDOCK_CLAUDE_TRANSCRIPTS";

/**
 * Where unchecked chats are preserved: a SIBLING of `.chats/`, not a child.
 *
 * #882 specified `.chats/pre-migration/`, which cannot work — that directory is
 * "anything", so `pointChatsDirAt` declines the redirect and the migration
 * built to fix #708 ships #708's symptom. Design §5.1 verified it against the
 * real `ensureProjectChats`. Named here because the plan reports the path and
 * the execute half must use the same one.
 */
export const PRESERVE_DIR_NAME = ".chats-pre-migration";

/** How much of a transcript's end to read looking for its last record's uuid. */
const TAIL_WINDOW_BYTES = 32 * 1024;
/** One wider retry — enough to clear a single enormous tool-result record. */
const WIDE_TAIL_BYTES = 4 * 1024 * 1024;
/** The bounded probe's window, ending at byte `shorter.size` in the longer file. */
const PROBE_WINDOW_BYTES = 32 * 1024;
/** Chunk size for the stage-3 full scan (raw substring search, no parsing). */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * Bytes stage 3 (and the diverged rows' comparison columns) may read across one
 * whole request. The worst case is a *product* of chat count and transcript
 * size and neither is under our control, so it is bounded rather than trusted.
 */
export const DIVERGENCE_SCAN_BUDGET_BYTES = 256 * 1024 * 1024;

/** One copy of a chat, for a diverged row's comparison columns. */
export interface MigrationSide {
  /** Absolute path of this copy. */
  path: string;
  sizeBytes: number;
  /** Filesystem mtime. Present always; NOT a proxy for activity (#863). */
  mtime: string;
  /**
   * Conversation records — `user`/`assistant`, excluding meta and
   * task-notification records (the `last-activity.ts` rule, shared not copied).
   *
   * Present only where a decision needs it: on `diverged` rows, and only while
   * the scan budget lasts. Counting it requires a full parse of the file, so
   * populating it on every row would cost a complete read of every transcript
   * and make the plan endpoint's realistic case ~60× its measured cost. See the
   * PR body for why this deviates from the design's `required` list.
   */
  messageCount?: number;
  /** ISO 8601 timestamp of the last real message; absent when none is datable. */
  lastMessageAt?: string;
}

/** One row of the modal's table. */
export interface MigrationChatRow {
  sessionId: string;
  /** The chat's set name, else its auto-name. Absent when neither exists. */
  name?: string;
  /** First user message, truncated. Absent when unreadable. */
  preview?: string;
  state: MigrationState;
  /** How the checkbox starts: true for `new`/`fast-forward`. */
  defaultSelected: boolean;
  /** The copy in `.chats/`. Always present. */
  own: MigrationSide;
  /** The copy in the host store. Absent if and only if state is `new`. */
  host?: MigrationSide;
  /** For `fast-forward`, which side is the descendant and will survive. */
  ahead?: "own" | "host";
  /** Sidecars that move with this chat: `<id>/…` and `.reverts/<id>-*.jsonl`. */
  extras: string[];
}

/** One project's slice of the plan. */
export interface MigrationProjectPlan {
  /** Project slug; the empty string is the root workspace. */
  slug: string;
  name: string;
  chatsDir: string;
  hostStore: string;
  preserveDir: string;
  chats: MigrationChatRow[];
  /**
   * Entries of `.chats/` that move with the PROJECT rather than with any one
   * chat — `memory/`, flat `agent-<hex>.jsonl` sidechain transcripts, an
   * orphaned `<id>/` with no transcript.
   *
   * Not in the design's schema. Added because the postcondition moves them and
   * the standing rule is that nothing moves unannounced: without this the
   * completion summary could not say "and 132 memory files", which is the
   * single sharpest item in the design's own inventory (§5).
   */
  projectExtras: string[];
}

export interface MigrationWarning {
  code: MigrationWarningCode;
  /** The project it applies to. Absent for instance-wide warnings. */
  slug?: string;
  message: string;
  paths?: string[];
}

export interface MigrationTotals {
  chats: number;
  new: number;
  fastForward: number;
  diverged: number;
  unknown: number;
  /** Identical on both sides, omitted from the rows. Reported so a count lower
   *  than the user's chat total always has an explanation. */
  identical: number;
  defaultSelected: number;
}

export interface MigrationPlan {
  mode: TranscriptsMode;
  configPath: string;
  configVersion: string | null;
  projects: MigrationProjectPlan[];
  sweepers: { stores: number; chats: number };
  totals: MigrationTotals;
  scanBudgetExhausted: boolean;
  warnings: MigrationWarning[];
}

export interface MigrationProbe {
  mode: TranscriptsMode;
  eligible: boolean;
  reason?: MigrationIneligibleReason;
  envVar?: string;
  /**
   * Transcripts that would migrate. A LOWER BOUND by contract — see
   * {@link probeMigration} for why this implementation can afford to make it
   * exact, and for the one case where a pending project reports 0.
   */
  pendingChats: number;
  pendingProjects: number;
  scannedProjects: number;
  computedAt: string;
}

/** The subset of a project this module needs — kept minimal so it is testable
 *  against plain fixtures rather than a whole `ProjectStore`. */
export interface MigrationProjectRef {
  slug: string;
  name: string;
  /** The METADATA dir — where `.chats/` lives. */
  dir: string;
  /** The agent's cwd — what the host store's encoded name is built from. NOT
   *  `dir` for a repo-backed or linked project (#187/#206). */
  workingDir: string;
}

export interface MigrationInput {
  /** The transcripts mode this process resolved at boot. */
  mode: TranscriptsMode;
  /** The resolved posture profile — `paranoid` suppresses the banner (§10.4). */
  profile: string;
  /** True when `PADDOCK_CLAUDE_TRANSCRIPTS` is set: the config write is inert. */
  envShadowed: boolean;
  projects: MigrationProjectRef[];
  /** The USER's own `~/.claude` — the destination store's root. */
  userHome: string;
  /** Absolute path of the file the POST would write to. */
  configPath: string;
  /** Fingerprint of that file as read for this response. */
  configVersion: string | null;
  /** Sweeper working dirs (`<dataDir>/sweepers/<slug>/`), by slug. */
  sweeperDirs?: Map<string, string>;
  /** Per-session display name/preview, when the caller has them cheaply. */
  names?: Map<string, { name?: string; preview?: string }>;
  /**
   * Override the per-request divergence-scan budget. Exists so a test can
   * exhaust it with kilobytes instead of the 256 MB of pathological transcripts
   * the real bound would need — the exhaustion path is the one that must not be
   * silent, so it has to be exercised rather than reasoned about.
   */
  scanBudgetBytes?: number;
}

/* -------------------------------------------------------------------------- */
/* directory reading                                                           */
/* -------------------------------------------------------------------------- */

/** Same guard as `readFirstUserText`: keep a session id inside `.chats/`. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
/** A flat sidechain transcript at the top of a store (45 of them on this box). */
const SIDECHAIN_RE = /^agent-[0-9a-fA-F]+\.jsonl$/;

/** What one entry of `.chats/` is. */
type EntryKind = "chat" | "chat-dir" | "reverts" | "memory" | "sidechain" | "unexpected";

function entryKind(name: string, isDir: boolean): EntryKind {
  if (isDir) {
    if (name === "memory") return "memory";
    if (name === ".reverts") return "reverts";
    return SESSION_ID_RE.test(name) ? "chat-dir" : "unexpected";
  }
  if (SIDECHAIN_RE.test(name)) return "sidechain";
  if (name.endsWith(".jsonl") && SESSION_ID_RE.test(name.slice(0, -6))) return "chat";
  return "unexpected";
}

interface ChatsDirListing {
  /** Session ids with a `<id>.jsonl` in `.chats/`. */
  chats: string[];
  /** Session ids with a `<id>/` sidecar directory. */
  chatDirs: Set<string>;
  /** Entries that move with the project rather than with a chat. */
  projectExtras: string[];
  /** Entries matching no known pattern. */
  unexpected: string[];
  hasReverts: boolean;
  hasMemory: boolean;
  /** Total entries — the probe's whole question. */
  entryCount: number;
}

/**
 * Read one `.chats/`. Returns `null` when there is nothing to migrate from it:
 * missing, or already a symlink (a store that has been pointed at the host,
 * which is what a migrated project looks like before the restart).
 */
async function readChatsDir(
  chatsDir: string,
): Promise<{ listing: ChatsDirListing } | { error: NodeJS.ErrnoException } | null> {
  const st = await fs.lstat(chatsDir).catch(() => null);
  if (!st) return null;
  if (!st.isDirectory() || st.isSymbolicLink()) return null;
  let entries;
  try {
    entries = await fs.readdir(chatsDir, { withFileTypes: true });
  } catch (err) {
    return { error: err as NodeJS.ErrnoException };
  }
  const listing: ChatsDirListing = {
    chats: [],
    chatDirs: new Set(),
    projectExtras: [],
    unexpected: [],
    hasReverts: false,
    hasMemory: false,
    entryCount: entries.length,
  };
  for (const e of entries) {
    const full = path.join(chatsDir, e.name);
    switch (entryKind(e.name, e.isDirectory())) {
      case "chat":
        listing.chats.push(e.name.slice(0, -6));
        break;
      case "chat-dir":
        listing.chatDirs.add(e.name);
        break;
      case "reverts":
        listing.hasReverts = true;
        break;
      case "memory":
        listing.hasMemory = true;
        listing.projectExtras.push(full);
        break;
      case "sidechain":
        listing.projectExtras.push(full);
        break;
      default:
        listing.unexpected.push(full);
    }
  }
  // A `<id>/` with no `<id>.jsonl` has no row to hang off, but the
  // postcondition still moves it — so it is named at project level.
  for (const id of listing.chatDirs) {
    if (!listing.chats.includes(id)) listing.projectExtras.push(path.join(chatsDir, id));
  }
  return { listing };
}

/**
 * Which chat a `.reverts/<id>-<stamp>.jsonl` belongs to.
 *
 * `.reverts/` is shared across sessions (`herdctl.ts:1988`), so a partial
 * migration has to split it — and the id is prefix-matched, longest first, so a
 * chat whose id is a prefix of another chat's cannot steal its reverts.
 */
function ownerOfRevert(name: string, chatIds: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  for (let i = name.indexOf("-"); i > 0; i = name.indexOf("-", i + 1)) {
    const candidate = name.slice(0, i);
    if (chatIds.has(candidate) && (best === undefined || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best;
}

/** `mtimeMs:size` of a directory — "has its file *set* changed" (`adoptable.ts:354`). */
async function dirKey(dir: string): Promise<string> {
  const st = await fs.stat(dir).catch(() => null);
  return st ? `${st.mtimeMs}:${st.size}` : "-";
}

/* -------------------------------------------------------------------------- */
/* the banner probe                                                            */
/* -------------------------------------------------------------------------- */

interface ProbeCacheEntry {
  key: string;
  pending: boolean;
  chats: number;
}
const probeCache = new Map<string, ProbeCacheEntry>();

/** Drop the memoised probe answers (tests; a config write). */
export function resetMigrationProbeCache(): void {
  probeCache.clear();
}

/**
 * "Is there anything to migrate?" — one `readdir` per project, no transcript
 * read and no host-store read at all (§10.1).
 *
 * Memoised per project on `mtimeMs:size` of `.chats/` plus the config version,
 * which costs one `stat` to validate — that is what lets the banner be fetched
 * on every page load. The host-store term the design's §3.4 cache key carried
 * is gone with the host-store read it was there for.
 *
 * ### `pendingChats` is a lower bound that this implementation makes exact
 *
 * The design frames it as a lower bound because the probe "stops counting once
 * the answer is known". `fs.readdir` hands back the whole list in one call, so
 * there is no per-entry short-circuit to be had and counting the `*.jsonl`
 * entries is free — the number is exact. It is still *reported* as a lower
 * bound, because that is the contract clients were given and narrowing it later
 * is a breaking change; but the field is `>= 0` rather than `∈ {0, 1}`.
 *
 * The one wrinkle the corrected predicate introduces: eligibility is about
 * ENTRIES and `pendingChats` counts TRANSCRIPTS, so a `.chats/` holding only
 * `memory/` is `eligible: true` with `pendingChats: 0`. That combination is
 * correct, not a contradiction — there is real work to do and no chat to do it
 * to — and it makes the schema's "exact only when 0" gloss wrong in one
 * direction. Callers must key the banner off `eligible`, never off the count.
 */
export async function probeMigration(input: MigrationInput): Promise<MigrationProbe> {
  const base = {
    mode: input.mode,
    pendingChats: 0,
    pendingProjects: 0,
    scannedProjects: 0,
    computedAt: new Date().toISOString(),
  };

  // Cheap refusals first, in the order of how much they tell a client. Already
  // migrated beats everything; a shadowing env var is next because it means the
  // flip CANNOT work (the config write would be inert), which a user needs to
  // know even on a posture that hides the banner.
  if (input.mode === "host") return { ...base, eligible: false, reason: "already-host" };
  if (input.envShadowed) {
    return {
      ...base,
      eligible: false,
      reason: "env-shadowed",
      envVar: TRANSCRIPTS_ENV_VAR,
    };
  }
  // §10.4: `paranoid` chose isolation deliberately, and a permanent offer to
  // undo the posture you picked is nagging. The migration stays reachable from
  // the Config screen whenever mode is `own` — this hides the banner, not the
  // feature.
  if (input.profile === "paranoid") {
    return { ...base, eligible: false, reason: "profile-paranoid" };
  }

  let pendingChats = 0;
  let pendingProjects = 0;
  let scanned = 0;
  try {
    for (const project of input.projects) {
      scanned++;
      const chatsDir = projectChatsDir(project.dir);
      const key = `${await dirKey(chatsDir)}|${input.configVersion ?? "-"}`;
      const cached = probeCache.get(project.slug);
      let entry: ProbeCacheEntry;
      if (cached && cached.key === key) {
        entry = cached;
      } else {
        const read = await readChatsDir(chatsDir);
        const listing = read && "listing" in read ? read.listing : null;
        entry = {
          key,
          pending: listing !== null && listing.entryCount > 0,
          chats: listing?.chats.length ?? 0,
        };
        probeCache.set(project.slug, entry);
      }
      if (entry.pending) {
        pendingProjects++;
        pendingChats += entry.chats;
      }
    }
  } catch {
    return { ...base, scannedProjects: scanned, eligible: false, reason: "scan-failed" };
  }

  return {
    ...base,
    scannedProjects: scanned,
    pendingChats,
    pendingProjects,
    eligible: pendingProjects > 0,
    ...(pendingProjects > 0 ? {} : { reason: "nothing-pending" as const }),
  };
}

/* -------------------------------------------------------------------------- */
/* transcript reads                                                            */
/* -------------------------------------------------------------------------- */

/** The last `bytes` of `file` ending at `end`, and whether that reached byte 0. */
async function readWindow(
  file: string,
  end: number,
  bytes: number,
): Promise<{ text: string; whole: boolean }> {
  const take = Math.min(bytes, end);
  const start = end - take;
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(take);
    await handle.read(buf, 0, take, start);
    return { text: buf.toString("utf8"), whole: start === 0 };
  } finally {
    await handle.close();
  }
}

/** The `uuid` of the last record in `text`, walking backwards. */
function lastUuidIn(text: string, whole: boolean): string | undefined {
  const lines = text.split("\n");
  // A byte offset almost certainly landed mid-line; that fragment is the OLDEST
  // line in the window, so dropping it costs nothing.
  if (!whole) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: { uuid?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.uuid === "string" && rec.uuid.length > 0) return rec.uuid;
  }
  return undefined;
}

/**
 * The `uuid` of a transcript's last record — the thing the ancestor test asks
 * about. One 32 KB tail read, widened once for a transcript whose final record
 * is a multi-megabyte tool result.
 */
async function lastRecordUuid(file: string, size: number): Promise<string | undefined> {
  if (size === 0) return undefined;
  try {
    const near = await readWindow(file, size, TAIL_WINDOW_BYTES);
    const found = lastUuidIn(near.text, near.whole);
    if (found !== undefined || near.whole) return found;
    const far = await readWindow(file, size, WIDE_TAIL_BYTES);
    return lastUuidIn(far.text, far.whole);
  } catch {
    return undefined;
  }
}

/**
 * Stage 2: does `uuid` appear in a 32 KB window of `file` ENDING at byte
 * `offset`?
 *
 * This is the measurement the whole cost model rests on. A transcript is
 * append-only, so if the shorter file really is an ancestor of this one, its
 * last record ends exactly at byte `shorter.size` here — the uuid is at a known
 * offset, and finding it needs a read of one window rather than a scan of the
 * file. 298/300 hits and zero misses over the real corpus (design §0.3); the
 * two non-hits were files whose final record exceeded the window, which fall
 * through to stage 3 and are classified correctly there.
 */
async function probeAtOffset(file: string, uuid: string, offset: number): Promise<boolean> {
  if (offset <= 0) return false;
  try {
    const { text } = await readWindow(file, offset, PROBE_WINDOW_BYTES);
    return text.includes(uuid);
  } catch {
    return false;
  }
}

/**
 * Stage 3: raw chunked substring scan. No JSON parsing — the question is only
 * "does this uuid occur anywhere", and parsing 256 MB to answer it would cost
 * several times the read.
 *
 * Chunks overlap by the needle's length so a uuid straddling a boundary is
 * still found.
 */
async function fullScanFor(file: string, uuid: string): Promise<boolean> {
  const stream = createReadStream(file, {
    encoding: "utf8",
    highWaterMark: SCAN_CHUNK_BYTES,
  });
  let carry = "";
  try {
    for await (const chunk of stream) {
      const text = carry + (chunk as string);
      if (text.includes(uuid)) return true;
      carry = text.slice(-uuid.length);
    }
  } catch {
    return false;
  } finally {
    stream.destroy();
  }
  return false;
}

/**
 * Parse a transcript for the comparison columns: how many real messages it
 * holds and when the last one was. Same `isConversation` rule as the chat
 * list's ordering (#863), imported rather than re-stated — a second copy of
 * that rule would drift and the two numbers would disagree on screen.
 */
async function readSideDetail(
  file: string,
): Promise<{ messageCount: number; lastMessageAt?: string }> {
  let messageCount = 0;
  let lastMessageAt: string | undefined;
  const stream = createReadStream(file, { encoding: "utf8" });
  let carry = "";
  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let rec: {
      timestamp?: unknown;
      type?: unknown;
      isMeta?: unknown;
      origin?: { kind?: unknown };
    };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isConversationRecord(rec)) return;
    messageCount++;
    const ts = rec.timestamp;
    if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) lastMessageAt = ts;
  };
  try {
    for await (const chunk of stream) {
      const parts = (carry + (chunk as string)).split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) consume(line);
    }
    consume(carry);
  } catch {
    /* a partial count is still better than none */
  } finally {
    stream.destroy();
  }
  return lastMessageAt === undefined ? { messageCount } : { messageCount, lastMessageAt };
}

/* -------------------------------------------------------------------------- */
/* the plan                                                                    */
/* -------------------------------------------------------------------------- */

/** A conflicted pair that stage 2 could not settle, deferred to stage 3. */
interface ScanCandidate {
  row: MigrationChatRow;
  /** Path of the longer side — the one that would be scanned. */
  longerPath: string;
  longerBytes: number;
  shorterPath: string;
  shorterBytes: number;
  /** Which side is longer, i.e. which would be `ahead` on a hit. */
  longerSide: "own" | "host";
  /** The ancestor-candidate uuid, or undefined when the tail read found none. */
  uuid?: string;
}

async function sideOf(file: string): Promise<MigrationSide | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  return { path: file, sizeBytes: st.size, mtime: st.mtime.toISOString() };
}

/**
 * Build the modal's plan: every chat in every project's `.chats/`, classified
 * against its host store.
 *
 * Chats identical on both sides are omitted from the rows — there is no
 * decision to make — but they are counted in `totals.identical` so a row count
 * lower than the user's chat total always has an explanation. They still
 * migrate: the postcondition is about `.chats/` being empty, not about which
 * chats the user picked.
 */
export async function buildMigrationPlan(input: MigrationInput): Promise<MigrationPlan> {
  const warnings: MigrationWarning[] = [];
  const projects: MigrationProjectPlan[] = [];
  const candidates: ScanCandidate[] = [];
  let identical = 0;

  if (input.envShadowed) {
    warnings.push({
      code: "env-shadowed",
      message:
        `${TRANSCRIPTS_ENV_VAR} is set in the environment, which overrides the config ` +
        `file. Writing claude.transcripts: host would have no effect until it is unset.`,
    });
  }

  for (const project of input.projects) {
    const chatsDir = projectChatsDir(project.dir);
    const hostStore = encodedTranscriptDir(input.userHome, project.workingDir);
    const read = await readChatsDir(chatsDir);
    if (read === null) continue;
    if ("error" in read) {
      warnings.push({
        code: "chats-dir-unreadable",
        slug: project.slug,
        message: `Could not read ${chatsDir}: ${read.error.message}`,
        paths: [chatsDir],
      });
      continue;
    }
    const listing = read.listing;
    if (listing.entryCount === 0) continue;

    // Stage 0's other half. ENOENT is the normal case — the user has never run
    // `claude` in this directory — and means every chat is `new`.
    let hostEntries: string[] | null = [];
    try {
      hostEntries = await fs.readdir(hostStore);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        hostEntries = [];
      } else {
        // We cannot tell `new` from `diverged` without this. Reporting every
        // chat as `new` would default them all to CHECKED on the strength of a
        // read that failed, so the rows go to `unknown` instead — which already
        // means "not settled" and already defaults to unchecked.
        hostEntries = null;
        warnings.push({
          code: "host-store-unreadable",
          slug: project.slug,
          message:
            `Could not read ${hostStore}: ${e.message}. Every chat in this project is ` +
            `reported as \`unknown\` because new and diverged cannot be told apart ` +
            `without it.`,
          paths: [hostStore],
        });
      }
    }
    const hostChats = new Set(
      (hostEntries ?? [])
        .filter((n) => n.endsWith(".jsonl") && SESSION_ID_RE.test(n.slice(0, -6)))
        .map((n) => n.slice(0, -6)),
    );

    // `.reverts/` is shared across sessions (`herdctl.ts:1988`), so a partial
    // migration has to split it by prefix. One readdir, grouped once.
    const revertsByChat = new Map<string, string[]>();
    if (listing.hasReverts) {
      const revertsDir = path.join(chatsDir, ".reverts");
      const chatIds = new Set(listing.chats);
      for (const name of await fs.readdir(revertsDir).catch(() => [] as string[])) {
        // `<id>-<stamp>.jsonl`, where the id itself contains dashes. Resolved by
        // testing each dash position against the ids actually present rather
        // than by assuming a 36-char UUID — session ids are only guaranteed to
        // match `[A-Za-z0-9._-]+`, and a fixed offset silently mis-files every
        // revert belonging to a chat named anything else.
        const owner = ownerOfRevert(name, chatIds);
        if (owner === undefined) {
          // A revert for a chat that is no longer here. It still has to move —
          // the postcondition is about the directory, not about the rows.
          listing.projectExtras.push(path.join(revertsDir, name));
          continue;
        }
        const list = revertsByChat.get(owner) ?? [];
        list.push(path.join(revertsDir, name));
        revertsByChat.set(owner, list);
      }
    }

    if (listing.hasMemory) {
      await collectMemoryCollisions(chatsDir, hostStore, project.slug, warnings);
    }
    if (listing.unexpected.length > 0) {
      warnings.push({
        code: "unexpected-entries",
        slug: project.slug,
        message:
          `${listing.unexpected.length} ` +
          (listing.unexpected.length === 1 ? "entry" : "entries") +
          ` in ${chatsDir}: neither a transcript nor a known sidecar. Still migrated — ` +
          `\`.chats/\` has to end up empty for the redirect symlink to be planted — and ` +
          `named here rather than moving unannounced.`,
        paths: listing.unexpected,
      });
    }

    const rows: MigrationChatRow[] = [];
    for (const sessionId of listing.chats.sort()) {
      const ownPath = path.join(chatsDir, `${sessionId}.jsonl`);
      const own = await sideOf(ownPath);
      if (!own) continue; // vanished between readdir and stat

      const extras: string[] = [];
      if (listing.chatDirs.has(sessionId)) {
        const dir = path.join(chatsDir, sessionId);
        const kids = await fs.readdir(dir).catch(() => [] as string[]);
        extras.push(...(kids.length ? kids.map((k) => path.join(dir, k)) : [dir]));
      }
      extras.push(...(revertsByChat.get(sessionId) ?? []));

      const meta = input.names?.get(sessionId);
      const row: MigrationChatRow = {
        sessionId,
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.preview ? { preview: meta.preview } : {}),
        state: "new",
        defaultSelected: true,
        own,
        extras,
      };

      if (hostEntries === null) {
        row.state = "unknown";
        row.defaultSelected = false;
        rows.push(row);
        continue;
      }
      if (!hostChats.has(sessionId)) {
        rows.push(row); // `new` — settled with no stat of the other side, no read
        continue;
      }

      const host = await sideOf(path.join(hostStore, `${sessionId}.jsonl`));
      if (!host) {
        rows.push(row);
        continue;
      }
      row.host = host;

      // Stage 1.
      if (own.sizeBytes === host.sizeBytes) {
        if (own.mtime === host.mtime) {
          identical++;
          continue;
        }
        // Same length, different mtime. Append-only means an ancestor is
        // strictly shorter unless it is the same content, so one tail read each
        // settles it without any scan: same last uuid ⇒ same file.
        const [a, b] = await Promise.all([
          lastRecordUuid(own.path, own.sizeBytes),
          lastRecordUuid(host.path, host.sizeBytes),
        ]);
        if (a !== undefined && a === b) {
          identical++;
          continue;
        }
        row.state = "diverged";
        row.defaultSelected = false;
        candidates.push({
          row,
          longerPath: own.path,
          longerBytes: own.sizeBytes,
          shorterPath: host.path,
          shorterBytes: host.sizeBytes,
          longerSide: "own",
          uuid: undefined, // already settled; queued only for its detail columns
        });
        rows.push(row);
        continue;
      }

      const ownLonger = own.sizeBytes > host.sizeBytes;
      const longer = ownLonger ? own : host;
      const shorter = ownLonger ? host : own;

      // Stage 2 — the bounded probe at the known offset.
      const uuid = await lastRecordUuid(shorter.path, shorter.sizeBytes);
      if (uuid !== undefined && (await probeAtOffset(longer.path, uuid, shorter.sizeBytes))) {
        row.state = "fast-forward";
        row.defaultSelected = true;
        row.ahead = ownLonger ? "own" : "host";
        rows.push(row);
        continue;
      }

      // Stage 3, deferred: it is the only unbounded read in the classifier, so
      // the candidates are collected and run smallest-first against a shared
      // budget rather than each one spending whatever it likes.
      row.state = "diverged";
      row.defaultSelected = false;
      candidates.push({
        row,
        longerPath: longer.path,
        longerBytes: longer.sizeBytes,
        shorterPath: shorter.path,
        shorterBytes: shorter.sizeBytes,
        longerSide: ownLonger ? "own" : "host",
        uuid,
      });
      rows.push(row);
    }

    if (rows.length > 0 || listing.projectExtras.length > 0) {
      projects.push({
        slug: project.slug,
        name: project.name,
        chatsDir,
        hostStore,
        preserveDir: path.join(project.dir, PRESERVE_DIR_NAME),
        chats: rows,
        projectExtras: listing.projectExtras,
      });
    }
  }

  const scanBudgetExhausted = await settleCandidates(
    candidates,
    input.scanBudgetBytes ?? DIVERGENCE_SCAN_BUDGET_BYTES,
  );

  const totals: MigrationTotals = {
    chats: 0,
    new: 0,
    fastForward: 0,
    diverged: 0,
    unknown: 0,
    identical,
    defaultSelected: 0,
  };
  for (const p of projects) {
    for (const c of p.chats) {
      totals.chats++;
      if (c.state === "new") totals.new++;
      else if (c.state === "fast-forward") totals.fastForward++;
      else if (c.state === "diverged") totals.diverged++;
      else totals.unknown++;
      if (c.defaultSelected) totals.defaultSelected++;
    }
  }

  return {
    mode: input.mode,
    configPath: input.configPath,
    configVersion: input.configVersion,
    projects,
    sweepers: await countSweepers(input),
    totals,
    scanBudgetExhausted,
    warnings,
  };
}

/**
 * Stage 3 over the deferred candidates, smallest-first against one shared
 * budget. Ascending order means the budget settles as many rows as it can
 * before it runs out, and — because it is ascending — the first row that does
 * not fit proves every later one does not either.
 *
 * Returns whether any row came back `unknown`.
 */
async function settleCandidates(
  candidates: ScanCandidate[],
  budgetBytes: number,
): Promise<boolean> {
  let remaining = budgetBytes;
  let exhausted = false;
  candidates.sort((a, b) => a.longerBytes - b.longerBytes);

  for (const c of candidates) {
    if (c.uuid !== undefined) {
      if (remaining < c.longerBytes) {
        exhausted = true;
        c.row.state = "unknown";
        c.row.defaultSelected = false;
        continue;
      }
      remaining -= c.longerBytes;
      if (await fullScanFor(c.longerPath, c.uuid)) {
        // A rewritten history: the ancestor's tip is in there, just not where
        // an append-only file would have put it. Still lossless.
        c.row.state = "fast-forward";
        c.row.defaultSelected = true;
        c.row.ahead = c.longerSide;
        continue;
      }
    }

    // Confirmed diverged. The comparison columns are what makes the user's
    // choice informed, and they cost a parse of both sides — charged to the
    // same budget, and simply omitted when it will not stretch. An absent
    // `messageCount` is a legitimate answer meaning "we stopped reading".
    const detailCost = c.longerBytes + c.shorterBytes;
    if (remaining < detailCost) {
      exhausted = true;
      continue;
    }
    remaining -= detailCost;
    const [ownDetail, hostDetail] = await Promise.all([
      readSideDetail(c.row.own.path),
      c.row.host ? readSideDetail(c.row.host.path) : Promise.resolve(null),
    ]);
    Object.assign(c.row.own, ownDetail);
    if (c.row.host && hostDetail) Object.assign(c.row.host, hostDetail);
  }
  return exhausted;
}

/**
 * `memory/` is merged at FILE granularity and never overwrites anything in the
 * user's real `~/.claude` (§10.2). This PR only reads, but the collisions have
 * to be surfaced now: `memory/MEMORY.md` is a single well-known path, so on the
 * machines this feature is aimed at a collision is the COMMON case — and the
 * skip-if-present rule the transcripts use would leave `memory/` sitting in
 * `.chats/`, fail the postcondition, and block the flip for the whole project.
 */
async function collectMemoryCollisions(
  chatsDir: string,
  hostStore: string,
  slug: string,
  warnings: MigrationWarning[],
): Promise<void> {
  const from = path.join(chatsDir, "memory");
  const to = path.join(hostStore, "memory");
  const collisions: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs
      .readdir(path.join(from, rel), { withFileTypes: true })
      .catch(() => [] as never[]);
    for (const e of entries) {
      const next = path.join(rel, e.name);
      if (e.isDirectory()) {
        await walk(next);
        continue;
      }
      const dest = path.join(to, next);
      if (await fs.lstat(dest).then(() => true).catch(() => false)) {
        collisions.push(path.join(from, next), dest);
      }
    }
  };
  await walk("");
  if (collisions.length === 0) return;
  warnings.push({
    code: "memory-collision",
    slug,
    message:
      `${collisions.length / 2} agent-memory file(s) already exist in the host store. ` +
      `Nothing in your own ~/.claude is ever overwritten: Paddock's copies are set ` +
      `aside under ${path.join(path.dirname(chatsDir), PRESERVE_DIR_NAME, "memory")} ` +
      `for you to merge by hand.`,
    paths: collisions,
  });
}

/**
 * Sweeper stores (`<dataDir>/sweepers/<slug>/.chats`), which get their own
 * redirect symlink exactly like a project's and would be split by a
 * project-only migration. Migrated silently with their project — no rows, no
 * user choice (#882) — so they are reported as counts alone.
 */
async function countSweepers(input: MigrationInput): Promise<{ stores: number; chats: number }> {
  let stores = 0;
  let chats = 0;
  for (const dir of input.sweeperDirs?.values() ?? []) {
    const read = await readChatsDir(projectChatsDir(dir));
    if (read === null || "error" in read || read.listing.entryCount === 0) continue;
    stores++;
    chats += read.listing.chats.length;
  }
  return { stores, chats };
}
