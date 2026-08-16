/**
 * The `own → host` transcript migration — the WRITE half (#882).
 *
 * `transcripts-migration.ts` answers "what would happen"; this does it. One
 * call, synchronous, no job id: measured at 24 ms of `rename` for 500 chats on
 * one filesystem (design §6), which is comfortably inside a request and does
 * not justify inventing the codebase's first resumable job system.
 *
 * ## The ordering, and where the commit point is (§4.1)
 *
 *     1. single-flight guard        ─┐ in routes/transcripts.ts: they need the
 *     2. expectedVersion check       │ hub, and a refusal must happen before
 *     3. quiesceProject × N         ─┘ this module is entered at all
 *     4. re-enumerate from disk     ─┐
 *     5. move, project by project    │ here
 *     6. write claude.transcripts    │  <-- THE COMMIT POINT
 *     7. respond                    ─┘
 *
 * Steps 1–3 live in the route because they are refusals: nothing may have moved
 * when they fire, and the cleanest way to guarantee that is for them to run
 * before the mover exists. Step 6 is a callback ({@link MigrationExecuteInput.commitConfig})
 * for the same reason in reverse — this module then has no opinion about YAML,
 * and a test can make the commit throw to prove step 5 is safe without it.
 *
 * **The config write is last and is deliberately the commit point.** Until it
 * lands nothing has semantically happened: the running server still resolves
 * `own`, and a partly-emptied `.chats/` is indistinguishable from the interim
 * blank-list state #882 already tells the user to expect. Re-running reconciles
 * it. The reverse order was rejected — a crash between a `host` config and files
 * still in `.chats/` is a genuine #708 split rather than a transient blank list.
 *
 * ## The survivor rule — NOT skip-if-present
 *
 * §4.2 made the move skip-if-present ("a destination that already exists is
 * never overwritten"). §5 requires `.chats/` to end up EMPTY. For any chat
 * present on both sides those deadlock: the destination exists, the move skips,
 * the file stays, `chatsDirEmpty: false`, the config is never written. On the
 * instance §10.1 describes — everything adopted from the CLI, nothing net-new —
 * that is *every* chat, and the migration cannot succeed at all. The feature
 * would fail hardest for the user it was designed around. Ruled on in #882 and
 * replaced by:
 *
 * > The copy that does **not** survive is moved to the preserve dir. The
 * > survivor ends up in the host store. `.chats/` ends empty. Nothing is ever
 * > deleted, and nothing in `~/.claude` is ever overwritten in place.
 *
 * | Row | Survivor | Where the other copy goes |
 * |---|---|---|
 * | `new` | Paddock's | — (nothing on the host side) |
 * | `identical` | the user's | Paddock's copy → preserve dir |
 * | `fast-forward`, host ahead | the user's | Paddock's ancestor → preserve dir |
 * | `fast-forward`, own ahead | Paddock's | the user's ancestor → preserve dir FIRST |
 * | `diverged`, ticked | Paddock's | the user's copy → preserve dir FIRST |
 * | `diverged`, unticked | the user's | Paddock's copy → preserve dir |
 *
 * The two rows that supersede a file in `~/.claude` move the superseded copy
 * out **before** the replacement lands — never an unlink, never an overwrite in
 * place. That ordering is the whole of "nothing is deleted", and it is not free:
 * POSIX `rename(2)` silently replaces an existing destination, so
 * `transcript-move.ts` refuses one rather than relying on callers to remember.
 *
 * Read as a decision the table collapses to four lines — see {@link disposition}.
 *
 * ## The postcondition is the contract, not the file list
 *
 * `pointChatsDirAt` (`transcripts.ts:145`) declines to plant the redirect
 * symlink if `.chats/` is a real directory holding **anything** — dotfiles
 * included. So the rule is not "move these artifact types" (an enumeration
 * fails open: whatever a future release starts writing into `.chats/` silently
 * breaks the flip) but "afterwards, `.chats/` contains nothing" — which fails
 * closed and is checkable in one `readdir`. Hence {@link drainChatsDir}: after
 * every planned move, anything still there is moved too, and any project still
 * reporting `chatsDirEmpty: false` blocks the config write for the whole
 * instance.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { type TranscriptsMode } from "./transcripts.js";
import {
  scanProject,
  settleCandidates,
  DIVERGENCE_SCAN_BUDGET_BYTES,
  TRANSCRIPTS_ENV_VAR,
  type MigrationChatRow,
  type MigrationInput,
  type MigrationProjectRef,
  type MigrationProjectScan,
  type MigrationState,
  type MigrationWarning,
} from "./transcripts-migration.js";
import {
  collectChatArtifacts,
  DestinationExistsError,
  moveEntry,
  pathExists,
  pruneEmptyTree,
  uniqueDestination,
} from "./transcript-move.js";

/* -------------------------------------------------------------------------- */
/* the wire shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why a copy ended up in the preserve dir rather than the host store.
 *
 * The design's enum was `["unchecked", "unplanned-diverged"]`, which only
 * covers the cases where the USER declined a chat. Once the skip-if-present
 * deadlock was replaced (see the module doc) three more became reachable, and
 * two of them are about the *host* side — so the item also carries `side`.
 * Collapsing them all into `unchecked` would tell a user their own terminal
 * transcript was "not ticked", which is both false and alarming.
 */
export type MigrationPreserveReason =
  /** The user did not tick it. Paddock's copy set aside; the user's survives. */
  | "unchecked"
  /** Appeared after the plan was built and classified `diverged`, so its own
   *  default (unchecked) was applied (§4.6). */
  | "unplanned-diverged"
  /** Byte-identical on both sides, so no choice was ever offered. Paddock's
   *  redundant copy is set aside rather than deleted. */
  | "identical"
  /** Fast-forward with the HOST side ahead: the user's copy is the descendant
   *  and survives, Paddock's ancestor is set aside. Lossless either way. */
  | "already-ahead"
  /** The user's copy was superseded by Paddock's and moved out of `~/.claude`
   *  BEFORE the replacement landed. The recovery path for a decision the user
   *  regrets. */
  | "superseded";

export interface MigrationPreservedChat {
  /**
   * The chat id — or, for an agent-memory file set aside by the `memory/`
   * merge, its path relative to the store (`memory/MEMORY.md`).
   *
   * A memory file is not a chat, and it is in this array anyway: this is the
   * one place the completion screen renders as "here is everything that was
   * set aside and where it went", and a recovery path with a hole in it is
   * worse than a slightly loose field name.
   */
  sessionId: string;
  slug: string;
  /** Which store the preserved copy came out of. */
  side: "own" | "host";
  /** Absolute path of the preserved transcript, as actually written. */
  path: string;
  reason: MigrationPreserveReason;
}

export type MigrationFailureReason =
  | "destination-exists"
  | "unreadable"
  | "move-failed"
  | "preserve-failed"
  | "unknown";

export interface MigrationFailure {
  sessionId: string;
  slug: string;
  reason: MigrationFailureReason;
  message?: string;
  /** The path the failure is about — disambiguates a project from its sweeper,
   *  which share a slug. */
  path?: string;
}

export interface MigrationUnplannedChat {
  sessionId: string;
  slug: string;
  state: MigrationState;
  action: "migrated" | "preserved";
}

export type MigrationProjectOutcome =
  | "migrated"
  | "nothing-to-do"
  | "skipped-busy"
  | "failed";

export interface MigrationProjectResult {
  slug: string;
  outcome: MigrationProjectOutcome;
  migrated: number;
  preserved: number;
  /**
   * Whether `<project.dir>/.chats/` is empty afterwards. FALSE IS A FAILURE:
   * the redirect symlink will not be planted on restart and the project will be
   * half-blind (#708). The config is not written while any project reports it.
   */
  chatsDirEmpty: boolean;
  error?: string;
}

export interface MigrationExecuteResult {
  ok: boolean;
  alreadyMigrated: boolean;
  dryRun: boolean;
  projects: MigrationProjectResult[];
  migrated: string[];
  preserved: MigrationPreservedChat[];
  unplanned: MigrationUnplannedChat[];
  /** Ids in the request that are not in any `.chats/`. Ignored, and named
   *  rather than silently dropped — the design says they are "reported under
   *  unknown" and then gives the 200 body nowhere to report them. */
  ignoredSessionIds: string[];
  failed: MigrationFailure[];
  sweepers: { stores: number; chats: number };
  /** Carried through from the scan. `memory-collision` in particular is
   *  REQUIRED by §10.2 and had nowhere to live in the design's 200 body. */
  warnings: MigrationWarning[];
  configWritten: boolean;
  configPath: string;
  configVersion?: string;
  restartRequired: boolean;
}

export interface MigrationExecuteInput extends MigrationInput {
  /** The chat ids the user TICKED. Everything else is preserved, not migrated. */
  sessionIds: string[];
  /**
   * Every id the plan the user was looking at contained.
   *
   * Without it §4.6 is unimplementable: "a chat created between preview and
   * submit" and "a chat the user deliberately unticked" are both "present on
   * disk and absent from `sessionIds`", and nothing in the design's request
   * body tells them apart. Optional — when omitted, every untricked chat is
   * treated as a deliberate choice and `unplanned` comes back empty.
   */
  plannedSessionIds?: string[];
  /** Report what WOULD happen; move nothing, write nothing. */
  dryRun?: boolean;
  /**
   * The transcripts mode a RESTART would resolve from the config FILE — NOT
   * `mode`, which is what this process froze at boot. They differ for the whole
   * window between a successful migration and the restart it asks for, which is
   * exactly the window a second POST arrives in.
   */
  pendingMode: TranscriptsMode;
  /**
   * §4.5's re-check: session ids with a live turn in `slug`, right now.
   *
   * `quiesceSession` stops what is running; it does not take a lock, so a fresh
   * turn can start between the quiesce and this project's own moves. Called
   * immediately before them, which narrows the window to microseconds without
   * inventing a fleet-wide turn lock (§10.3 ruled that out of scope for v1).
   */
  busySessions?: (slug: string) => string[];
  /** Write `claude.transcripts: host`; returns the new config fingerprint.
   *  Called ONCE, LAST, and only when every project reached the postcondition. */
  commitConfig: () => Promise<string | null>;
}

/* -------------------------------------------------------------------------- */
/* the mover — real, or a dry run that predicts rather than narrates           */
/* -------------------------------------------------------------------------- */

/**
 * Every filesystem mutation goes through one of these, so `dryRun` walks the
 * SAME decision code rather than a parallel description of it. A dry run that
 * re-implements the plan is a dry run that can disagree with the real thing,
 * which is the one property it must not have.
 */
interface Mover {
  readonly dry: boolean;
  exists(p: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  unique(dir: string, name: string): Promise<string>;
  pruneEmpty(dir: string): Promise<void>;
  /** `readdir(dir)` minus anything this mover has (really or virtually) moved. */
  remaining(dir: string): Promise<string[]>;
}

const realMover: Mover = {
  dry: false,
  exists: pathExists,
  move: moveEntry,
  unique: uniqueDestination,
  pruneEmpty: pruneEmptyTree,
  remaining: (dir) => fs.readdir(dir).catch(() => [] as string[]),
};

/**
 * The dry mover overlays a virtual filesystem on the real one: paths it has
 * "moved" read as gone, paths it has "created" read as present.
 *
 * Shallow by design — it tracks the exact paths it was handed, not their
 * subtrees — which is sound here because a chat's `<id>/` directory is moved
 * whole and nothing ever asks about a path inside one.
 */
class DryMover implements Mover {
  readonly dry = true;
  private readonly gone = new Set<string>();
  private readonly made = new Set<string>();

  async exists(p: string): Promise<boolean> {
    if (this.made.has(p)) return true;
    if (this.gone.has(p)) return false;
    return pathExists(p);
  }

  async move(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new DestinationExistsError(to);
    this.gone.add(from);
    this.made.delete(from);
    this.made.add(to);
    this.gone.delete(to);
  }

  async unique(dir: string, name: string): Promise<string> {
    const first = path.join(dir, name);
    if (!(await this.exists(first))) return first;
    for (let n = 1; n < 1000; n++) {
      const candidate = path.join(dir, `${name}.${n}`);
      if (!(await this.exists(candidate))) return candidate;
    }
    throw new Error(`no free destination for ${name} in ${dir}`);
  }

  async pruneEmpty(dir: string): Promise<void> {
    for (const name of await this.remaining(dir)) {
      const child = path.join(dir, name);
      if ((await fs.lstat(child).catch(() => null))?.isDirectory()) await this.pruneEmpty(child);
    }
    if ((await this.remaining(dir)).length === 0) this.gone.add(dir);
  }

  async remaining(dir: string): Promise<string[]> {
    if (this.gone.has(dir)) return [];
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    return names.filter((n) => !this.gone.has(path.join(dir, n)));
  }
}

/* -------------------------------------------------------------------------- */
/* the decision                                                                */
/* -------------------------------------------------------------------------- */

/** What happens to a chat's copy in `.chats/`. */
type Disposition =
  /** Moves into the host store; anything occupying its destination is set
   *  aside first (that is the `superseded` half of the table's last two rows). */
  | "migrate"
  /** Moves to the preserve dir; whatever is on the host side survives. */
  | "preserve";

/**
 * The survivor table (module doc), as a decision.
 *
 * It collapses because "ticked" and "which side is the descendant" are the only
 * two questions: a chat with no counterpart has nothing to lose to, an
 * identical pair has nothing to choose between, an unticked chat was declined,
 * and a fast-forward where the HOST is ahead is the one case where migrating
 * Paddock's copy would move an ancestor over a descendant — which is data loss
 * dressed as a migration, so ticking it cannot mean that.
 */
function disposition(row: MigrationChatRow, ticked: boolean): Disposition {
  if (!row.host) return ticked ? "migrate" : "preserve";
  if (row.identical) return "preserve";
  if (!ticked) return "preserve";
  if (row.state === "fast-forward" && row.ahead === "host") return "preserve";
  return "migrate";
}

function preserveReason(
  row: MigrationChatRow,
  ticked: boolean,
  unplanned: boolean,
): MigrationPreserveReason {
  if (row.identical) return "identical";
  if (ticked) return "already-ahead"; // the only ticked row that preserves
  if (unplanned) return "unplanned-diverged";
  return "unchecked";
}

/* -------------------------------------------------------------------------- */
/* one project                                                                 */
/* -------------------------------------------------------------------------- */

interface ProjectRun {
  result: MigrationProjectResult;
  migrated: string[];
  preserved: MigrationPreservedChat[];
  unplanned: MigrationUnplannedChat[];
  failed: MigrationFailure[];
  /** Ids the request ticked that this project actually holds. */
  matched: Set<string>;
}

interface ProjectOptions {
  ticked: ReadonlySet<string>;
  planned: ReadonlySet<string> | null;
  mover: Mover;
  /** Sweeper stores get no rows and no user choice: everything migrates. */
  migrateEverything: boolean;
  busy?: string[];
}

/**
 * Move one project's store, then assert the postcondition.
 *
 * Every chat is wrapped individually: one unreadable transcript must not abort
 * the other 499, and a `failed[]` entry already blocks the config write for the
 * whole instance, so a partial run is reported rather than committed.
 */
async function migrateOneProject(
  scan: MigrationProjectScan,
  opts: ProjectOptions,
): Promise<ProjectRun> {
  const slug = scan.ref.slug;
  const run: ProjectRun = {
    result: { slug, outcome: "migrated", migrated: 0, preserved: 0, chatsDirEmpty: false },
    migrated: [],
    preserved: [],
    unplanned: [],
    failed: [],
    matched: new Set(),
  };

  // §4.5. A turn that woke up between the quiesce and here holds a transcript
  // path in a directory we are about to empty. Abandon the project UNTOUCHED
  // and say so — `skipped-busy` is the disclosure, and a skipped project is
  // never counted as migrated (§10.3).
  if (opts.busy && opts.busy.length > 0) {
    run.result.outcome = "skipped-busy";
    run.result.error = `a turn started on ${opts.busy.join(", ")} after the quiesce`;
    return run;
  }

  const { chatsDir } = scan;

  for (const row of scan.rows) {
    const id = row.sessionId;
    const inRequest = opts.ticked.has(id);
    // An identical chat was never offered, so it can be neither ticked nor
    // unplanned — it has no decision attached to it at all.
    const unplanned =
      !row.identical && opts.planned !== null && !opts.planned.has(id) && !inRequest;
    const ticked = opts.migrateEverything || inRequest || (unplanned && row.defaultSelected);
    if (inRequest) run.matched.add(id);

    const what = disposition(row, ticked);
    try {
      if (what === "migrate") {
        await migrateChatIn(scan, row, opts.mover, run);
        run.migrated.push(id);
        run.result.migrated++;
      } else {
        const to = await preserveChat(scan, row, opts.mover);
        run.preserved.push({
          sessionId: id,
          slug,
          side: "own",
          path: to,
          reason: preserveReason(row, ticked, unplanned),
        });
        run.result.preserved++;
      }
      if (unplanned) {
        run.unplanned.push({
          sessionId: id,
          slug,
          state: row.state,
          action: what === "migrate" ? "migrated" : "preserved",
        });
      }
    } catch (err) {
      run.failed.push(failureOf(err, id, slug));
    }
  }

  // `memory/` is merged at FILE granularity (§10.2): it is a single well-known
  // path, so on the machines this feature is aimed at a collision is the COMMON
  // case, and the transcripts' whole-directory rule would strand it.
  if (scan.listing.hasMemory) {
    try {
      await mergeMemory(scan, opts.mover, run);
    } catch (err) {
      run.failed.push(failureOf(err, "memory", slug, path.join(chatsDir, "memory")));
    }
  }

  // Project-level artifacts: flat `agent-<hex>.jsonl` sidechains, an orphaned
  // `<id>/` with no transcript, a revert whose chat is gone, and anything the
  // scan could not classify. All of it moves — the postcondition is about the
  // directory, not about the rows — and the plan already NAMED it, via
  // `projectExtras` and the `unexpected-entries` warning, so nothing here moves
  // unannounced.
  // `memory/` appears in `projectExtras` too — the PLAN lists it there because
  // it does move with the project. It must not be moved AGAIN as a directory
  // here: doing so found the host store's merged `memory/` occupying the
  // destination, swept the user's real memory dir into the preserve dir, and
  // then failed on a source that `mergeMemory` had already emptied. Caught by
  // the merge test; the fix is that the merge owns it outright.
  const memoryDir = path.join(chatsDir, "memory");
  const extras = [...scan.projectExtras, ...scan.listing.unexpected].filter(
    (e) => e !== memoryDir,
  );
  for (const extra of extras) {
    try {
      await moveIntoStore(scan, path.relative(chatsDir, extra), opts.mover, run, "extras");
    } catch (err) {
      run.failed.push(failureOf(err, path.basename(extra), slug, extra));
    }
  }

  try {
    await drainChatsDir(scan, opts.mover, run);
  } catch (err) {
    run.failed.push(failureOf(err, "-", slug, chatsDir));
  }

  const left = await opts.mover.remaining(chatsDir);
  run.result.chatsDirEmpty = left.length === 0;
  if (run.failed.length > 0 || !run.result.chatsDirEmpty) {
    run.result.outcome = "failed";
    if (!run.result.chatsDirEmpty) {
      run.result.error =
        `${left.length} entr${left.length === 1 ? "y" : "ies"} still in ${chatsDir} ` +
        `(${left.slice(0, 5).join(", ")}) — the redirect symlink will not be planted ` +
        `while any remain, so the config was not written.`;
    }
  } else if (run.result.migrated === 0 && run.result.preserved === 0) {
    run.result.outcome = "nothing-to-do";
  }
  return run;
}

/**
 * Move Paddock's copy of a chat into the host store, setting aside anything
 * already occupying a destination FIRST.
 *
 * Clearing the way is what makes "nothing in `~/.claude` is overwritten in
 * place" structural rather than a convention: by the time anything is renamed
 * into the host store, no destination exists to clobber. It runs per artifact
 * rather than per chat because the sidecars collide independently — a host
 * store can hold `<id>/subagents/` for a chat whose `<id>.jsonl` it does not
 * have, which is `new` by classification and a collision in practice.
 */
async function migrateChatIn(
  scan: MigrationProjectScan,
  row: MigrationChatRow,
  mover: Mover,
  run: ProjectRun,
): Promise<void> {
  const id = row.sessionId;
  const reverts = scan.revertsByChat.get(id) ?? [];
  const own = await collectChatArtifacts(scan.chatsDir, id, reverts);
  for (const rel of own.relative) {
    await moveIntoStore(scan, rel, mover, run, "chat", id);
  }
}

/**
 * One store-relative artifact from `.chats/` into the host store, superseding
 * whatever is there.
 */
async function moveIntoStore(
  scan: MigrationProjectScan,
  rel: string,
  mover: Mover,
  run: ProjectRun,
  kind: "chat" | "extras",
  sessionId?: string,
): Promise<void> {
  const dest = path.join(scan.hostStore, rel);
  if (await mover.exists(dest)) {
    const aside = await mover.unique(
      path.join(scan.preserveDir, path.dirname(rel)),
      path.basename(rel),
    );
    await mover.move(dest, aside);
    run.preserved.push({
      sessionId: sessionId ?? path.basename(rel),
      slug: scan.ref.slug,
      side: "host",
      path: aside,
      reason: "superseded",
    });
    if (kind === "chat") run.result.preserved++;
  }
  await mover.move(path.join(scan.chatsDir, rel), dest);
}

/** Move Paddock's copy of a chat to the preserve dir. Returns the transcript's
 *  new path — the one the completion screen sends the user to. */
async function preserveChat(
  scan: MigrationProjectScan,
  row: MigrationChatRow,
  mover: Mover,
): Promise<string> {
  const id = row.sessionId;
  const reverts = scan.revertsByChat.get(id) ?? [];
  const own = await collectChatArtifacts(scan.chatsDir, id, reverts);
  let transcriptAt = path.join(scan.preserveDir, `${id}.jsonl`);
  for (const rel of own.relative) {
    const to = await mover.unique(
      path.join(scan.preserveDir, path.dirname(rel)),
      path.basename(rel),
    );
    await mover.move(path.join(scan.chatsDir, rel), to);
    if (rel === `${id}.jsonl`) transcriptAt = to;
  }
  return transcriptAt;
}

/**
 * `memory/`, merged file by file, never overwriting anything in the user's real
 * `~/.claude` (§10.2).
 *
 * Not a merge in the semantic sense — nobody reconciles two hand-curated
 * `MEMORY.md` indexes automatically. A colliding file is set aside under
 * `<preserveDir>/memory/<relpath>` and named in the completion summary so the
 * user can merge it by hand. Silently clobbering a curated `MEMORY.md` is the
 * one outcome that is unrecoverable, so it is the one outcome ruled out.
 */
async function mergeMemory(
  scan: MigrationProjectScan,
  mover: Mover,
  run: ProjectRun,
): Promise<void> {
  const from = path.join(scan.chatsDir, "memory");
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
      const dest = path.join(scan.hostStore, "memory", next);
      if (await mover.exists(dest)) {
        const aside = await mover.unique(
          path.join(scan.preserveDir, "memory", path.dirname(next)),
          e.name,
        );
        await mover.move(path.join(from, next), aside);
        run.preserved.push({
          sessionId: path.join("memory", next),
          slug: scan.ref.slug,
          side: "own",
          path: aside,
          reason: "unchecked",
        });
      } else {
        await mover.move(path.join(from, next), dest);
      }
    }
  };
  await walk("");
  // The emptied `memory/` shell would keep `.chats/` non-empty on its own.
  await mover.pruneEmpty(from);
}

/**
 * The postcondition, enforced rather than hoped for: whatever is still in
 * `.chats/` after every planned move goes too.
 *
 * Empty directories are removed (`.reverts/` once its snapshots have gone is
 * structure, not data). Anything else is moved into the host store, because
 * under `own` the store IS `.chats/` — an entry paddock or herdctl wrote there
 * belongs with the transcripts it sits beside, and leaving it would break the
 * flip for the whole project rather than for itself.
 *
 * This is the part that fails CLOSED. A future release that starts writing a
 * new sidecar into `.chats/` gets migrated by this loop and warned about by the
 * scan's `unexpected-entries`, instead of silently declining the symlink.
 */
async function drainChatsDir(
  scan: MigrationProjectScan,
  mover: Mover,
  run: ProjectRun,
): Promise<void> {
  for (const name of await mover.remaining(scan.chatsDir)) {
    const full = path.join(scan.chatsDir, name);
    const st = await fs.lstat(full).catch(() => null);
    if (st?.isDirectory()) {
      await mover.pruneEmpty(full);
      if (!(await mover.exists(full))) continue;
    }
    await moveIntoStore(scan, name, mover, run, "extras");
  }
}

function failureOf(
  err: unknown,
  sessionId: string,
  slug: string,
  where?: string,
): MigrationFailure {
  if (err instanceof DestinationExistsError) {
    return {
      sessionId,
      slug,
      reason: "destination-exists",
      message: err.message,
      path: err.destination,
    };
  }
  const e = err as NodeJS.ErrnoException;
  const reason: MigrationFailureReason =
    e?.code === "ENOENT" || e?.code === "EACCES" ? "unreadable" : "move-failed";
  return {
    sessionId,
    slug,
    reason,
    message: e?.message ?? String(err),
    ...(where ? { path: where } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* the whole run                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Steps 4–6: re-enumerate from disk, move, and — only if every project reached
 * the postcondition — write the config.
 *
 * Steps 1–3 (single-flight, `expectedVersion`, quiesce) are the caller's; see
 * the module doc for why.
 */
export async function executeMigration(
  input: MigrationExecuteInput,
): Promise<MigrationExecuteResult> {
  const dryRun = input.dryRun === true;
  const mover: Mover = dryRun ? new DryMover() : realMover;
  const ticked = new Set(input.sessionIds);
  const planned = input.plannedSessionIds ? new Set(input.plannedSessionIds) : null;

  const projects: MigrationProjectResult[] = [];
  const migrated: string[] = [];
  const preserved: MigrationPreservedChat[] = [];
  const unplanned: MigrationUnplannedChat[] = [];
  const failed: MigrationFailure[] = [];
  const warnings: MigrationWarning[] = [];
  const matched = new Set<string>();
  const sweepers = { stores: 0, chats: 0 };

  if (input.envShadowed) {
    warnings.push({
      code: "env-shadowed",
      message:
        `${TRANSCRIPTS_ENV_VAR} is set in the environment, which overrides the ` +
        `config file, so the write would be inert.`,
    });
  }

  // Step 4 — re-enumerate. The PLAN the user was looking at is not trusted:
  // between preview and submit a chat can appear, grow, or be resumed in a
  // terminal, and the whole point of doing this server-side is that the moves
  // are decided against what is on disk NOW.
  const scans: MigrationProjectScan[] = [];
  for (const ref of input.projects) {
    const scan = await scanProject(ref, input);
    if (scan === null) {
      projects.push({
        slug: ref.slug,
        outcome: "nothing-to-do",
        migrated: 0,
        preserved: 0,
        chatsDirEmpty: true,
      });
      continue;
    }
    scans.push(scan);
  }
  // One shared divergence budget across the whole request, exactly as the
  // preview spends it — so execute classifies a pathological instance the same
  // way the table the user ticked did.
  await settleCandidates(
    scans.flatMap((s) => s.candidates),
    input.scanBudgetBytes ?? DIVERGENCE_SCAN_BUDGET_BYTES,
  );

  for (const scan of scans) {
    warnings.push(...scan.warnings);
    const run = await migrateOneProject(scan, {
      ticked,
      planned,
      mover,
      migrateEverything: false,
      busy: input.busySessions?.(scan.ref.slug),
    });
    projects.push(run.result);
    migrated.push(...run.migrated);
    preserved.push(...run.preserved);
    unplanned.push(...run.unplanned);
    failed.push(...run.failed);
    for (const id of run.matched) matched.add(id);
  }

  // Sweeper stores (`<dataDir>/sweepers/<slug>/.chats`) get their own redirect
  // symlink exactly like a project's, so a project-only migration splits them.
  // No rows and no user choice (#882): everything in them migrates, and they
  // are reported as counts. Their failures still block the commit — a sweeper
  // whose `.chats/` stays non-empty is half-blind after the restart just like a
  // project's would be.
  for (const [slug, dir] of input.sweeperDirs ?? new Map<string, string>()) {
    const ref: MigrationProjectRef = { slug, name: slug, dir, workingDir: dir };
    const scan = await scanProject(ref, input);
    if (scan === null) continue;
    sweepers.stores++;
    sweepers.chats += scan.rows.length;
    const run = await migrateOneProject(scan, {
      ticked,
      planned,
      mover,
      migrateEverything: true,
      busy: input.busySessions?.(slug),
    });
    warnings.push(...scan.warnings);
    failed.push(...run.failed);
    if (!run.result.chatsDirEmpty) {
      failed.push({
        sessionId: "-",
        slug,
        reason: "move-failed",
        message: run.result.error ?? `sweeper store ${scan.chatsDir} is not empty`,
        path: scan.chatsDir,
      });
    }
  }

  const ignoredSessionIds = input.sessionIds.filter((id) => !matched.has(id));
  const everyProjectClean =
    failed.length === 0 &&
    projects.every((p) => p.chatsDirEmpty && p.outcome !== "skipped-busy" && p.outcome !== "failed");
  const movedSomething = migrated.length > 0 || preserved.length > 0;

  // Idempotency (§4.2). "Already migrated" is a statement about the CONFIG FILE
  // and the stores, not about this process's frozen mode — a second POST
  // arriving before the restart must be a no-op, and at that moment
  // `input.mode` still says `own`.
  const alreadyMigrated = !movedSomething && failed.length === 0 && input.pendingMode === "host";

  // Step 6 — THE COMMIT POINT. Refused when the env shadows the key (the write
  // would be inert), when anything failed or was skipped, and when any project
  // still holds an entry in `.chats/`.
  let configWritten = false;
  let configVersion: string | undefined;
  if (
    !dryRun &&
    !input.envShadowed &&
    everyProjectClean &&
    input.pendingMode !== "host"
  ) {
    try {
      const v = await input.commitConfig();
      configWritten = true;
      if (v !== null) configVersion = v;
    } catch (err) {
      failed.push({
        sessionId: "-",
        slug: "-",
        reason: "unknown",
        message: `files moved but the config write failed: ${(err as Error).message}. ` +
          `Re-run the migration — it reconciles.`,
        path: input.configPath,
      });
    }
  }

  const effectivePending = configWritten ? "host" : input.pendingMode;
  return {
    // On a dry run `ok` is the PREDICTION — "this would succeed" — because a
    // dry run can never write the config, and reporting `ok: false` for a plan
    // that is entirely healthy would tell a confirm step the opposite of the
    // truth.
    ok: dryRun ? everyProjectClean : configWritten || (alreadyMigrated && everyProjectClean),
    alreadyMigrated,
    dryRun,
    projects,
    migrated,
    preserved,
    unplanned,
    ignoredSessionIds,
    failed,
    sweepers,
    warnings,
    configWritten,
    configPath: input.configPath,
    ...(configVersion !== undefined ? { configVersion } : {}),
    // Truthful rather than "always true when configWritten": a second POST
    // arriving before the restart writes nothing and still needs one, and a
    // fully-migrated, already-restarted instance needs none.
    restartRequired: !dryRun && (effectivePending !== input.mode || movedSomething),
  };
}
