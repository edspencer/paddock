/**
 * Scratch → root re-home (issue #516, Phase 6 — step 1 of 2).
 *
 * Since Phase 3, an instance that HAS a root project serves root chats at
 * `/chat`. That is the URL scratch/one-off chats used to occupy, so on such an
 * instance every existing scratch chat became UI-unreachable overnight — its
 * transcript is still on disk, but nothing routes to it. This migration owes
 * those chats a home before Phase 6's second step deletes the code that could
 * still, in principle, reach them.
 *
 * ## Why this is a startup migration
 *
 * The sidecar stores (`ArchiveStore`, `StarStore`, `ReadStateStore`,
 * `UnreadStore`, `QueuedMessageStore`) each load their whole map into memory on
 * first use and then `persist()` by serialising that map OVER the file. So
 * hand-editing a sidecar under a running instance is erased by the next write.
 * The rewrite has to happen while the server owns the process and before any
 * store has loaded — i.e. at boot, which is what {@link migrateScratchToRoot}
 * is and where `app.ts` calls it from.
 *
 * ## What it does, and what it deliberately does NOT do
 *
 * **Purely additive.** It COPIES transcripts into `<projectsRoot>/.chats/` and
 * ADDS re-keyed sidecar entries alongside the originals. It never moves, never
 * deletes, and never overwrites. `<dataDir>/scratch/` is left byte-for-byte
 * intact, which is the whole point of shipping this ahead of the deletion: if
 * the migration turns out to be wrong, the source data is still there and the
 * scratch routes are still in the build. (`.chats/` is gitignored instance-wide
 * and per-project, and `git ls-files` finds zero tracked transcripts — these
 * files are the only copy, so "never delete" is not paranoia.)
 *
 * The leftover `scratch\0<id>` sidecar keys are inert once no `scratch` agent
 * exists; they cost a few hundred bytes and buy a trivial rollback.
 *
 * **Gated on the root project existing.** With no `<projectsRoot>/project.yaml`
 * there is no root project, `/chat` still serves scratch, and nothing is
 * unreachable — so there is nothing to migrate and this is a no-op. That
 * matches the "gate on existence" decision the rest of #516 is built on.
 *
 * **Idempotent.** Safe to run on every boot: a transcript already present at
 * the destination is skipped, and a sidecar key that already exists in its
 * re-keyed form is skipped. No marker file, no version stamp — the destination
 * state IS the marker, which is the same trick #488's read-state backfill uses.
 *
 * ## The risk that had to be tested, and the result
 *
 * A re-homed transcript's recorded `cwd` still says the scratch dir, while the
 * root keeper resumes it from `projectsRoot`. Paddock already leans on Claude
 * Code tolerating recorded-cwd ≠ process-cwd (that is what `promoteScratchSession`
 * does), but that path rewrites the `cwd` field as it copies, so it was a
 * near-miss precedent rather than proof. **Verified empirically on a throwaway
 * copy before this landed:** a scratch transcript recording
 * `cwd: /var/lib/paddock/scratch`, copied to an unrelated directory and resumed
 * from there, resumed cleanly AND recalled a codeword from its pre-move turns.
 * Claude Code keys resume on the transcript's location, not its recorded `cwd`.
 * So this migration does not rewrite `cwd`, and does not need to.
 *
 * ## Correction to the design doc: transcripts + sidecars are NOT enough
 *
 * `DESIGN-root-as-project.md` lists the work as "copy the transcripts, re-key
 * five sidecars, two need no touch". Doing exactly that produces a chat list
 * with **zero** entries in it, verified on a copy of the live data. The missing
 * piece is herdctl's own **session attribution index**, built from the
 * `job-*.yaml` records in `<stateDir>/jobs/`: a session is listed under the
 * agent its job records name, and a re-homed chat's records still say `scratch`.
 * `promoteScratchSession` has always had to do this (`reattributeSession`); the
 * design doc simply did not carry it over.
 *
 * That one step is not purely additive, and it cannot be. herdctl assembles the
 * index by iterating job files in completion order and letting the last writer
 * win, so adding a `keeper-__root` record ALONGSIDE the `scratch` ones attributes
 * the session nondeterministically — which is precisely why `reattributeSession`
 * rewrites records rather than appending one. So the migration rewrites the
 * `agent` field of the scratch records it owns.
 *
 * The cost is bounded and, on an instance that qualifies for this migration,
 * zero in practice: those chats are already UI-unreachable via scratch (that is
 * the problem being fixed), and job records are derived metadata — the
 * transcripts, which are the only irreplaceable artifact here, are still in both
 * places. Only records whose agent is exactly `scratch` AND whose session was
 * re-homed are touched; every other agent's history is untouched.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { SCRATCH_AGENT, keeperAgentName } from "./herdctl-agent-names.js";
import { writeAgentAdoptionJob } from "./herdctl-jobs.js";
import { ROOT_SLUG } from "./project-paths.js";

/** Separator in every sidecar storage key; a NUL occurs in no segment. */
const KEY_SEP = "\u0000";

/** The agent name scratch chats are re-keyed ONTO. */
export const ROOT_AGENT = keeperAgentName(ROOT_SLUG);

/**
 * Sidecar files whose keys carry an agent segment and therefore need rewriting.
 *
 * `run-provenance.json` and `message-provenance.json` are deliberately absent:
 * both key on the bare session id, so a re-homed chat keeps its provenance for
 * free. Touching them would be a no-op at best and a corruption risk at worst.
 */
const SIDECARS: ReadonlyArray<{ file: string; shape: "array" | "object" }> = [
  { file: "archive-state.json", shape: "array" },
  { file: "star-state.json", shape: "array" },
  { file: "read-state.json", shape: "object" },
  { file: "unread-state.json", shape: "array" },
  { file: "queued-message.json", shape: "object" },
];

/**
 * Rewrite the AGENT segment of a sidecar key from `scratch` to the root keeper,
 * returning `null` when the key is not a scratch key and needs no change.
 *
 * The subtlety worth spelling out: these five files do NOT share one key arity.
 * `archive`/`star`/`queued` are `<agent>\0<sessionId>`, but `read-state` and
 * `unread` are `<user>\0<agent>\0<sessionId>` when a user identity is present
 * and `<agent>\0<sessionId>` when it is not (`none`-mode's shared bucket). So a
 * `startsWith("scratch\0")` test silently misses every user-keyed entry — which
 * is most of them on any authenticated instance.
 *
 * What IS invariant across all five, and both arities, is that **the agent is
 * the second-to-last segment**. Matching on position rather than prefix handles
 * two- and three-segment keys with one rule and no special cases.
 */
export function rekeyScratchKey(key: string): string | null {
  const parts = key.split(KEY_SEP);
  if (parts.length < 2) return null;
  const agentIdx = parts.length - 2;
  if (parts[agentIdx] !== SCRATCH_AGENT) return null;
  parts[agentIdx] = ROOT_AGENT;
  return parts.join(KEY_SEP);
}

/** Per-run tally, returned for logging and asserted on in tests. */
export interface ScratchMigrationResult {
  /** False when the migration was skipped entirely (no root project, no scratch). */
  ran: boolean;
  /** Why it was skipped, for the boot log. */
  skipped?: "no-root-project" | "no-scratch-chats" | "same-dir";
  /** Transcript entries copied into `<projectsRoot>/.chats/` this run. */
  copied: number;
  /** Transcript entries already present at the destination (left untouched). */
  alreadyPresent: number;
  /** Re-keyed sidecar entries added this run, by file. Absent files are omitted. */
  rekeyed: Record<string, number>;
  /**
   * herdctl job RECORDS rewritten from `scratch` to the root keeper. A chat
   * writes one record per turn, so this is >= the number of sessions affected.
   */
  reattributed: number;
  /** Sessions with no job record at all, given a synthesized adoption record. */
  adopted: number;
  /** Sidechain (subagent) transcripts, copied but never attributed — they are not chats. */
  sidechains: number;
}

export interface ScratchMigrationOptions {
  /** Where the sidecar JSON files live (`cfg.dataDir`). */
  dataDir: string;
  /** The scratch agent's working dir (`cfg.scratchDir`); its `.chats/` is the source. */
  scratchDir: string;
  /** `cfg.projectsRoot` — the root project's dir; its `.chats/` is the destination. */
  projectsRoot: string;
  /** `cfg.stateDir` — holds herdctl's `jobs/` attribution records. */
  stateDir: string;
  /** Whether `<projectsRoot>/project.yaml` resolved. False ⇒ no-op. */
  hasRootProject: boolean;
  /** Optional pino-ish logger; the migration is best-effort and never throws. */
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    debug: (obj: unknown, msg?: string) => void;
  };
}

/**
 * Copy scratch transcripts into the root project's `.chats/`, add re-keyed
 * copies of their sidecar state, and point their herdctl job records at the
 * root keeper so the chats actually list. No transcript is moved or deleted and
 * no existing sidecar value is overwritten.
 *
 * Best-effort: a failure on any single file is logged and skipped rather than
 * thrown, so a half-readable sidecar can never stop the server from booting.
 */
export async function migrateScratchToRoot(
  opts: ScratchMigrationOptions,
): Promise<ScratchMigrationResult> {
  const { dataDir, scratchDir, projectsRoot, stateDir, hasRootProject, logger } = opts;
  const empty: ScratchMigrationResult = {
    ran: false,
    copied: 0,
    alreadyPresent: 0,
    rekeyed: {},
    reattributed: 0,
    adopted: 0,
    sidechains: 0,
  };

  // Gate on existence, exactly as the rest of #516 does: without a root project
  // `/chat` still serves scratch, so nothing is stranded and nothing should move.
  if (!hasRootProject) return { ...empty, skipped: "no-root-project" };

  const fromDir = path.join(scratchDir, ".chats");
  const toDir = path.join(projectsRoot, ".chats");

  // `realpath` rather than a string compare: a symlinked scratch dir pointing at
  // the root's own `.chats/` would otherwise make this copy a directory onto
  // itself. Resolve both; a missing source just means there is nothing to do.
  const fromReal = await fs.realpath(fromDir).catch(() => null);
  if (!fromReal) return { ...empty, skipped: "no-scratch-chats" };
  const toReal = await fs.realpath(toDir).catch(() => null);
  if (toReal && toReal === fromReal) return { ...empty, skipped: "same-dir" };

  const result: ScratchMigrationResult = { ...empty, ran: true };

  // --- transcripts -------------------------------------------------------
  // Mirrors `ensureProjectChats`'s existing in-repo migration (cp, skip-if-present)
  // MINUS its `fs.rm` of the source. `cp` recursively so the scratch agent's
  // `memory/` dir travels with its chats; `fs.cp` is used rather than `rename`
  // because the two dirs can sit on different mounts (rename would EXDEV).
  const rehomed: string[] = [];
  try {
    await fs.mkdir(toDir, { recursive: true });
    for (const entry of await fs.readdir(fromReal)) {
      const from = path.join(fromReal, entry);
      const to = path.join(toDir, entry);
      const exists = await fs
        .lstat(to)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        result.alreadyPresent += 1;
      } else {
        try {
          await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
          result.copied += 1;
        } catch (err) {
          logger?.warn({ err, entry }, "scratch migration: could not copy transcript");
          continue;
        }
      }
      // Attribution is re-derived for everything at the destination, not just
      // what this run copied: an interrupted earlier run could have copied a
      // transcript and died before writing its job record.
      if (entry.endsWith(".jsonl")) rehomed.push(entry.slice(0, -".jsonl".length));
    }
  } catch (err) {
    logger?.warn({ err }, "scratch migration: transcript copy failed");
  }

  // --- sidecar state -----------------------------------------------------
  for (const { file, shape } of SIDECARS) {
    try {
      const added = await rekeySidecar(path.join(dataDir, file), shape);
      if (added > 0) result.rekeyed[file] = added;
    } catch (err) {
      logger?.warn({ err, file }, "scratch migration: could not re-key sidecar");
    }
  }

  // --- herdctl attribution ------------------------------------------------
  try {
    Object.assign(result, await attributeToRoot(stateDir, toDir, rehomed, logger));
  } catch (err) {
    logger?.warn({ err }, "scratch migration: could not re-attribute sessions");
  }

  return result;
}

/**
 * Whether a transcript is a SIDECHAIN (subagent) transcript rather than a chat.
 *
 * These are named `agent-<id>.jsonl` in practice but the reliable marker is the
 * `isSidechain` flag on the first record, which is what herdctl's own discovery
 * keys on. They are copied like everything else — a re-homed chat's subagent
 * detail panes read them — but they are not sessions and must never be given a
 * job record, or the chat list fills with rows that resolve to nothing.
 *
 * On the instance this was written for, 27 of the 34 scratch transcripts are
 * sidechains and only 7 are chats. Worth knowing before reading "34 transcripts"
 * as "34 chats".
 */
async function isSidechainTranscript(file: string): Promise<boolean> {
  try {
    const head = await fs.readFile(file, "utf8");
    const first = head.slice(0, head.indexOf("\n") === -1 ? undefined : head.indexOf("\n"));
    if (!first.trim()) return false;
    return (JSON.parse(first) as { isSidechain?: unknown }).isSidechain === true;
  } catch {
    return false;
  }
}

/** A session id herdctl is willing to key on — mirrors `run-provenance`'s guard. */
function isSafeId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId);
}

/**
 * Point herdctl's session attribution at the root keeper for every re-homed
 * chat. See the module header for why this is a rewrite rather than an append.
 *
 * Scoped as tightly as the job allows: a record is rewritten only when its
 * `session_id` is one we re-homed AND its `agent` is exactly `scratch`. A
 * session with no records at all (never resumed under paddock's own job
 * bookkeeping) gets a synthesized adoption record, the same path
 * `reattributeSession` uses for a transcript migrated in from outside.
 */
async function attributeToRoot(
  stateDir: string,
  chatsDir: string,
  sessionIds: string[],
  logger?: ScratchMigrationOptions["logger"],
): Promise<Pick<ScratchMigrationResult, "reattributed" | "adopted" | "sidechains">> {
  const out = { reattributed: 0, adopted: 0, sidechains: 0 };

  const chats: string[] = [];
  for (const id of sessionIds) {
    if (!isSafeId(id)) continue;
    if (await isSidechainTranscript(path.join(chatsDir, `${id}.jsonl`))) {
      out.sidechains += 1;
      continue;
    }
    chats.push(id);
  }
  if (chats.length === 0) return out;

  const wanted = new Set(chats);
  const seen = new Set<string>();
  const jobsDir = path.join(stateDir, "jobs");
  const entries = await fs.readdir(jobsDir).catch(() => [] as string[]);

  for (const name of entries) {
    if (!name.endsWith(".yaml")) continue;
    const file = path.join(jobsDir, name);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> | null;
    } catch {
      continue; // unreadable / half-written record — leave it exactly as-is
    }
    const sid = parsed?.session_id;
    if (typeof sid !== "string" || !wanted.has(sid)) continue;
    // Already migrated, or belongs to some other agent entirely — either way,
    // not ours to rewrite. Both count as "attributed" so no adoption record is
    // synthesized on top.
    if (parsed?.agent === ROOT_AGENT) {
      seen.add(sid);
      continue;
    }
    if (parsed?.agent !== SCRATCH_AGENT) continue;
    parsed.agent = ROOT_AGENT;
    try {
      await fs.writeFile(file, YAML.stringify(parsed), "utf8");
      seen.add(sid);
      out.reattributed += 1;
    } catch (err) {
      logger?.warn({ err, file }, "scratch migration: could not rewrite job record");
    }
  }

  for (const id of chats) {
    if (seen.has(id)) continue;
    try {
      const st = await fs.stat(path.join(chatsDir, `${id}.jsonl`)).catch(() => null);
      await writeAgentAdoptionJob(stateDir, id, ROOT_AGENT, st ? st.mtime : new Date());
      out.adopted += 1;
    } catch (err) {
      logger?.warn({ err, sessionId: id }, "scratch migration: could not adopt session");
    }
  }

  return out;
}

/**
 * Add root-keyed copies of every scratch-keyed entry in one sidecar file.
 * Returns the number of entries added (0 when the file is missing, corrupt, or
 * already migrated). Leaves the original keys in place — see the module header.
 */
async function rekeySidecar(file: string, shape: "array" | "object"): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return 0; // never written yet — nothing to re-key
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Every store is corruption-tolerant (a bad file just starts empty), so the
    // migration must be too: rewriting a file we could not parse would turn a
    // recoverable mess into a destroyed one.
    return 0;
  }

  if (shape === "array") {
    if (!Array.isArray(parsed)) return 0;
    const keys = parsed.filter((k): k is string => typeof k === "string");
    const present = new Set(keys);
    const additions: string[] = [];
    for (const key of keys) {
      const next = rekeyScratchKey(key);
      // Skip-if-present is what makes a re-run a no-op. Session ids are UUIDs,
      // so a destination key can realistically only exist because this already ran.
      if (next && !present.has(next)) {
        additions.push(next);
        present.add(next);
      }
    }
    if (additions.length === 0) return 0;
    await writeJson(file, [...keys, ...additions]);
    return additions.length;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const obj = parsed as Record<string, unknown>;
  const additions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const next = rekeyScratchKey(key);
    if (next && !(next in obj)) additions[next] = value;
  }
  const count = Object.keys(additions).length;
  if (count === 0) return 0;
  await writeJson(file, { ...obj, ...additions });
  return count;
}

/**
 * Write a sidecar atomically (tmp + rename) with the restrictive mode the
 * user-scoped sidecars already use. `read-state`/`unread`/`queued` are written
 * `0o600` by their stores; applying it uniformly can only tighten a file, never
 * loosen one, and these are all low-sensitivity single-user state.
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.migrate.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}
