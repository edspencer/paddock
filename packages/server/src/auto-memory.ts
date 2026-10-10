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
 * This changes how the memory dir is SPELLED, never which one it is, so no
 * existing memory moves. Claude Code keys memory on the canonical git root of
 * its (realpath'd) cwd: the nearest ancestor holding a `.git`, or for a linked
 * worktree the MAIN checkout it belongs to, and the cwd itself outside git.
 * {@link memoryRoot} is a port of that filesystem walk, NOT a `git rev-parse`:
 * git disagrees with it whenever git refuses or is absent (another uid's repo —
 * "dubious ownership" —, no git binary, inherited `GIT_DIR`, git < 2.31 without
 * `--path-format`), and every disagreement silently re-keys memory. Notebook
 * projects inside one notes repo therefore keep sharing that repo's memory,
 * exactly as before. Re-keying memory per project is a separate decision.
 *
 * ## The setting is a write grant, so it is contained
 *
 * Claude Code lets an agent write `*.md` under its memory dir without approval,
 * including into protected paths like `~/.claude/…`. So the realpath is only
 * accepted where paddock itself points that link: a real `projects/<enc>` dir in
 * paddock's own home, a `.chats` store, or the user's `~/.claude/projects/<enc>`
 * under `host`. A symlink planted elsewhere — at `memory`, or over a `.chats`
 * store, by an agent with Bash or committed in a notes repo — could otherwise aim
 * the grant anywhere. {@link resolveAutoMemoryDir} refuses those layouts and
 * returns undefined, leaving the agent on Claude Code's default.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";

/** Does `<dir>/.git` exist as a directory or file (following a symlink)? */
async function hasGitEntry(dir: string): Promise<boolean> {
  const st = await fs.stat(path.join(dir, ".git")).catch(() => null);
  return !!st && (st.isDirectory() || st.isFile());
}

/** Is `p` itself a symlink (not followed)? */
async function isSymlink(p: string): Promise<boolean> {
  const st = await fs.lstat(p).catch(() => null);
  return !!st?.isSymbolicLink();
}

/** Read a small text file, or undefined. */
async function readText(p: string): Promise<string | undefined> {
  return fs.readFile(p, "utf8").then(
    (s) => s.trim(),
    () => undefined,
  );
}

/**
 * Claude Code's canonical-root rule for a `.git` FILE (a linked worktree): follow
 * `gitdir:` to `<main>/.git/worktrees/<name>`, its `commondir` back to the main
 * `.git`, and require the worktree's `gitdir` back-pointer to name this
 * checkout. Anything that does not check out — a submodule, whose gitdir has no
 * `commondir`, or a hand-edited file — keys on the checkout itself.
 */
async function canonicalRoot(root: string): Promise<string> {
  const dotGit = await readText(path.join(root, ".git"));
  if (!dotGit?.startsWith("gitdir:")) return root;
  const gitDir = path.resolve(root, dotGit.slice("gitdir:".length).trim());
  const common = await readText(path.join(gitDir, "commondir"));
  if (!common) return root;
  const commonDir = path.resolve(gitDir, common);
  if (path.dirname(gitDir) !== path.join(commonDir, "worktrees")) return root;
  const back = await readText(path.join(gitDir, "gitdir"));
  if (!back) return root;
  const [backReal, rootReal] = await Promise.all([
    realpathLenient(path.resolve(gitDir, back)),
    realpathLenient(root),
  ]);
  if (backReal !== path.join(rootReal, ".git")) return root;
  if (path.basename(commonDir) === ".git") return path.dirname(commonDir);
  // A bare main repo (`commondir` not named `.git`) keys on the common dir
  // itself — unless it in turn holds a `.git`, which Claude Code declines.
  return (await hasGitEntry(commonDir)) ? root : commonDir;
}

/**
 * The directory Claude Code keys auto-memory on for an agent started in
 * `workingDir`: the canonical git root above it, else the cwd. Starts from the
 * realpath, as Claude Code's own `process.cwd()` does. Filesystem only — no git
 * subprocess, so nothing here can hang on, or be redirected by, git.
 */
export async function memoryRoot(workingDir: string): Promise<string> {
  const start = await realpathLenient(workingDir);
  for (let dir = start; ; ) {
    if (await hasGitEntry(dir)) return canonicalRoot(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
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
 * `claudeHome` and whose cwd is `workingDir`, or undefined when the `memory`
 * entry is itself a symlink (see the module doc). Call it AFTER every project's
 * transcript symlink is planted — a notebook project's memory root is usually
 * ANOTHER workspace's link (the notes repo's), not its own.
 */
export async function resolveAutoMemoryDir(
  claudeHome: string,
  workingDir: string,
  userHome?: string,
): Promise<string | undefined> {
  const root = await memoryRoot(workingDir);
  const enc = encodePathForCli(root);
  const literal = path.join(claudeHome, "projects", enc);
  const base = await realpathLenient(literal);
  const expected =
    // a real dir in paddock's own home: no link was followed
    !(await isSymlink(literal)) ||
    // a `.chats` store (`own`), or the user's own folder for it (`host`)
    path.basename(base) === ".chats" ||
    (!!userHome && base === path.join(await realpathLenient(userHome), "projects", enc));
  if (!expected) return undefined;
  const memory = path.join(base, "memory");
  const st = await fs.lstat(memory).catch(() => null);
  if (st && !st.isDirectory()) return undefined;
  return memory;
}
