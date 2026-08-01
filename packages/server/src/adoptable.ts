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
 *  2. **Filter low-value noise** — a zero-byte transcript or a session that is
 *     nothing but a `/mcp` slash command is not a chat anyone wants imported.
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
 * For a REPO-BACKED project a folder matches when its recorded cwd's BASENAME
 * equals the project's checkout name (`repoCheckoutName(repo)`) — i.e. "the user
 * has their own clone of this repo elsewhere". This is deliberately simple and
 * is NOT identity-precise: two unrelated checkouts that happen to share a
 * basename (`~/work/api` and `~/oss/api`) both match, and a clone the user
 * renamed on disk does not match at all. Verifying the checkout's git remote
 * would be exact; it also means running git in every candidate directory, which
 * is the wrong cost for a count shown in a header. Noted as a known limit
 * (#588 gotcha 6) rather than pretended away — the import is per-source, so a
 * user who sees a source they don't recognise can decline it.
 *
 * For a NOTEBOOK project the match is exact cwd equality: its working directory
 * IS the project directory, and nothing else is plausibly "the same project".
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli, readSessionCwd, type AdoptableSession } from "@herdctl/core";
import type { Project } from "./projects.js";
import { repoCheckoutName } from "./project-paths.js";

/** One working directory that has adoptable sessions, and which ones. */
export interface AdoptableSource {
  /** The working directory whose transcript folder holds these sessions. */
  sourceCwd: string;
  /** Adoptable session ids, newest transcript first. */
  sessionIds: string[];
}

/** A candidate that detection deliberately did NOT offer, and why. */
export interface FilteredSession {
  sessionId: string;
  sourceCwd: string;
  reason: FilterReason;
}

/**
 * Why a candidate was withheld. Both values are OURS (paddock-side noise
 * filtering); the engine's own exclusions (sidechain / already-adopted /
 * attributed-to-run) never reach us as candidates at all.
 */
export type FilterReason = "too-small" | "slash-command-only";

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

/** Classify a candidate as noise, or `null` to keep it. */
function filterReasonFor(session: AdoptableSession): FilterReason | null {
  if (session.sizeBytes < MIN_TRANSCRIPT_BYTES) return "too-small";
  if (
    session.sizeBytes < SLASH_COMMAND_MAX_BYTES &&
    session.preview !== undefined &&
    SLASH_COMMAND_ONLY_RE.test(session.preview)
  ) {
    return "slash-command-only";
  }
  return null;
}

/** The engine surface this module needs — narrowed so tests can fake it. */
export interface AdoptableFleet {
  listAdoptableSessions(agentName: string, fromWorkingDir?: string): Promise<AdoptableSession[]>;
}

/** A directory's cache identity: its mtime + size, or `null` when absent. */
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

    const matches = (cwd: string): boolean => {
      if (cwd === own) return true;
      // Repo-backed: "the user's own clone of the same repo", matched by the
      // checkout basename. Deliberately loose — see the module header.
      if (project.repo !== undefined && project.repo !== "") {
        return path.basename(cwd) === repoCheckoutName(project.repo);
      }
      // Notebook: exact cwd equality only.
      return false;
    };

    const seen = new Set<string>([ownReal]);
    const sources: string[] = [];
    for (const folder of folders) {
      if (folder.cwd === null || !matches(folder.cwd)) continue;
      if (seen.has(folder.realPath)) continue;
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

    const matchedKeys = folders
      .filter((f) => sources.includes(f.cwd ?? " "))
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
      const ids: string[] = [];
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
        ids.push(session.sessionId);
      }
      if (ids.length > 0) {
        out.push({ sourceCwd, sessionIds: ids });
        count += ids.length;
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
