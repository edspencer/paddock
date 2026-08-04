/**
 * Detection of a project's ADOPTABLE native Claude Code chats (#588).
 *
 * A project is backed by a working directory, and a user very often already has
 * terminal `claude` history for that same directory — or for their own checkout
 * of the same repo, somewhere else entirely on the disk. Those transcripts live
 * in `<claudeHome>/projects/<encoded-cwd>/*.jsonl` and are invisible to paddock
 * until they are adopted. This module answers "what could this project import?".
 *
 * The engine already knows how to decide whether ONE working directory's
 * transcripts are adoptable (`fleet.listAdoptableSessions` — it excludes
 * sidechains, already-adopted sessions and anything a real run is attributed
 * to). What it cannot know is which working directories belong to a paddock
 * project. That is this module's job, and it has three parts:
 *
 *  1. **Assemble candidate sources** — the project's own `workingDir`, plus any
 *     `<claudeHome>/projects/*` folder whose RECORDED cwd matches the project.
 *  2. **Filter low-value noise** — a zero-byte transcript, a session that is
 *     nothing but a `/mcp` slash command, or one of paddock's OWN sweeper runs
 *     (#658) is not a chat anyone wants imported.
 *  3. **Cache** — the scan is O(all transcript folders on the machine), so it is
 *     keyed on directory mtimes and only redone when something could have moved.
 *
 * ## Why the recorded cwd, never the folder name
 *
 * `encodePathForCli` replaces every non-alphanumeric character with `-` and
 * truncates+hashes past 200 chars. It is lossy and NOT invertible: `/a/b-c`,
 * `/a-b/c` and `/a/b/c` all encode to `-a-b-c`. Deriving a cwd from a folder
 * name is therefore impossible in general and silently wrong in particular. Each
 * folder's real cwd is read out of the head of one of its transcripts
 * (`readSessionCwd`), which is the authoritative, non-lossy source.
 *
 * A direct consequence: two DIFFERENT candidate cwds can name the SAME physical
 * folder, which would offer every session in it twice. Sources are therefore
 * de-duplicated by the folder's resolved real path, and sessions by id.
 *
 * ## The matching heuristic, and what it cannot do
 *
 * For a REPO-BACKED project a folder matches when BOTH hold: its recorded cwd's
 * BASENAME equals the project's checkout name (`repoCheckoutName(repo)`), AND
 * that directory is a git checkout with a remote pointing at the project's repo
 * — i.e. "the user really does have their own clone of this repo elsewhere".
 *
 * The basename test alone used to be the whole rule, documented as deliberately
 * loose. It is unbounded across the filesystem, and on the dogfooding instance it
 * was reaching into a THROWAWAY QA instance's data directory: the `hushpod`
 * project offered 15 chats out of `/data/scratch/paddock-video/data/projects/
 * hushpod`, which belong to a different Paddock instance entirely (#659). "Two
 * unrelated checkouts that share a basename" turns out not to be a corner case on
 * a machine that hosts scratch copies, backups and QA clones.
 *
 * The original objection to checking the remote was cost — "running git in every
 * candidate directory is the wrong cost for a count shown in a header". That
 * objection is answered by not running git: the remote is READ out of
 * `<cwd>/.git/config`, one small file, and only for the handful of directories
 * that already passed the basename test. Results are memoised on the config
 * file's own mtime+size.
 *
 * A candidate with no readable git config, or whose remotes all point somewhere
 * else, is not offered. That is stricter than before by design — a directory that
 * is not a clone of this repo has no claim to be imported into it. The project's
 * OWN working directory is exempt: it is appended unconditionally below, so a
 * project whose checkout has an unusual remote still offers its own history.
 *
 * Still NOT identity-precise, and deliberately so: a clone the user renamed on
 * disk does not match (the basename test runs first), and a fork with a different
 * remote does not match. Both fail CLOSED — nothing is offered that shouldn't be.
 *
 * For a NOTEBOOK project the match is exact cwd equality: its working directory
 * IS the project directory, and nothing else is plausibly "the same project".
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli, readSessionCwd, type AdoptableSession } from "@herdctl/core";
import type { Project } from "./projects.js";
import { repoCheckoutName } from "./project-paths.js";

/**
 * One session on offer, with enough about it to decide (#660).
 *
 * The import used to be a single unconfirmed click, so an id was all the count
 * needed. A confirmation dialog has to show the user WHAT it is about to import —
 * and on the instance that prompted this, three quarters of the offer was things
 * the user would have declined on sight. Every field here is already computed by
 * the engine's scan; none of it costs an extra transcript parse.
 */
export interface AdoptableCandidate {
  sessionId: string;
  /** ISO 8601 last-modified time of the transcript (also the sort order). */
  mtime: string;
  /** First user message, truncated by the engine at 100 chars. */
  preview?: string;
  /** Auto-generated session name, when the transcript carries a summary. */
  autoName?: string;
  sizeBytes: number;
}

/** One working directory that has adoptable sessions, and which ones. */
export interface AdoptableSource {
  /** The working directory whose transcript folder holds these sessions. */
  sourceCwd: string;
  /**
   * Adoptable session ids, newest transcript first.
   *
   * Exactly the ids of {@link sessions}, both built from one array at one site
   * below so they cannot drift. Kept because it is the documented response shape
   * and the narrower thing most callers want.
   */
  sessionIds: string[];
  /** The same sessions, with what a confirmation dialog needs to describe them. */
  sessions: AdoptableCandidate[];
}

/** A candidate that detection deliberately did NOT offer, and why. */
export interface FilteredSession {
  sessionId: string;
  sourceCwd: string;
  reason: FilterReason;
}

/**
 * Why a candidate was withheld. All three values are OURS (paddock-side noise
 * filtering); the engine's own exclusions (sidechain / already-adopted /
 * attributed-to-run) never reach us as candidates at all.
 */
export type FilterReason = "too-small" | "slash-command-only" | "sweeper-run";

/** What a project could import right now. */
export interface AdoptableSummary {
  /** Total adoptable sessions across every source, after de-dup and filtering. */
  count: number;
  sources: AdoptableSource[];
  /**
   * Candidates withheld by the noise filter. Reported rather than dropped
   * silently so "why is the count 5 and not 7?" always has an answer.
   */
  filtered: FilteredSession[];
}

/**
 * Minimum transcript size to be worth offering, in bytes.
 *
 * Calibrated against real transcripts: ONE complete Claude Code user record
 * (uuid, parentUuid, sessionId, cwd, version, gitBranch, timestamp, message …)
 * measures ~350-450 bytes on its own. A file under 256 bytes therefore cannot
 * hold even a single complete exchange — it is a zero-byte stub or a truncated
 * fragment. The shortest genuine session in the QA corpus (one user message, no
 * reply — an aborted chat, which IS worth importing) is 396 bytes, so this sits
 * comfortably below the real floor rather than near it.
 */
export const MIN_TRANSCRIPT_BYTES = 256;

/**
 * Size ceiling under which a session that OPENS with a slash command is treated
 * as noise.
 *
 * `/mcp`, `/status`, `/cost` and friends open a session that is nothing but the
 * command and its output — real files on disk, but not conversations. The
 * preview alone cannot settle it: the engine truncates a preview at 100 chars,
 * and a session may legitimately open with `/review …` and then run for pages.
 * So the preview says "this began as a command" and the size says "and it never
 * went anywhere". 4 kB is roughly ten complete transcript records — comfortably
 * more than a command plus its output, comfortably less than a conversation.
 */
export const SLASH_COMMAND_MAX_BYTES = 4096;

/**
 * A preview that OPENS with a slash-command invocation.
 *
 * Claude Code writes an invocation either as bare text (`/mcp`) or inside the
 * `<command-name>` envelope it uses for expanded commands; both are matched.
 *
 * The trailing lookahead is what keeps an absolute PATH from reading as a
 * command: the command word must end at whitespace, at `<`, or at end-of-string,
 * so a prompt beginning `/data/projects/foo …` does not match (the `/` after
 * `/data` disqualifies it) while `/mcp`, `/mcp</command-name>` and
 * `/review the auth refactor` all do.
 */
const SLASH_COMMAND_ONLY_RE = /^\s*(?:<command-name>\s*)?\/[a-z][a-z0-9:_-]*(?![^\s<])/i;

/**
 * A preview that opens with paddock's OWN sweeper prompt (#658).
 *
 * The sweeper is a one-shot `claude -p` subprocess (`sweep.ts` `runSweeper`), so
 * it writes a perfectly ordinary transcript into the project's own chat folder.
 * When no run record binds that session — the sweeper's own history on the
 * dogfooding instance has ten such transcripts with no `session_id` in any
 * `job-*.yaml` — attribution cannot tell it from a session the user typed in a
 * terminal, and paddock ends up offering the user its own curation output as a
 * chat to "import".
 *
 * Matched on the prompt's two stable opening features: the `Project: <name>
 * (slug: <slug>)` header `buildPrompt` always emits first, and the `You are
 * curating` sentence that follows it. Both are required. The header alone is too
 * weak (a user could plausibly open a chat that way), and the sentence alone
 * would match someone quoting the sweeper prompt to talk ABOUT it.
 *
 * Whitespace between the two is `\s+` rather than `\n`: the header is followed by
 * an optional `Summary:` line and a blank line, and the engine's preview
 * normalises runs of whitespace. The wording of the sentence has already drifted
 * once ("curating two files in this project directory" → "curating this
 * project's three context files"), so only the stable `You are curating` stem is
 * matched.
 *
 * The engine truncates a preview at 100 characters, so a project whose name is
 * long enough to push `You are curating` past that boundary will not match and
 * its sweeper chats stay on offer. That is the deliberate direction to fail in:
 * a sweeper chat wrongly offered is noise the user can decline, while a real chat
 * wrongly withheld is history they cannot get at. Withheld candidates are
 * reported under `filtered` for the same reason.
 */
const SWEEPER_PROMPT_RE = /^Project: .*\(slug: [^)]*\)\s+(?:Summary:.*\s+)?You are curating\b/;

/**
 * Does this transcript preview look like paddock's own sweeper run (#658)?
 *
 * Exported so `sweeper-prompt-contract.test.ts` can assert it against the prompt
 * `SweepService` REALLY builds. The wording has drifted once already; a copy of
 * it pasted into a test here would go stale silently and take the filter with it.
 */
export function isSweeperPrompt(preview: string): boolean {
  return SWEEPER_PROMPT_RE.test(preview);
}

/** Classify a candidate as noise, or `null` to keep it. */
function filterReasonFor(session: AdoptableSession): FilterReason | null {
  if (session.sizeBytes < MIN_TRANSCRIPT_BYTES) return "too-small";
  if (session.preview !== undefined && isSweeperPrompt(session.preview)) {
    return "sweeper-run";
  }
  if (
    session.sizeBytes < SLASH_COMMAND_MAX_BYTES &&
    session.preview !== undefined &&
    SLASH_COMMAND_ONLY_RE.test(session.preview)
  ) {
    return "slash-command-only";
  }
  return null;
}

/**
 * Reduce a git remote URL to a comparable `host/path` identity (#659).
 *
 * The same repo is written many ways, and a project's `repo` field and a clone's
 * configured remote routinely disagree on form while naming the same thing:
 *
 *   https://github.com/edspencer/hushpod.git   ┐
 *   git@github.com:edspencer/hushpod           ├─ all → github.com/edspencer/hushpod
 *   ssh://git@github.com/edspencer/hushpod/    ┘
 *
 * So: drop any scheme, drop `user@`, turn the scp-style `host:path` colon into a
 * slash, drop a trailing `.git` and any trailing slashes, and lowercase. A local
 * path remote (`/srv/git/foo.git`) normalises to `/srv/git/foo` and still
 * compares correctly against itself.
 *
 * Returns `""` for anything that reduces to nothing, which never compares equal
 * to a real remote — the caller does not have to special-case it.
 */
export function normalizeRemote(url: string): string {
  let s = url.trim();
  if (s === "") return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // https://, ssh://, git://
  s = s.replace(/^[^/@]+@/, ""); // git@
  // scp-style `host:owner/repo` — but not a port (`host:22/owner/repo`) and not
  // an absolute local path, neither of which has this shape.
  s = s.replace(/^([^/:]+):(?!\/)/, "$1/");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

/**
 * Every remote URL configured in a git checkout, normalised.
 *
 * Reads `.git/config` directly rather than shelling out to git: this runs for
 * candidate directories behind a count rendered in a header, and a subprocess per
 * candidate is exactly the cost that made checking the remote look unaffordable
 * in the first place.
 *
 * Handles a linked WORKTREE, where `.git` is a FILE holding `gitdir: <path>` and
 * the config lives in the MAIN repository's git dir — found by resolving the
 * `commondir` pointer. This repo is developed with worktrees, so a contributor's
 * `wt-*` checkout is a real case, not a hypothetical.
 *
 * Returns `[]` for anything unreadable or not a checkout at all. An INI parse is
 * enough here — `url = …` inside a `[remote "…"]` section — because the question
 * is only "does any remote name this repo", not "what is the exact config".
 */
async function gitRemotes(cwd: string): Promise<string[]> {
  const dot = path.join(cwd, ".git");
  const st = await fs.stat(dot).catch(() => null);
  if (st === null) return [];

  let gitDir = dot;
  if (!st.isDirectory()) {
    const pointer = await fs.readFile(dot, "utf8").catch(() => "");
    const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
    if (m === null) return [];
    gitDir = path.resolve(cwd, m[1]);
    // A linked worktree's own git dir has no `config`; `commondir` points at the
    // main repository's git dir, which does.
    const common = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null);
    if (common !== null) gitDir = path.resolve(gitDir, common.trim());
  }

  const text = await fs.readFile(path.join(gitDir, "config"), "utf8").catch(() => null);
  if (text === null) return [];

  const out: string[] = [];
  let inRemote = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[remote\b/i.test(line);
      continue;
    }
    if (!inRemote) continue;
    const m = /^url\s*=\s*(.+)$/i.exec(line);
    if (m === null) continue;
    const url = normalizeRemote(m[1]);
    if (url !== "") out.push(url);
  }
  return out;
}

/** The engine surface this module needs — narrowed so tests can fake it. */
export interface AdoptableFleet {
  listAdoptableSessions(agentName: string, fromWorkingDir?: string): Promise<AdoptableSession[]>;
}

/** A path's cache identity: its mtime + size, or `"-"` when absent. Used for
 *  directories (has the file SET changed) and for single files alike. */
async function dirKey(dir: string): Promise<string> {
  const st = await fs.stat(dir).catch(() => null);
  return st ? `${st.mtimeMs}:${st.size}` : "-";
}

interface FolderEntry {
  /** Folder name under `<claudeHome>/projects/`. */
  name: string;
  /** Absolute path, symlinks resolved — the de-dup identity for a source. */
  realPath: string;
  /** `mtimeMs:size` of the folder, i.e. "has its file SET changed". */
  key: string;
  /** The cwd recorded inside one of its transcripts, or `null` if unknowable. */
  cwd: string | null;
}

/**
 * Per-instance adoptable-session detector with an mtime-keyed cache.
 *
 * ## What is cached, and why the key is sound
 *
 * The expensive work is (a) reading one transcript head per transcript folder on
 * the machine to recover its cwd, and (b) an engine scan per matched source. The
 * cheap work — one `readdir` plus a `stat` per folder — always runs, and
 * produces the key.
 *
 * A cached answer is reused only while ALL of these are unchanged:
 *
 *  - `<claudeHome>/projects` mtime+size — a transcript folder appeared or went.
 *  - each MATCHED folder's mtime+size — a transcript appeared or went inside it.
 *  - `<stateDir>/adopted-sessions` mtime+size — something was adopted/released,
 *    which is exactly what removes a session from the adoptable set.
 *  - `<stateDir>/jobs` mtime+size — a run completed, and a run record is what
 *    flips a native session to `attributed-to-run` (also excluded).
 *
 * Directory mtime changes when an entry is added or removed, NOT when an
 * existing file is appended to — and appending to a transcript cannot change
 * whether it is adoptable, so that granularity is precisely right rather than
 * merely cheap. The one residual is an in-memory platform binding taken without
 * touching either state dir; {@link invalidate} is called after every import for
 * the case that actually matters.
 */
export class AdoptableIndex {
  /** folder name → last-seen entry, reused while its `key` is unchanged. */
  private readonly folders = new Map<string, FolderEntry>();
  /**
   * checkout dir → its normalised remotes, memoised on the git config's own
   * mtime+size (#659). Keyed on the config rather than the transcript folder
   * because that is the file whose CHANGE would change the answer: adding or
   * re-pointing a remote must be picked up, and it does not touch `~/.claude`.
   */
  private readonly remotes = new Map<string, { key: string; urls: string[] }>();
  /** project key → cached summary + the composite key it was computed under. */
  private readonly summaries = new Map<string, { key: string; summary: AdoptableSummary }>();

  constructor(
    private readonly claudeHomePath: string,
    private readonly stateDir: string,
  ) {}

  /**
   * Drop a project's cached summary (or every project's, with no argument).
   * Called after an import, which changes the adoptable set in a way the caller
   * already knows about and shouldn't have to wait for a directory mtime to
   * reveal.
   *
   * NOTE the workspace key may be `""` (the root workspace) — this takes a
   * string and tests `undefined` explicitly, never truthiness.
   */
  invalidate(projectKey?: string): void {
    if (projectKey === undefined) this.summaries.clear();
    else this.summaries.delete(projectKey);
  }

  /**
   * Enumerate `<claudeHome>/projects/*`, refreshing the recorded cwd only for
   * folders whose file set changed since last time.
   */
  private async scanFolders(): Promise<FolderEntry[]> {
    const root = path.join(this.claudeHomePath, "projects");
    const names = await fs.readdir(root).catch(() => [] as string[]);
    const out: FolderEntry[] = [];
    for (const name of names) {
      const dir = path.join(root, name);
      const st = await fs.stat(dir).catch(() => null);
      if (!st?.isDirectory()) continue;
      const key = `${st.mtimeMs}:${st.size}`;
      const cached = this.folders.get(name);
      if (cached && cached.key === key) {
        out.push(cached);
        continue;
      }
      const entry: FolderEntry = {
        name,
        realPath: await fs.realpath(dir).catch(() => dir),
        key,
        cwd: await recordedCwd(dir),
      };
      this.folders.set(name, entry);
      out.push(entry);
    }
    // Forget folders that no longer exist, so the map can't grow without bound.
    const live = new Set(out.map((e) => e.name));
    for (const name of [...this.folders.keys()]) if (!live.has(name)) this.folders.delete(name);
    return out;
  }

  /**
   * A checkout's normalised git remotes, memoised on its config's mtime+size.
   *
   * The memo is keyed by directory and re-validated on every call, so a remote
   * added or re-pointed after the last scan is picked up without waiting for
   * anything in `~/.claude` to change.
   */
  private async remotesFor(cwd: string): Promise<string[]> {
    // Cheap enough to re-key every time: two `stat`s. Both halves are needed —
    // `.git/config` is the file that answers the question for an ordinary
    // checkout, and `.git` itself covers a linked worktree, where `.git` is a
    // FILE and `.git/config` does not exist at all.
    const key = [
      await dirKey(path.join(cwd, ".git")),
      await dirKey(path.join(cwd, ".git", "config")),
    ].join("|");
    const cached = this.remotes.get(cwd);
    if (cached && cached.key === key) return cached.urls;
    const urls = await gitRemotes(cwd);
    this.remotes.set(cwd, { key, urls });
    return urls;
  }

  /**
   * The candidate source working directories for a project, de-duplicated by the
   * transcript folder they resolve to.
   *
   * ORIGIN-FIRST ordering (see {@link adoptableFor}'s session de-dup): matched
   * external checkouts come first, the project's own working directory last.
   */
  private async candidateSources(project: Project, folders: FolderEntry[]): Promise<string[]> {
    const own = project.workingDir;
    const ownFolder = path.join(this.claudeHomePath, "projects", encodePathForCli(own));
    const ownReal = await fs.realpath(ownFolder).catch(() => ownFolder);

    const repo = project.repo !== undefined && project.repo !== "" ? project.repo : null;
    const wantRemote = repo === null ? "" : normalizeRemote(repo);

    /** The CHEAP test: worth reading a git config for? */
    const nameMatches = (cwd: string): boolean => {
      if (cwd === own) return true;
      // Repo-backed: "the user's own clone of the same repo". A necessary but
      // NOT sufficient condition — `remoteMatches` below is the other half.
      if (repo !== null) return path.basename(cwd) === repoCheckoutName(repo);
      // Notebook: exact cwd equality only.
      return false;
    };

    const seen = new Set<string>([ownReal]);
    const sources: string[] = [];
    for (const folder of folders) {
      if (folder.cwd === null || !nameMatches(folder.cwd)) continue;
      if (seen.has(folder.realPath)) continue;
      // A same-named directory has to prove it is a clone of THIS repo (#659).
      // Only reached for repo-backed projects, and only after the basename test,
      // so this is a handful of small file reads rather than a filesystem sweep.
      if (repo !== null && folder.cwd !== own) {
        const urls = await this.remotesFor(folder.cwd);
        if (!urls.includes(wantRemote)) continue;
      }
      seen.add(folder.realPath);
      sources.push(folder.cwd);
    }
    // The project's own working directory goes LAST so that a session offered by
    // both it and an external checkout is attributed to the external one — the
    // origin, where the transcript actually lives, so a copy has something to
    // copy (#588 gotcha 2).
    sources.push(own);
    return sources;
  }

  /**
   * What `project` could import, as served by the `adoptable-chats` endpoint.
   *
   * `agentName` is the adopting agent (the project's keeper); it is the metadata
   * cache key the engine warms titles/previews under, so detection and the later
   * adoption agree.
   */
  async adoptableFor(
    fleet: AdoptableFleet,
    project: Project,
    agentName: string,
  ): Promise<AdoptableSummary> {
    const folders = await this.scanFolders();
    const sources = await this.candidateSources(project, folders);

    // Sentinel for "this folder recorded no cwd": it must be a string no real
    // source can equal, and `""` will not do — the root workspace's key is `""`,
    // so an empty cwd is a value that genuinely occurs here. Written as the
    // escape, never a raw NUL byte: a raw NUL makes ripgrep classify the whole
    // file as binary and skip it, so the file vanishes from code search (#570).
    const matchedKeys = folders
      .filter((f) => sources.includes(f.cwd ?? "\u0000"))
      .map((f) => `${f.name}=${f.key}`)
      .sort();
    const key = [
      await dirKey(path.join(this.claudeHomePath, "projects")),
      await dirKey(path.join(this.stateDir, "adopted-sessions")),
      await dirKey(path.join(this.stateDir, "jobs")),
      ...matchedKeys,
    ].join("|");

    const cached = this.summaries.get(project.slug);
    if (cached && cached.key === key) return cached.summary;

    const seen = new Set<string>();
    const out: AdoptableSource[] = [];
    const filtered: FilteredSession[] = [];
    let count = 0;
    for (const sourceCwd of sources) {
      // Fault-isolated per source: an unreadable folder costs its own sessions,
      // not the whole count.
      const sessions = await fleet.listAdoptableSessions(agentName, sourceCwd).catch(() => []);
      const candidates: AdoptableCandidate[] = [];
      for (const session of sessions) {
        // De-dup by session id. Two candidate cwds can collide onto one folder
        // under the lossy encoding, and a transcript may have been copied; either
        // way one session must be offered once.
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        const reason = filterReasonFor(session);
        if (reason !== null) {
          filtered.push({ sessionId: session.sessionId, sourceCwd, reason });
          continue;
        }
        candidates.push({
          sessionId: session.sessionId,
          mtime: session.mtime,
          preview: session.preview,
          autoName: session.autoName,
          sizeBytes: session.sizeBytes,
        });
      }
      if (candidates.length > 0) {
        // Both projections built HERE, from one array, so `sessionIds` can never
        // disagree with `sessions`.
        out.push({
          sourceCwd,
          sessionIds: candidates.map((c) => c.sessionId),
          sessions: candidates,
        });
        count += candidates.length;
      }
    }

    const summary: AdoptableSummary = { count, sources: out, filtered };
    this.summaries.set(project.slug, { key, summary });
    return summary;
  }
}

/**
 * The cwd recorded inside a transcript folder, by reading the head of its
 * newest-looking `.jsonl`.
 *
 * Every session in a folder shares the encoded cwd, so ONE read identifies the
 * folder. Files are tried in readdir order until one yields a cwd, because a
 * zero-byte or truncated transcript records none (the QA corpus has both).
 */
async function recordedCwd(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const cwd = await readSessionCwd(path.join(dir, entry)).catch(() => null);
    if (cwd !== null && cwd !== "") return cwd;
  }
  return null;
}
