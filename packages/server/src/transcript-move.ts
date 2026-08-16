/**
 * Moving a chat's files from one transcript store to another — the shared
 * primitive under the `own → host` migration (#882).
 *
 * ## Why this is a module and not four lines inside the migration
 *
 * A "chat" is not one file. On this box's real stores a single session id owns
 * up to four separate things:
 *
 *   `<id>.jsonl`             the transcript
 *   `<id>/subagents/`        sidechain transcripts
 *   `<id>/tool-results/`     spilled tool output
 *   `.reverts/<id>-*.jsonl`  revert snapshots, in a directory SHARED by every
 *                            session in the store (`herdctl.ts:1988`)
 *
 * `promoteSession` (`herdctl.ts:1814-1852`) moves only the first of those, and
 * therefore silently orphans the rest — the `<id>/` directory and the reverts
 * stay in the source store, pointing at a chat that is no longer there. That is
 * a pre-existing bug, **filed as #898**, and this helper is its fix: promote
 * should adopt {@link collectChatArtifacts} + {@link moveArtifacts} rather than
 * grow a second copy of the enumeration. Deliberately NOT changed here — see
 * `docs/DESIGN-transcripts-migration.md` §10.6 for why it is a follow-up
 * (promote has its own failure modes and its own tests, and reviewing them as a
 * footnote to a large feature is how a regression gets in).
 *
 * ## The two properties everything else rests on
 *
 * 1. **Nothing is ever deleted.** The migration's whole promise to the user is
 *    that a copy they disagree with is set aside, not destroyed. So there is no
 *    unlink in this module that is not the second half of a copy.
 *
 * 2. **A destination that exists is never written through.** This is the
 *    load-bearing one, and it is not automatic: POSIX `rename(2)` *silently
 *    replaces* an existing destination file. `mv a b` overwriting `b` is the
 *    behaviour every caller would get by default, and on the `host` side `b` is
 *    a file in the user's real `~/.claude`. {@link moveArtifacts} therefore
 *    `lstat`s every destination first and refuses with
 *    {@link DestinationExistsError}; the migration's own rule is to move the
 *    superseded copy to the preserve dir BEFORE calling in here, so this guard
 *    should never fire — which is exactly why it has to exist and be tested.
 *
 * ## `rename` first, copy on `EXDEV`
 *
 * `ensureProjectChats:352-362` unconditionally does `cp` + `rm` with the note
 * *"rename would EXDEV across mounts"*. Correct, and it leaves a 53× speedup on
 * the floor in the overwhelmingly common case where the data dir and
 * `~/.claude` share a filesystem (measured in design §6: 24 ms vs 1.3 s for 500
 * chats). So: try `rename`, and fall back only on the errors that actually mean
 * "different device". `preserveTimestamps: true` on the copy path is load-bearing
 * rather than cosmetic (#588): a transcript's mtime is the cache key for
 * auto-name, preview and sidechain detection, and `fs.cp` stamps NOW by default.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The errors that mean "these paths are not on the same filesystem, `rename`
 * cannot help you". `EXDEV` is the POSIX one; `ENOTSUP`/`EPERM` show up from
 * some FUSE and overlay mounts (docker's overlayfs, sshfs) for the same reason.
 */
const CROSS_DEVICE = new Set(["EXDEV", "ENOTSUP", "EPERM"]);

/** Thrown rather than clobbering — see the module doc's property 2. */
export class DestinationExistsError extends Error {
  constructor(readonly destination: string) {
    super(`refusing to overwrite an existing path: ${destination}`);
    this.name = "DestinationExistsError";
  }
}

/** Does anything at all live at `p` — including a broken symlink? */
export async function pathExists(p: string): Promise<boolean> {
  return fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Move one file or directory tree `from` → `to`, without ever overwriting.
 *
 * The caller owns the collision policy: this refuses, it does not invent a
 * name. See {@link uniqueDestination} for the migration's answer.
 */
export async function moveEntry(from: string, to: string): Promise<void> {
  if (await pathExists(to)) throw new DestinationExistsError(to);
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!CROSS_DEVICE.has(code)) throw err;
  }
  // Cross-device: copy then remove. If the copy throws, the source is still
  // there and untouched — which is the failure mode we want, because the
  // alternative is a half-moved chat with no copy anywhere.
  await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
  await fs.rm(from, { recursive: true, force: true });
}

/**
 * A free path at `dir/<name>`, suffixing `.1`, `.2`, … when taken.
 *
 * Used only for the PRESERVE side. A preserve dir can already hold a copy from
 * an earlier run of a migration that failed partway, and "nothing is ever
 * deleted" has to hold across retries too — so the second copy is set beside
 * the first rather than on top of it. The real path used is what the response
 * reports, so the user is never sent to a path that holds someone else's file.
 */
export async function uniqueDestination(dir: string, name: string): Promise<string> {
  const first = path.join(dir, name);
  if (!(await pathExists(first))) return first;
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, `${name}.${n}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`no free destination for ${name} in ${dir} after 1000 tries`);
}

/**
 * Everything in a store that belongs to one session id, as store-RELATIVE
 * paths so the same list can be replayed against a destination.
 *
 * `.reverts/` is prefix-matched longest-first rather than split at a fixed
 * offset: a session id is only guaranteed to match `[A-Za-z0-9._-]+`, so
 * assuming a 36-char UUID mis-files every revert belonging to a chat named
 * anything else, and a chat whose id is a prefix of another's would steal its
 * neighbour's reverts.
 */
export interface ChatArtifacts {
  sessionId: string;
  /** Store-relative paths, in the order they should be moved. */
  relative: string[];
}

/**
 * List the artifacts of `sessionId` that actually exist in `store`.
 *
 * `revertNames` is passed in rather than read here because the migration reads
 * `.reverts/` once per project and groups it, and a per-chat readdir of a
 * directory shared by 500 chats is 500 readdirs of the same directory.
 */
export async function collectChatArtifacts(
  store: string,
  sessionId: string,
  revertNames: readonly string[] = [],
): Promise<ChatArtifacts> {
  const relative: string[] = [];
  const transcript = `${sessionId}.jsonl`;
  if (await pathExists(path.join(store, transcript))) relative.push(transcript);
  if (await pathExists(path.join(store, sessionId))) relative.push(sessionId);
  for (const name of revertNames) {
    if (await pathExists(path.join(store, ".reverts", name))) {
      relative.push(path.join(".reverts", name));
    }
  }
  return { sessionId, relative };
}

/** Which chat a `.reverts/<id>-<stamp>.jsonl` belongs to; see {@link ChatArtifacts}. */
export function revertOwner(name: string, chatIds: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  for (let i = name.indexOf("-"); i > 0; i = name.indexOf("-", i + 1)) {
    const candidate = name.slice(0, i);
    if (chatIds.has(candidate) && (best === undefined || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Remove `dir` and every directory under it that holds no files, bottom-up.
 *
 * Not a delete of anything the user has: it clears the *structure* left behind
 * once a directory's contents have been moved out — `.reverts/` after its
 * snapshots have gone, `memory/` after its files have been merged. Without it
 * those empty shells keep `.chats/` non-empty, `pointChatsDirAt` declines the
 * redirect symlink, and the migration fails its own postcondition on a
 * directory containing nothing at all.
 *
 * Anything holding a file is left completely alone.
 */
export async function pruneEmptyTree(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyTree(path.join(dir, e.name));
  }
  // `["?"]` on failure so an unreadable directory is never mistaken for an
  // empty one and removed.
  if ((await fs.readdir(dir).catch(() => ["?"])).length === 0) {
    await fs.rmdir(dir).catch(() => undefined);
  }
}
