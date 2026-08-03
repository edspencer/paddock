/**
 * `--here` support: opening the user's own directory as a Paddock workspace (#640).
 *
 * ## Why this needs no new concept
 *
 * A *project* cannot live outside `projectsRoot` — `dirFor` joins the key onto
 * the root with no branch, deliberately. But the **root workspace** is a
 * different thing: its key is `""`, so `dirFor("")` resolves to `projectsRoot`
 * itself, and `projectsRoot` is user-configurable. Pointing
 * `PADDOCK_PROJECTS_DIR` at a directory therefore makes that directory the root
 * workspace, named after its own basename, with no schema change anywhere.
 *
 * Session adoption then works by construction: `AdoptableIndex`'s notebook
 * branch matches on exact `cwd === project.workingDir` equality, and in this
 * mode the workspace's working directory IS the user's cwd.
 *
 * ## Why the data dir goes inside the directory
 *
 * `--here` puts state in `<dir>/.paddock` rather than the shared `~/.paddock`.
 * Two reasons, and the second is the important one:
 *
 *  1. **Self-containment.** Opening directory A and later directory B must not
 *     have them share one job store, herdctl config and sidecar set — that is
 *     how A's run history leaks into B's UI.
 *  2. **It gives us an unambiguous marker.** A second, flagless run in the same
 *     directory should resume it (the `git` model: `--here` is `git init`,
 *     `.paddock/` is `.git`). Keying that off `project.yaml` would be ambiguous
 *     — that filename already exists in the wild, including in every project
 *     directory of the `edspencer/projects` notes repo — whereas `.paddock/` is
 *     ours and its presence means exactly one thing.
 */
import fs from "node:fs";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";
import { MIN_TRANSCRIPT_BYTES } from "../adoptable.js";

/** Directory name that both stores `--here` state and marks the workspace. */
export const HERE_MARKER = ".paddock";

/** Has this directory been opened with `--here` before? */
export function isHereWorkspace(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, HERE_MARKER)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * How many of `dir`'s existing Claude Code sessions are worth offering.
 *
 * **`encodePathForCli`, not `transcripts.ts`'s `encodeProjectDir`.** The latter
 * omits Claude Code's truncate-and-hash branch for paths over 200 characters,
 * on the explicit assumption that "paddock's project dirs are always short".
 * An arbitrary user directory is exactly where that assumption fails.
 *
 * `MIN_TRANSCRIPT_BYTES` is shared with `AdoptableIndex` so the number quoted
 * here matches what the UI will actually offer to import — a count that
 * disagreed with the import screen would be worse than no count.
 */
export function countClaudeSessions(claudeHome: string, dir: string): number {
  const folder = path.join(claudeHome, "projects", encodePathForCli(dir));
  let entries: string[];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    try {
      if (fs.statSync(path.join(folder, entry)).size >= MIN_TRANSCRIPT_BYTES) n++;
    } catch {
      /* raced or unreadable — not offerable either way */
    }
  }
  return n;
}

/**
 * Add `entry` to `dir`'s `.gitignore` if no equivalent line is already there.
 *
 * Mirrors `ProjectStore.ensureRootGitignore`: read, tolerate the equivalent
 * forms, append rather than overwrite. `--here` runs inside somebody's real
 * repository, so clobbering their `.gitignore` is not an option.
 */
export function ensureGitignored(dir: string, entry: string): void {
  const file = path.join(dir, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  const bare = entry.replace(/^\/|\/$/g, "");
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  if (have.has(`/${bare}/`) || have.has(`${bare}/`) || have.has(bare)) return;
  const body = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  fs.writeFileSync(file, `${body}${entry}\n`, "utf8");
}
