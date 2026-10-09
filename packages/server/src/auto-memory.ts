/**
 * The agent memory directory, handed to Claude Code as `autoMemoryDirectory` (#955).
 *
 * Claude Code always lets an agent write to its own auto-memory dir, which by
 * default is `<claudeHome>/projects/<enc(root)>/memory/`. Paddock makes
 * `<claudeHome>/projects/<enc>` a SYMLINK (to `.chats/` under `transcripts:
 * own`, into `~/.claude` under `host` — see `transcripts.ts`), and the harness
 * checks a write by resolving symlinks first. The resolved path no longer
 * starts with the configured (unresolved) memory dir, so the exemption misses
 * and a memory write is judged as an ordinary write to wherever it resolves.
 *
 * Under `own` that is `.chats/`, which the keeper's inherited `Write` allow rule
 * happens to cover, so the miss is invisible. Under `host` it is the user's
 * `~/.claude/projects/…`, a protected path that no allow rule can pre-approve:
 * "…which is a sensitive file … resolves through a symlink…", denied, with
 * nobody there to approve it. Reproduced on CLI 2.1.216 and 2.1.282 against a
 * stub API, and on a running instance; see the PR. The fix is applied in both
 * modes, because `own` only works by accident of the allowlist.
 *
 * The fix is to tell Claude Code the memory dir's REAL path, so the literal and
 * resolved paths agree. It has to travel as a flag-tier setting (herdctl's agent
 * `settings`): Claude Code ignores `autoMemoryDirectory` in a checked-in
 * `.claude/settings.json`, paddock's SDK agents never load the user source, and
 * the `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env alternative switches the write
 * exemption off altogether.
 *
 * ## Which directory — deliberately the one Claude Code already picks
 *
 * This changes how the memory dir is SPELLED, never which one it is. Claude
 * Code keys memory on the canonical git root of the cwd — the MAIN worktree's
 * root, for a subdirectory or a linked worktree alike — and on the cwd itself
 * outside git (verified against the binary: the system prompt names the same
 * `projects/<enc(repo)>/memory/` for `repo`, `repo/sub` and a worktree of it).
 * So {@link memoryRoot} reproduces that, and notebook projects that sit inside
 * one notes repo keep sharing that repo's memory, exactly as before. Re-keying
 * memory per project is a separate decision.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { encodePathForCli } from "@herdctl/core";

const run = promisify(execFile);

/**
 * The directory Claude Code keys auto-memory on for an agent started in
 * `workingDir`: the main worktree's root when `workingDir` is in a git repo,
 * else `workingDir` itself.
 *
 * `--git-common-dir` is what makes a linked worktree resolve to the MAIN
 * checkout (its common dir is the main `.git`); `--show-toplevel` covers the
 * layouts where the common dir is not a `<root>/.git` (submodules, a separate
 * git dir). Any git failure — no binary, not a repo — falls back to the cwd,
 * which is Claude Code's own fallback.
 */
export async function memoryRoot(workingDir: string): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { cwd: workingDir },
    );
    const [commonDir, topLevel] = stdout.trim().split("\n");
    if (commonDir && path.basename(commonDir) === ".git") return path.dirname(commonDir);
    if (topLevel) return topLevel;
  } catch {
    // not a repo, or no git — Claude Code falls back to the cwd too
  }
  return workingDir;
}

/**
 * `fs.realpath` for a path that may not fully exist yet: resolve the deepest
 * existing ancestor and re-append the rest. The memory dir itself is created
 * lazily by Claude Code on first write, so it is usually missing at boot — but
 * the symlink above it, which is the part that matters, is already planted.
 */
export async function realpathLenient(p: string): Promise<string> {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * The symlink-free auto-memory dir for an agent whose Claude home is
 * `claudeHome` and whose cwd is `workingDir`. Call it AFTER the project's
 * transcript symlink is planted, or it resolves to the pre-symlink location.
 */
export async function resolveAutoMemoryDir(
  claudeHome: string,
  workingDir: string,
): Promise<string> {
  const root = await memoryRoot(workingDir);
  return realpathLenient(
    path.join(claudeHome, "projects", encodePathForCli(root), "memory"),
  );
}
