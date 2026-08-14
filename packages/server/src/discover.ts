/**
 * Instance-level DISCOVERY of directories worth turning into projects (#745).
 *
 * A fresh instance has nothing in it, and the user very often already has months
 * of terminal `claude` history on the same machine. `<claudeHome>/projects/*`
 * knows every directory they have ever run Claude Code in; this module decides
 * which of those a human would actually recognise as a project.
 *
 * ## Discovery is not adoption, and needs its own boundary
 *
 * `adoptable.ts` answers "what could THIS project import?" — it is scoped to a
 * project that already exists, and `POST …/adopt-chats` deliberately 400s a
 * `sourceCwd` that project does not offer, "rather than an invitation to scan
 * arbitrary directories". Discovery enumerates directories across the machine by
 * definition, so it must NOT be built by loosening that rule. It is a separate,
 * instance-level surface with a containment rule of its own:
 *
 *  - the ONLY directories it will ever name are ones with a transcript folder
 *    under `<claudeHome>/projects/` — it never lists, walks or globs the
 *    filesystem, and a path that is not already in that set cannot be probed
 *    through it;
 *  - every candidate is put through the same path floor a linked project has to
 *    clear ({@link isSystemPath}, #718–#721) plus the reserved-root and
 *    project-overlap checks `ProjectStore.validatePath` applies, so Discovery
 *    can never propose a row that project creation would then refuse;
 *  - the per-directory session listing ({@link discoverSessions}) re-derives
 *    that same set and refuses anything outside it, so `?dir=` is a lookup into
 *    a computed allow-list rather than a path parameter.
 *
 * ## The heuristic IS the feature
 *
 * A naive "folder exists" scan is unusable. Dogfooded on a real developer
 * machine it surfaced ~166 transcript folders, ~150 of them ephemeral sessions
 * under temp roots, plus junk like `/`, `~/Downloads` and `/tmp` itself. The
 * rules below take that to a handful, and they are ordered cheap-to-expensive so
 * the ~150 die on string comparisons before anything reads a transcript:
 *
 *  1. `no-recorded-cwd` — the folder's transcripts record no cwd, so there is no
 *     honest way to say what directory it belongs to. NEVER inverted from the
 *     folder name: `encodePathForCli` is lossy (`/a/b-c`, `/a-b/c` and `/a/b/c`
 *     all encode alike), so a name-derived path is wrong in ways nothing
 *     downstream could detect.
 *  2. `missing` — the directory is gone, or is not a directory.
 *  3. `system-path` — `/` and the `SYSTEM_PATH_DENYLIST` floor (#720), tested
 *     against BOTH the resolved and the as-written spelling, exactly as
 *     `validatePath` does (`/proc/self/cwd` canonicalises to something ordinary).
 *  4. `temp-root` — `/tmp`, `/var/folders`, `$TMPDIR` and friends. This is the
 *     ~150. See {@link isTempPath} for why `$HOME` wins a conflict.
 *  5. `paddock-internal` — inside the projects root, the data dir or either
 *     Claude home. `validatePath` refuses those, so offering one would be a row
 *     that fails on submit.
 *  6. `home-root` — `$HOME` itself. Someone has run `claude` in their home
 *     directory; a project spanning the whole home is never what they meant.
 *  7. `outside-home` — SOFT (see {@link DiscoverOptions.includeOutsideHome}).
 *  8. `already-managed` — the directory is, contains, or sits inside an existing
 *     project's working directory. `validatePath` rejects overlap in either
 *     direction, so this mirrors it rather than only checking equality.
 *  9. `no-git` — SOFT (see {@link DiscoverOptions.includeNonGit}). One `stat`.
 * 10. `no-sessions` — nothing survives the noise filter. The only expensive
 *     rule, and by now it runs over a handful of directories rather than 166.
 *
 * Surviving directories are ranked by non-noise session count, then by recency.
 *
 * ## Paddock's own folders never enter the scan at all (#865)
 *
 * {@link withoutOwnTranscriptFolders} runs BEFORE any of this, and it is not one
 * more exclusion rule: a folder it drops is not counted in `scanned` either.
 * That distinction is the whole point. Paddock plants a symlink into its Claude
 * home for each workspace's `.chats` at boot, so a machine that has never run
 * Claude Code reported `scanned: 2, excluded: {"no-recorded-cwd": 2}` — and
 * `scanned === 0`, the one signal that separates "no history here" from "all of
 * it was filtered out", was therefore unreachable in the case it was written
 * for. The UI then told a first-time user their history was "already a project,
 * or was filtered out", on a machine with no history at all.
 *
 * ## Why counts are reported rather than dropped
 *
 * `DiscoverResult.excluded` carries how many directories each rule ate. Without it a
 * containerised instance — whose Claude home is `<dataDir>/claude-home` and
 * whose only visible directories are bind mounts — renders a blank page that
 * looks broken, and there is no way to tell "you have no history" from "all 40
 * of your directories are outside `$HOME`". It is also what lets the UI offer
 * the two soft rules as toggles instead of hard-coding a guess.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdoptableSession } from "@herdctl/core";
import {
  filterReasonFor,
  gitRemotes,
  type AdoptableCandidate,
  type FilterReason,
  type TranscriptFolder,
} from "./adoptable.js";
import { isPathInside, isSystemPath, slugify } from "./project-paths.js";

/** Why a transcript folder did not become a candidate. */
export type DiscoverExclusion =
  | "no-recorded-cwd"
  | "missing"
  | "system-path"
  | "temp-root"
  | "paddock-internal"
  | "home-root"
  | "outside-home"
  | "already-managed"
  | "no-git"
  | "no-sessions";

/**
 * The rules a caller may relax. Both default OFF, and both are reported in
 * {@link DiscoverResult.excluded} when they fire so a client can offer the
 * toggle only when it would actually reveal something.
 *
 * Neither weakens containment: a relaxed candidate still has to be a directory
 * with a transcript folder that cleared every hard rule above.
 */
export interface DiscoverOptions {
  /**
   * Offer directories that are not git checkouts.
   *
   * The `.git` test is what took 166 candidates to ~4 on the dogfooding machine,
   * and issue #745 left "require it, or merely rank it first?" open. Requiring
   * it is the right DEFAULT — a notebook directory that is not a repo is the
   * minority case, and the majority case is a page full of `~/Downloads` — but
   * requiring it with no way back would make the notebook case unreachable,
   * which is why this exists rather than the rule being absolute.
   */
  includeNonGit?: boolean;
  /**
   * Offer directories outside `$HOME`.
   *
   * Off by default because on a laptop everything the user means is under their
   * home, and everything outside it is a system path, a scratch mount or another
   * account's tree. Worth turning on in a container, where `$HOME` is
   * `/root`-ish and the interesting directories are bind mounts.
   */
  includeOutsideHome?: boolean;
}

/** One directory Discovery proposes as a project. */
export interface DiscoverCandidate {
  /**
   * The directory, symlinks resolved.
   *
   * This is the value to POST as `path` to `POST /api/projects`: `validatePath`
   * canonicalises before storing, so this is also exactly what the created
   * project's `workingDir` will be — and therefore the `sourceCwd`
   * `POST …/adopt-chats` will then accept.
   */
  path: string;
  /**
   * The cwd the transcripts actually record, when it is a DIFFERENT spelling of
   * {@link path} (a symlinked home, a `/private/var` vs `/var` mount).
   *
   * Absent in the ordinary case. Present, it is a warning worth surfacing:
   * `adoptable.ts` matches a notebook project's sources on exact cwd equality
   * against the stored (resolved) working directory, so a divergent spelling is
   * how an import comes back empty despite a healthy-looking count here.
   */
  recordedPath?: string;
  /** Basename — the name a project created here should default to. */
  name: string;
  /**
   * A slug free on this instance: {@link slugify}'d basename, qualified with the
   * parent directory when that basename is already taken by an existing project
   * or by an earlier (higher-ranked) candidate in this same result.
   *
   * Advisory. `POST /api/projects` derives its own slug from `name` when none is
   * sent; this exists so a client does not have to reimplement `slugify` to
   * avoid the collision issue #745 flagged (two candidates sharing a basename).
   */
  suggestedSlug: string;
  hasGit: boolean;
  /** First normalised git remote, when the checkout has one — disambiguates two
   *  same-named directories far better than their paths do. */
  gitRemote?: string;
  insideHome: boolean;
  /** Sessions on offer here, after the shared noise filter. The ranking key. */
  sessionCount: number;
  /** Sessions the noise filter withheld — the difference between this and the
   *  raw file count, so "why 5 and not 12?" always has an answer. */
  filteredCount: number;
  /** ISO 8601 mtime of the newest offered session. */
  lastSessionAt?: string;
}

/** What Discovery found, and what it threw away. */
export interface DiscoverResult {
  /** The Claude home that was scanned — named so a container that legitimately
   *  finds nothing can point at the directory to bind-mount. */
  claudeHome: string;
  homeDir: string;
  /** Transcript folders enumerated. `0` means "no history at all" (the container
   *  case); a large number with no candidates means "all of it was filtered". */
  scanned: number;
  candidates: DiscoverCandidate[];
  /**
   * Rule → how many DIRECTORIES it excluded (not folders: one directory often
   * has two transcript folders). Only non-zero entries appear.
   */
  excluded: Partial<Record<DiscoverExclusion, number>>;
}

/** One directory's importable sessions, for lazy expansion of a row. */
export interface DiscoverSessions {
  path: string;
  sessions: AdoptableCandidate[];
  /** Withheld candidates and why — same vocabulary as `adoptable-chats`. */
  filtered: Array<{ sessionId: string; reason: FilterReason }>;
}

/** Everything discovery needs that it must not go and find for itself. */
export interface DiscoverContext {
  /** `<claudeHome>/projects/*`, recorded cwds already recovered. */
  folders: TranscriptFolder[];
  claudeHome: string;
  homeDir: string;
  /**
   * Directories a project may never be linked inside: the projects root, the
   * data dir, and both Claude homes. Mirrors `ProjectStore.validatePath`'s own
   * refusals so a candidate can never be a row that fails on submit.
   */
  reservedRoots: string[];
  /**
   * Ephemeral roots whose contents are scratch — normally
   * {@link defaultTempRoots}. Passed in rather than read here for the same
   * reason `homeDir` is: what counts as ephemeral is a fact about the machine,
   * and a caller (a test rig, a container image with an unusual `$TMPDIR`) has
   * to be able to state it rather than have it assumed.
   */
  tempRoots: string[];
  /** Every existing project's working directory (the root workspace included). */
  managedDirs: string[];
  /** Slugs already in use, so {@link DiscoverCandidate.suggestedSlug} is free. */
  takenSlugs: string[];
  /**
   * List one transcript folder's adoptable sessions. Supplied by the caller
   * because it is the ENGINE's answer (sidechains, already-adopted sessions and
   * anything a run record owns are excluded there, not here).
   *
   * Takes the folder's `engineCwd`, never its recorded cwd: the user's own
   * `~/.claude` folders are reached through a mirror under a synthetic path, and
   * handing the engine the recorded cwd would read the wrong directory (#620).
   */
  listSessions(engineCwd: string): Promise<AdoptableSession[]>;
}

/**
 * Roots whose contents are ephemeral by construction.
 *
 * macOS spellings are listed in both their `/private`-prefixed and unprefixed
 * forms because either can be the recorded one depending on how the shell got
 * there, and {@link siftDirectories} tests the as-written path as well as the
 * resolved one.
 */
const TEMP_PATH_ROOTS = [
  "/tmp",
  "/var/tmp",
  "/private/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
  "/dev/shm",
];

/** The ephemeral roots on THIS machine — the well-known set plus `$TMPDIR`. */
export function defaultTempRoots(): string[] {
  return [...TEMP_PATH_ROOTS, os.tmpdir()];
}

/**
 * Drop the transcript folders paddock planted itself, BEFORE anything is counted
 * (issue #865).
 *
 * Paddock bridges each workspace's `.chats` into its Claude home as a symlink at
 * boot — the root workspace's and the sweeper's exist on an instance nobody has
 * touched yet. They are transcript folders by every structural test, so the scan
 * saw two of them, excluded both as `no-recorded-cwd` (they are empty), and
 * reported `scanned: 2`. Reporting them as *scanned* is the bug: `scanned === 0`
 * is what the UI keys "no Claude Code history on this machine" off, and paddock's
 * own bookkeeping is not the user's history.
 *
 * ## The test, and why it is this one
 *
 * A folder is paddock's own when it resolves INTO paddock's own storage
 * (`ownRoots`: the projects root and the data dir) while resolving OUTSIDE every
 * Claude home. Both halves are load-bearing:
 *
 *  - the second half alone would drop everything — a real folder physically
 *    lives in `<claudeHome>/projects/`, which is itself inside the data dir;
 *  - the first half alone would drop the user's OWN mirrored folders (#620),
 *    which resolve into `~/.claude` — inside `legacyClaudeHome`, and exactly the
 *    history this feature exists to offer.
 *
 * So: resolves into a claude home ⇒ the user's, keep. Resolves into paddock's
 * storage but no claude home ⇒ a `.chats` bridge paddock made, drop.
 *
 * Note this is deliberately NOT another {@link DiscoverExclusion}. An exclusion
 * is a directory the user has that we are declining to offer, and it is counted
 * and shown as such; these are folders that were never theirs to begin with.
 */
export function withoutOwnTranscriptFolders(
  folders: TranscriptFolder[],
  roots: {
    /** Paddock's own storage: the projects root and the data dir. */
    ownRoots: string[];
    /** Both Claude homes — paddock's and the user's. */
    claudeHomes: string[];
  },
): TranscriptFolder[] {
  return folders.filter((folder) => {
    const real = folder.realPath;
    if (roots.claudeHomes.some((home) => isPathInside(real, home))) return true;
    return !roots.ownRoots.some((root) => isPathInside(real, root));
  });
}

/**
 * Is this an ephemeral scratch directory?
 *
 * **`$HOME` wins.** A home directory that itself sits under a temp root is not a
 * scratch dir — it is a container, a CI sandbox or a test rig, and applying the
 * rule literally there would exclude every candidate and make Discovery look
 * uniformly broken on exactly the deployments least able to diagnose it. The
 * rule exists to kill `/tmp/foo` sessions from a shell that `cd`'d somewhere
 * disposable, and none of those are inside anybody's home.
 */
export function isTempPath(candidate: string, homeDir: string, roots: string[]): boolean {
  const p = path.resolve(candidate);
  if (isPathInside(p, homeDir)) return false;
  return roots.some((root) => isPathInside(p, root));
}

/** A directory that cleared the path rules, before sessions are counted. */
interface SiftedDir {
  path: string;
  recordedPath?: string;
  name: string;
  hasGit: boolean;
  gitRemote?: string;
  insideHome: boolean;
  /**
   * Every transcript folder that records this directory, as the path the engine
   * must be handed. More than one is normal post-#620: the user's own
   * `~/.claude` folder for a cwd and paddock's own folder for it are two
   * different directories that both describe the same candidate.
   */
  engineCwds: string[];
}

/** Tally of what each rule excluded. */
type ExclusionTally = Partial<Record<DiscoverExclusion, number>>;

/**
 * Apply the path rules to every transcript folder, grouping survivors by the
 * directory they resolve to.
 *
 * `hard` runs the rules that are containment rather than preference — the set
 * {@link discoverSessions} validates `?dir=` against. The soft rules
 * (`no-git`, `outside-home`) are skipped entirely in that mode, because a client
 * can only have learnt a path from a listing that already applied them.
 */
async function siftDirectories(
  ctx: DiscoverContext,
  opts: DiscoverOptions,
  mode: "full" | "hard-only",
): Promise<{ kept: SiftedDir[]; excluded: ExclusionTally }> {
  const excluded: ExclusionTally = {};
  const drop = (reason: DiscoverExclusion): void => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };

  const kept: SiftedDir[] = [];
  /** realPath → its entry in `kept`, so two folders for one directory merge. */
  const byRealPath = new Map<string, SiftedDir>();
  /**
   * Directories already ruled out, so the tally counts DIRECTORIES rather than
   * folders. One directory routinely has two transcript folders (the user's own
   * and paddock's copy, post-#620 and after any import), and reporting "2 temp
   * roots" for one temp directory would make the number the UI shows a lie.
   *
   * A kept directory never reaches this set — `byRealPath` catches it first —
   * and `no-recorded-cwd` never enters it, because a folder with no cwd has no
   * directory to be counted under. That one is per-FOLDER by necessity.
   */
  const rejected = new Set<string>();

  for (const folder of ctx.folders) {
    const recorded = folder.cwd;
    if (recorded === null || recorded === "" || folder.engineCwd === null) {
      drop("no-recorded-cwd");
      continue;
    }

    // Resolve BEFORE any containment test — `/tmp/innocent -> ~/real` would
    // otherwise be judged on its spelling. Both spellings are then checked, the
    // same pairing `validatePath` uses.
    const real = await fs.realpath(recorded).catch(() => null);
    const resolved = real ?? path.resolve(recorded);

    // An already-merged directory has cleared every rule below; just union in
    // this folder's engine path.
    const merged = byRealPath.get(resolved);
    if (merged !== undefined) {
      if (!merged.engineCwds.includes(folder.engineCwd)) merged.engineCwds.push(folder.engineCwd);
      continue;
    }
    if (rejected.has(resolved)) continue;
    // From here on every `continue` is a decision about this DIRECTORY, so it is
    // recorded once no matter how many folders record it.
    rejected.add(resolved);

    if (real === null) {
      drop("missing");
      continue;
    }
    const st = await fs.stat(resolved).catch(() => null);
    if (st === null || !st.isDirectory()) {
      drop("missing");
      continue;
    }
    if (isSystemPath(resolved) || isSystemPath(recorded)) {
      drop("system-path");
      continue;
    }
    if (
      isTempPath(resolved, ctx.homeDir, ctx.tempRoots) ||
      isTempPath(recorded, ctx.homeDir, ctx.tempRoots)
    ) {
      drop("temp-root");
      continue;
    }
    if (ctx.reservedRoots.some((root) => isPathInside(resolved, root))) {
      drop("paddock-internal");
      continue;
    }
    if (resolved === path.resolve(ctx.homeDir)) {
      drop("home-root");
      continue;
    }

    const insideHome = isPathInside(resolved, ctx.homeDir);
    if (mode === "full" && !insideHome && opts.includeOutsideHome !== true) {
      drop("outside-home");
      continue;
    }
    // Overlap in EITHER direction, matching `validatePath`: linking a parent of
    // another project's working tree is as broken as linking a child of one.
    //
    // Not a containment rule, so it does not apply in `hard-only` mode: it says
    // "there is nothing left to CREATE here", which has no bearing on whether a
    // directory's transcripts may be listed. Applying it there would also make
    // the import loop race itself — a client that creates the project and then
    // re-expands the row would get a 400 for the directory it just imported.
    if (
      mode === "full" &&
      ctx.managedDirs.some((dir) => isPathInside(resolved, dir) || isPathInside(dir, resolved))
    ) {
      drop("already-managed");
      continue;
    }

    // One `stat` — and only now, for what is left after the string rules.
    const dotGit = await fs.stat(path.join(resolved, ".git")).catch(() => null);
    const hasGit = dotGit !== null;
    if (mode === "full" && !hasGit && opts.includeNonGit !== true) {
      drop("no-git");
      continue;
    }

    const entry: SiftedDir = {
      path: resolved,
      ...(recorded === resolved ? {} : { recordedPath: recorded }),
      name: path.basename(resolved),
      hasGit,
      // Display-only, and `discoverSessions` never returns it — so don't read a
      // git config per directory on the expansion path, which sifts the whole
      // set again just to validate one `?dir=`.
      ...(hasGit && mode === "full" ? await remoteOf(resolved) : {}),
      insideHome,
      engineCwds: [folder.engineCwd],
    };
    kept.push(entry);
    byRealPath.set(resolved, entry);
  }

  return { kept, excluded };
}

/** The checkout's first normalised remote, as a spreadable partial. */
async function remoteOf(dir: string): Promise<{ gitRemote?: string }> {
  const remotes = await gitRemotes(dir).catch(() => []);
  return remotes.length > 0 ? { gitRemote: remotes[0] } : {};
}

/** Collect a directory's offered sessions across all of its transcript folders. */
async function sessionsIn(
  ctx: DiscoverContext,
  engineCwds: string[],
): Promise<Omit<DiscoverSessions, "path">> {
  const seen = new Set<string>();
  const sessions: AdoptableCandidate[] = [];
  const filtered: DiscoverSessions["filtered"] = [];
  for (const engineCwd of engineCwds) {
    // Fault-isolated per folder: one unreadable folder costs its own sessions,
    // never the whole directory's count.
    const found = await ctx.listSessions(engineCwd).catch(() => []);
    for (const session of found) {
      // One session, once. Two engine paths can reach the same transcript, and a
      // transcript may have been copied between them.
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      const reason = filterReasonFor(session);
      if (reason !== null) {
        filtered.push({ sessionId: session.sessionId, reason });
        continue;
      }
      sessions.push({
        sessionId: session.sessionId,
        mtime: session.mtime,
        preview: session.preview,
        autoName: session.autoName,
        sizeBytes: session.sizeBytes,
      });
    }
  }
  sessions.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { sessions, filtered };
}

/**
 * Rank candidates: most sessions first, then most recently used, then by path so
 * two equal rows never swap places between two requests.
 */
function rank(a: DiscoverCandidate, b: DiscoverCandidate): number {
  if (a.sessionCount !== b.sessionCount) return b.sessionCount - a.sessionCount;
  const at = a.lastSessionAt ?? "";
  const bt = b.lastSessionAt ?? "";
  if (at !== bt) return bt.localeCompare(at);
  return a.path.localeCompare(b.path);
}

/**
 * A slug free of `taken`, qualified by the parent directory before falling back
 * to a counter. `taken` is mutated so a whole result set stays internally
 * unique, not merely unique against the instance.
 */
function freeSlug(dir: string, taken: Set<string>): string {
  const base = slugify(path.basename(dir)) || "project";
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  const parent = slugify(path.basename(path.dirname(dir)));
  const qualified = parent === "" ? base : `${parent}-${base}`;
  if (!taken.has(qualified)) {
    taken.add(qualified);
    return qualified;
  }
  for (let n = 2; ; n++) {
    const numbered = `${qualified}-${n}`;
    if (!taken.has(numbered)) {
      taken.add(numbered);
      return numbered;
    }
  }
}

/** The candidate directories this instance could import, ranked. */
export async function discoverCandidates(
  ctx: DiscoverContext,
  opts: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const { kept, excluded } = await siftDirectories(ctx, opts, "full");

  const candidates: DiscoverCandidate[] = [];
  for (const dir of kept) {
    const { sessions, filtered } = await sessionsIn(ctx, dir.engineCwds);
    if (sessions.length === 0) {
      excluded["no-sessions"] = (excluded["no-sessions"] ?? 0) + 1;
      continue;
    }
    const { engineCwds: _engineCwds, ...rest } = dir;
    candidates.push({
      ...rest,
      // Placeholder: assigned below, in rank order, so the best row keeps the
      // unqualified slug when two candidates share a basename.
      suggestedSlug: "",
      sessionCount: sessions.length,
      filteredCount: filtered.length,
      // Sorted newest-first above, so element 0 is the most recent.
      ...(sessions[0] === undefined ? {} : { lastSessionAt: sessions[0].mtime }),
    });
  }

  candidates.sort(rank);
  const taken = new Set(ctx.takenSlugs);
  for (const candidate of candidates) candidate.suggestedSlug = freeSlug(candidate.path, taken);

  return {
    claudeHome: ctx.claudeHome,
    homeDir: ctx.homeDir,
    scanned: ctx.folders.length,
    candidates,
    excluded,
  };
}

/** Raised when `?dir=` names something Discovery will not read. */
export class DiscoverPathError extends Error {}

/**
 * One directory's importable sessions.
 *
 * `dir` is matched against the SAME set {@link discoverCandidates} builds — by
 * resolved path or by recorded cwd, since a client may legitimately hold either
 * — with only the soft preference rules relaxed. Anything else throws
 * {@link DiscoverPathError}, which is what keeps this from being a filesystem
 * probe: it reads `<claudeHome>/projects/<encoded>` for directories the machine
 * has already recorded, never a path the caller chose.
 */
export async function discoverSessions(
  ctx: DiscoverContext,
  dir: string,
): Promise<DiscoverSessions> {
  const { kept } = await siftDirectories(ctx, {}, "hard-only");
  const wanted = path.resolve(dir.trim());
  const match = kept.find((d) => d.path === wanted || d.recordedPath === dir.trim());
  if (match === undefined) {
    throw new DiscoverPathError(`Not a discoverable directory: ${dir}`);
  }
  return { path: match.path, ...(await sessionsIn(ctx, match.engineCwds)) };
}
