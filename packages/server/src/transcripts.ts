/**
 * Transcript relocation (backing-store Phase 3).
 *
 * Claude Code writes a session transcript to `<claudeHome>/projects/<encoded-cwd>/`,
 * where `<claudeHome>` is `CLAUDE_CONFIG_DIR` (paddock's own `<dataDir>/claude-home`
 * since #620) and `<encoded-cwd>` is the agent's absolute working directory with every
 * non-[A-Za-z0-9] char replaced by '-'. That makes transcripts path-coupled and
 * not portable. We relocate them INTO the project by making the encoded path a
 * **symlink to `<projectDir>/.chats/`** — Claude then writes through the symlink
 * into the project dir (validated empirically), and herdctl's discovery, resume,
 * delete and rename all resolve through it transparently. The project dir becomes
 * self-contained and travels with the repo / NAS.
 *
 * `ensureProjectChats` is idempotent and self-healing: on first run for a project
 * whose encoded path is still a real directory (existing transcripts), it migrates
 * those files into `.chats/` and replaces the directory with the symlink.
 */
import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

/**
 * Encode a working directory the way Claude Code names its transcript dir.
 * For paths under 200 chars this is just the non-alphanumeric→'-' replacement
 * (paddock's project dirs are always short, so the truncate+hash branch Claude
 * Code uses for very long paths never applies here).
 */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute path to the project's local transcript directory. */
export function projectChatsDir(projectDir: string): string {
  return path.join(projectDir, ".chats");
}

/**
 * Ensure `<chatsHostDir>/.chats/` exists and that Claude Code's encoded
 * transcript path for `workingDir` is a symlink pointing at it (migrating an
 * existing real transcript dir in the process). Safe to call on every agent
 * registration. Never throws — a failure here must not block agent registration
 * or chat.
 *
 * `workingDir` is the agent's cwd (which Claude encodes into the transcript dir
 * name); `chatsHostDir` is where the `.chats/` store actually lives. For a
 * notebook project these are the same dir (the default). For a REPO-BACKED
 * project (issue #187) the keeper's cwd is the nested checkout but the `.chats/`
 * store stays in the project's metadata dir (the data repo) — so transcripts
 * never pollute the external repo's working tree — hence the two are split.
 *
 * `home.path` is the Claude home to plant the symlink in, and it is REQUIRED —
 * no default (#620). Callers must pass `cfg.claudeHome`: the engine is
 * constructed with that same resolved value, and a symlink planted in a
 * different home than the one the engine reads is exactly the "chats list but
 * open empty" failure (#588). It used to default to the env-derived home for
 * callers with no config, and `ensureSweeperHome` silently took that default —
 * so the sweeper's symlink landed in a different home than every other agent's.
 * Making the parameter required is what stops that class of bug at the type
 * level.
 *
 * `home.owned` gates EVERY write into the home (#620, #682). Two of them:
 *
 *  - Migrating an existing real transcript directory into `.chats/` copies the
 *    files and then REMOVES the originals. That is correct self-healing inside a
 *    home paddock owns, where such a directory can only be paddock's own doing.
 *    Inside the user's `~/.claude` it is somebody else's data — a `claude` CLI
 *    session run in a directory paddock happens to also manage — so we leave it
 *    strictly alone and let the SDK keep writing there.
 *  - Planting the redirect symlink at a path that does not exist yet. Not
 *    destructive on the day it happens, which is why it was missed, but it
 *    silently claims where the user's FUTURE sessions for that directory get
 *    written (#682). See the branch itself for the full argument.
 *
 * Either way those transcripts stay importable through adoption (#588), which is
 * the deliberate, user-driven version of the same move.
 */
export interface ClaudeHomeTarget {
  /** Absolute path to the Claude home to plant the redirect symlink in. */
  path: string;
  /** Whether paddock owns this home — see `PaddockConfig.ownsClaudeHome`. */
  owned: boolean;
}

export async function ensureProjectChats(
  workingDir: string,
  chatsHostDir: string,
  home: ClaudeHomeTarget,
): Promise<void> {
  const claudeHomePath = home.path;
  try {
    const chatsDir = projectChatsDir(chatsHostDir);
    await fs.mkdir(chatsDir, { recursive: true });

    const encoded = path.join(claudeHomePath, "projects", encodeProjectDir(workingDir));
    await fs.mkdir(path.dirname(encoded), { recursive: true });

    const st = await fs.lstat(encoded).catch(() => null);

    // Already a symlink — point it at .chats if it drifted, else done.
    if (st?.isSymbolicLink()) {
      const target = await fs.readlink(encoded).catch(() => "");
      const resolved = path.resolve(path.dirname(encoded), target);
      if (resolved !== path.resolve(chatsDir)) {
        await fs.rm(encoded, { force: true });
        await fs.symlink(chatsDir, encoded);
      }
      return;
    }

    // A real directory of existing transcripts. In a home paddock does NOT own
    // these are the user's own CLI transcripts (#620) — leave them exactly where
    // they are. The SDK keeps reading and appending to them, and adoption is how
    // the user pulls them into the project if they want to. Bailing here also
    // means we never plant a symlink over them.
    if (st?.isDirectory() && !home.owned) return;

    // A real directory of existing transcripts — migrate into .chats, then link.
    if (st?.isDirectory()) {
      for (const entry of await fs.readdir(encoded)) {
        const from = path.join(encoded, entry);
        const to = path.join(chatsDir, entry);
        if (await fs.lstat(to).then(() => true).catch(() => false)) continue; // don't clobber
        // cp+rm is robust across filesystems (rename would EXDEV across mounts).
        // `preserveTimestamps` is load-bearing, not cosmetic (#588): fs.cp
        // defaults to stamping the copy with NOW, and a transcript's mtime is
        // both the chat-list sort key and the cache key for auto-name / preview /
        // sidechain detection — so without it, relocating a months-old archive
        // collapses every one of those chats to "today".
        await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
        await fs.rm(from, { recursive: true, force: true });
      }
      await fs.rmdir(encoded).catch(() => undefined);
      await fs.symlink(chatsDir, encoded);
      return;
    }

    // Nothing there yet. In a home paddock does NOT own, planting here is the
    // data-loss branch (#682): the encoded path is where the USER's future
    // `claude` sessions for this directory land, so a link redirects every one of
    // them into paddock's `.chats/` — from that moment "their history" and "our
    // store" are the same files, and an ordinary `rm -rf .chats` destroys
    // transcripts paddock never owned. It also breaks unrelated tooling that
    // expects `~/.claude/projects/<enc>` to be a directory. Creating a name the
    // user has not used yet is not "overwriting", so it slipped past the letter
    // of claude-home.ts's invariant while breaking its intent.
    //
    // The cost of bailing is that transcripts stay in the user's home instead of
    // being self-contained in `.chats/`, which is exactly the pre-#620 trade for
    // the `CLAUDE_HOME=~/.claude` escape hatch. Chat still works end to end:
    // paddock and the engine both resolve THIS home, so discovery, resume and
    // rename all read the real directory. Adoption (#588) remains the deliberate,
    // user-driven way to pull those transcripts into a project.
    if (!home.owned) return;

    // Nothing there yet — just create the symlink so future turns land in .chats.
    await fs.symlink(chatsDir, encoded);
  } catch {
    /* non-fatal: fall back to Claude Code's default location for this project */
  }
}

/**
 * Read a session's FIRST user message text, untruncated, straight from its
 * transcript JSONL (issue #62). Claude Code's own `preview` is capped at 100
 * chars — for a preload chat that cap falls inside the injected OVERVIEW block,
 * so the preview can't be un-wrapped. Reading the full first user message lets
 * the chat-list strip the wrapper and show the user's real request.
 *
 * Streams line-by-line and stops at the first user text, so it only reads the
 * head of the file. Returns undefined if the transcript is missing/unreadable or
 * has no user text. The sessionId is validated to keep it inside `.chats/`.
 */
export async function readFirstUserText(
  projectDir: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined;
  const file = path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`);
  const stream = createReadStream(file, { encoding: "utf8" });
  // A missing/unreadable file rejects on the stream; swallow and return undefined.
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: { type?: string; message?: { content?: unknown } };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed.type !== "user") continue;
      const text = extractUserText(parsed.message?.content);
      if (text) return text;
    }
  } catch {
    return undefined;
  } finally {
    rl.close();
    stream.destroy();
  }
  return undefined;
}

/**
 * Text of a transcript user message's `content` (string, or an array of blocks).
 * A message carrying tool_result blocks isn't a real prompt — return "" so the
 * caller skips it.
 */
function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((b) => (b as { type?: string })?.type === "tool_result")) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => {
      const blk = b as { type?: string; text?: unknown };
      return blk?.type === "text" && typeof blk.text === "string";
    })
    .map((b) => b.text)
    .join("");
}
