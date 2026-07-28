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
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { SCRATCH_AGENT, keeperAgentName } from "./herdctl-agent-names.js";
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
}

export interface ScratchMigrationOptions {
  /** Where the sidecar JSON files live (`cfg.dataDir`). */
  dataDir: string;
  /** The scratch agent's working dir (`cfg.scratchDir`); its `.chats/` is the source. */
  scratchDir: string;
  /** `cfg.projectsRoot` — the root project's dir; its `.chats/` is the destination. */
  projectsRoot: string;
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
 * Copy scratch transcripts into the root project's `.chats/` and add re-keyed
 * copies of their sidecar state. Never moves, never deletes, never clobbers.
 *
 * Best-effort: a failure on any single file is logged and skipped rather than
 * thrown, so a half-readable sidecar can never stop the server from booting.
 */
export async function migrateScratchToRoot(
  opts: ScratchMigrationOptions,
): Promise<ScratchMigrationResult> {
  const { dataDir, scratchDir, projectsRoot, hasRootProject, logger } = opts;
  const empty: ScratchMigrationResult = { ran: false, copied: 0, alreadyPresent: 0, rekeyed: {} };

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

  const result: ScratchMigrationResult = { ran: true, copied: 0, alreadyPresent: 0, rekeyed: {} };

  // --- transcripts -------------------------------------------------------
  // Mirrors `ensureProjectChats`'s existing in-repo migration (cp, skip-if-present)
  // MINUS its `fs.rm` of the source. `cp` recursively so the scratch agent's
  // `memory/` dir travels with its chats; `fs.cp` is used rather than `rename`
  // because the two dirs can sit on different mounts (rename would EXDEV).
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
        continue;
      }
      try {
        await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
        result.copied += 1;
      } catch (err) {
        logger?.warn({ err, entry }, "scratch migration: could not copy transcript");
      }
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

  return result;
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
