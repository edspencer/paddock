/**
 * Transcript relocation (backing-store Phase 3).
 *
 * Claude Code writes a session transcript to `~/.claude/projects/<encoded-cwd>/`,
 * where `<encoded-cwd>` is the agent's absolute working directory with every
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
 *
 * When an agent's cwd MOVES, the encoded bucket name changes with it. That is
 * handled by pointing the new bucket at the SAME `.chats/` store (no chat file
 * moves) and retiring the old pointer — {@link ensureScratchChats} /
 * {@link retireChatsLink}, added for the root-agent cwd move in issue #512.
 */
import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { claudeHome } from "./config.js";

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
 */
export async function ensureProjectChats(
  workingDir: string,
  chatsHostDir: string = workingDir,
): Promise<void> {
  try {
    const chatsDir = projectChatsDir(chatsHostDir);
    await fs.mkdir(chatsDir, { recursive: true });

    const encoded = path.join(claudeHome(), "projects", encodeProjectDir(workingDir));
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

    // A real directory of existing transcripts — migrate into .chats, then link.
    if (st?.isDirectory()) {
      await foldTranscriptsInto(encoded, chatsDir);
      await fs.rmdir(encoded).catch(() => undefined);
      await fs.symlink(chatsDir, encoded);
      return;
    }

    // Nothing there yet — just create the symlink so future turns land in .chats.
    await fs.symlink(chatsDir, encoded);
  } catch {
    /* non-fatal: fall back to Claude Code's default location for this project */
  }
}

/**
 * Move every entry of a real transcript dir into `chatsDir`, NEVER clobbering an
 * entry that is already there (the pre-existing `.chats/` copy always wins).
 * Shared by {@link ensureProjectChats} and {@link retireChatsLink} so both
 * migrations have identical, one-place semantics.
 */
async function foldTranscriptsInto(fromDir: string, chatsDir: string): Promise<void> {
  for (const entry of await fs.readdir(fromDir)) {
    const from = path.join(fromDir, entry);
    const to = path.join(chatsDir, entry);
    if (await fs.lstat(to).then(() => true).catch(() => false)) continue; // don't clobber
    // cp+rm is robust across filesystems (rename would EXDEV across mounts).
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/**
 * Retire the encoded transcript pointer of a directory that is NO LONGER any
 * agent's cwd — without ever losing a transcript. The inverse of
 * {@link ensureProjectChats}, used when an agent's working directory MOVES.
 *
 * - A **real directory** (an instance that predates the `.chats/` relocation)
 *   has its transcripts folded into `<chatsHostDir>/.chats/` first — same
 *   non-clobbering copy as {@link ensureProjectChats} — and is then removed.
 * - A **symlink** is removed only when it already resolves to that same
 *   `.chats/` store, i.e. Paddock created it. A link pointing anywhere else
 *   belongs to someone else and is left strictly alone.
 * - Anything else (absent, a plain file) is left untouched.
 *
 * Idempotent and never throws — a failure here must not block boot.
 */
export async function retireChatsLink(
  workingDir: string,
  chatsHostDir: string = workingDir,
): Promise<void> {
  try {
    const chatsDir = projectChatsDir(chatsHostDir);
    const encoded = path.join(claudeHome(), "projects", encodeProjectDir(workingDir));
    const st = await fs.lstat(encoded).catch(() => null);
    if (!st) return;

    if (st.isSymbolicLink()) {
      const target = await fs.readlink(encoded).catch(() => "");
      const resolved = path.resolve(path.dirname(encoded), target);
      // Only ever remove OUR OWN pointer at the store we know about.
      if (resolved === path.resolve(chatsDir)) await fs.rm(encoded, { force: true });
      return;
    }

    if (st.isDirectory()) {
      await fs.mkdir(chatsDir, { recursive: true });
      await foldTranscriptsInto(encoded, chatsDir);
      await fs.rmdir(encoded).catch(() => undefined);
    }
  } catch {
    /* non-fatal: a stale pointer is harmless, a lost transcript would not be */
  }
}

/**
 * Point the ROOT ("scratch") agent's transcripts at its cwd, and retire the
 * pointer the pre-#512 cwd left behind. Idempotent; never throws.
 *
 * Issue #512 moved the root agent's working directory from `<dataDir>/scratch`
 * to `projectsRoot` — the instance's backing repo checkout — so the repo's own
 * top-level `CLAUDE.md` resolves by Claude Code's cwd walk-up. Claude names a
 * transcript bucket after the cwd, so that move renames the bucket.
 *
 * The transcript STORE deliberately does NOT move with it: it stays at
 * `<scratchDir>/.chats/`, exactly as a repo-backed project keeps its `.chats/`
 * out of its checkout (issue #187). Two consequences, both wanted: root
 * transcripts never enter the backing repo's working tree, and **no chat file is
 * ever relocated on upgrade** — only the pointer changes.
 *
 * So this:
 *  1. points `~/.claude/projects/<encoded workingDir>` at `<storeDir>/.chats/`,
 *     creating the store and folding in (never clobbering) any real transcript
 *     dir that happens to already sit at the new encoded path;
 *  2. retires the legacy `~/.claude/projects/<encoded storeDir>` pointer, first
 *     folding in its contents if a pre-relocation instance left a real dir there.
 *
 * When the store IS the cwd (an instance that sets `PADDOCK_SCRATCH_DIR` to
 * `projectsRoot`) step 2 is skipped — that pointer is the live one.
 */
export async function ensureScratchChats(workingDir: string, storeDir: string): Promise<void> {
  await ensureProjectChats(workingDir, storeDir);
  if (path.resolve(workingDir) === path.resolve(storeDir)) return;
  await retireChatsLink(storeDir, storeDir);
}

/**
 * Rewrite the `cwd` token embedded in a transcript JSONL, so a relocated chat
 * resumes in its new working directory (used by promotion, scratch → project).
 *
 * Claude Code writes compact JSON (`"cwd":"/abs/path"` — no spaces, no escaping
 * for a plain absolute path), the same assumption `scripts/migrate-chat.sh`
 * relies on. The matched token INCLUDES the closing quote, so a `from` of
 * `/data/projects` can never match a line whose cwd is `/data/projects/slug`.
 *
 * `fromDirs` is a list because a chat may have been written under an EARLIER
 * cwd than the one its agent uses today — the root agent's cwd moved from the
 * scratch dir to `projectsRoot` in issue #512, and chats predating that move
 * must promote just as cleanly. Passing the same dir twice is harmless (the
 * second pass finds nothing).
 */
export function rewriteTranscriptCwd(raw: string, fromDirs: string[], toDir: string): string {
  return fromDirs.reduce(
    (text, from) => text.split(`"cwd":"${from}"`).join(`"cwd":"${toDir}"`),
    raw,
  );
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
