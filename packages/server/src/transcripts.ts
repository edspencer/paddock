/**
 * Transcript relocation (backing-store Phase 3), and the `transcripts` lever (#691).
 *
 * Claude Code writes a session transcript to `<claudeHome>/projects/<encoded-cwd>/`,
 * where `<claudeHome>` is `CLAUDE_CONFIG_DIR` — always paddock's own
 * `<dataDir>/claude-home` since #691 — and `<encoded-cwd>` is the agent's absolute
 * working directory with every non-[A-Za-z0-9] char replaced by '-'. That makes
 * transcripts path-coupled and not portable, so paddock makes that encoded path a
 * **symlink** and Claude Code writes through it (validated empirically); herdctl's
 * discovery, resume, delete and rename all resolve through it transparently.
 *
 * What the symlink POINTS AT is the one thing {@link TranscriptsMode} chooses:
 *
 *  - **`own`** (default) — `<projectDir>/.chats/`. Transcripts are paddock's own
 *    copy, the project dir is self-contained and travels with the repo / NAS.
 *  - **`host`** — `~/.claude/projects/<encoded-cwd>/`, the user's REAL Claude Code
 *    folder for that same directory. One set of files, both directions: an append
 *    made by `claude --resume` in a terminal shows up in paddock with no restart
 *    and no re-import, and vice versa.
 *
 * ## Why `host` is an outward symlink and not a repointed config dir
 *
 * The obvious implementation of "share the user's transcripts" is to point
 * `CLAUDE_CONFIG_DIR` at `~/.claude`, which is what 0.61.1 did. It drags memory,
 * `.claude.json` and the credential-store service name along as collateral — and
 * it breaks agent memory (#690), because the agent harness refuses to write to any
 * path containing a `.claude` component and the memory dir is
 * `<claudeHome>/projects/<enc>/memory`. Keeping paddock's own home and pointing one
 * symlink outward fixes that by construction: the LITERAL path handed to the agent
 * is always under `<dataDir>/claude-home/…`, which has no `.claude` component,
 * while the files it resolves to are the user's. Pinned by
 * `test/unit/transcripts.test.ts` in BOTH modes — do not "simplify" this back.
 *
 * `ensureProjectChats` is idempotent and self-healing: on first run for a project
 * whose encoded path is still a real directory (existing transcripts), it migrates
 * those files into the store and replaces the directory with the symlink.
 */
import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

/**
 * Whose transcripts this instance uses — the `claude.transcripts` config key.
 *
 * `own` = paddock's, inside the data dir / project. `host` = this machine's
 * Claude Code, shared live. See the module doc for the mechanism.
 */
export type TranscriptsMode = "own" | "host";

/** Isolation is the default: nothing outside the data dir is written (#691). */
export const DEFAULT_TRANSCRIPTS_MODE: TranscriptsMode = "own";

/** Type guard, so an unknown config value falls back instead of failing a boot. */
export function isKnownTranscriptsMode(value: string): value is TranscriptsMode {
  return value === "own" || value === "host";
}

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
 * The transcript folder a Claude home holds for `workingDir` —
 * `<home>/projects/<encoded-cwd>`.
 *
 * The LITERAL path, before any symlink is followed, which is what makes it worth
 * naming: it is the string Claude Code builds its session file AND its agent
 * memory dir (`<here>/memory`) out of, and the agent harness refuses to write to
 * any path with a `.claude` component in it (#690). Under paddock's own home it
 * never has one, in either {@link TranscriptsMode}.
 */
export function encodedTranscriptDir(claudeHome: string, workingDir: string): string {
  return path.join(claudeHome, "projects", encodeProjectDir(workingDir));
}

/**
 * Where a project's transcripts are planted, and where they point.
 *
 * `path` is the Claude home to plant the redirect symlink in, and it is REQUIRED
 * — no default (#620). Callers must pass `cfg.claudeHome`: the engine is
 * constructed with that same resolved value, and a symlink planted in a
 * different home than the one the engine reads is exactly the "chats list but
 * open empty" failure (#588). It used to default to the env-derived home for
 * callers with no config, and `ensureSweeperHome` silently took that default —
 * so the sweeper's symlink landed in a different home than every other agent's.
 * Making the parameter required is what stops that class of bug at the type
 * level.
 *
 * Since #691 paddock ALWAYS owns `path`, so the old `owned` flag is gone: the
 * question it used to answer ("may we write here?") now has one answer, and the
 * question that actually varies — whose transcripts these are — is
 * {@link transcripts}.
 */
export interface ClaudeHomeTarget {
  /** Absolute path to paddock's own Claude home (`cfg.claudeHome`). */
  path: string;
  /** Whose transcripts this instance uses (`cfg.claude.transcripts`). */
  transcripts: TranscriptsMode;
  /** The user's own `~/.claude` — the store under `transcripts: "host"`. */
  userHome: string;
}

/**
 * Point `<chatsHostDir>/.chats/` at the user's own transcript folder, so
 * paddock's own by-path readers keep working under `transcripts: "host"`.
 *
 * NOT redundant with the redirect symlink, and not in #691's sketch — it is
 * needed because roughly a dozen server modules (`subagents.ts`, `usage.ts`,
 * `tooldetails.ts`, `localcommand.ts`, `recovery.ts`, `readFirstUserText`,
 * the usage-limit notice scan) resolve a transcript as
 * `<projectDir>/.chats/<sessionId>.jsonl` rather than through the Claude home.
 * Without this the chat itself renders (herdctl reads through the home) while
 * sub-agent panels, token usage, tool details, slash-command names and full
 * previews all silently come back empty — which is what 0.61.1's `--here` does
 * today. Both links point at the SAME real folder; nothing is chained.
 *
 * Non-destructive: a `.chats/` that is a real directory with anything in it is
 * left exactly as it is (a mode switch does not get to delete a store), at the
 * cost of those readers seeing the old copy until the operator moves it.
 */
async function pointChatsDirAt(chatsDir: string, store: string): Promise<void> {
  // The parent may not exist yet — `ensureSweeperHome` calls in with a
  // `<dataDir>/sweepers/<slug>` that nothing has created. Under `own` the
  // recursive mkdir of `.chats/` itself covered that; here the leaf is a symlink,
  // and `fs.symlink` into a missing parent is an ENOENT that the caller's
  // catch-all would swallow — silently leaving the agent with no redirect at all.
  await fs.mkdir(path.dirname(chatsDir), { recursive: true });
  const st = await fs.lstat(chatsDir).catch(() => null);
  if (st?.isSymbolicLink()) {
    const target = await fs.readlink(chatsDir).catch(() => "");
    if (path.resolve(path.dirname(chatsDir), target) === path.resolve(store)) return;
    await fs.rm(chatsDir, { force: true });
  } else if (st?.isDirectory()) {
    if ((await fs.readdir(chatsDir).catch(() => ["?"])).length > 0) return;
    await fs.rmdir(chatsDir);
  } else if (st) {
    return; // a regular file sitting on the name: not ours to remove
  }
  await fs.symlink(store, chatsDir);
}

/**
 * Ensure the project's transcript store exists and that Claude Code's encoded
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
 * The store is `<chatsHostDir>/.chats/` under `transcripts: "own"` and the user's
 * own `~/.claude/projects/<encoded-cwd>/` under `transcripts: "host"`; everything
 * below is the same code either way.
 *
 * ## The one write into `~/.claude`, and why it is not the #682 mistake
 *
 * Under `host` this creates `~/.claude/projects/<encoded-cwd>/` if it is missing,
 * because a symlink to a non-existent directory is not something Claude Code can
 * `mkdir -p` through. That is a directory Claude Code itself would create the
 * first time the user ran `claude` there, made under a config key whose entire
 * meaning is "share the host's transcripts". #682 was the opposite: planting a
 * link that silently REDIRECTED the user's future sessions into paddock's store
 * on an instance that had asked for no such thing. Under `own` — the default —
 * nothing under `~/.claude` is created, read or written at all.
 */
export async function ensureProjectChats(
  workingDir: string,
  chatsHostDir: string,
  home: ClaudeHomeTarget,
): Promise<void> {
  try {
    const chatsDir = projectChatsDir(chatsHostDir);
    const store =
      home.transcripts === "host"
        ? encodedTranscriptDir(home.userHome, workingDir)
        : chatsDir;
    await fs.mkdir(store, { recursive: true });
    if (home.transcripts === "host") await pointChatsDirAt(chatsDir, store);

    const encoded = encodedTranscriptDir(home.path, workingDir);
    await fs.mkdir(path.dirname(encoded), { recursive: true });

    const st = await fs.lstat(encoded).catch(() => null);

    // Already a symlink — point it at the store if it drifted, else done. The
    // drift case is also how a `transcripts` flip takes effect on the next boot.
    if (st?.isSymbolicLink()) {
      const target = await fs.readlink(encoded).catch(() => "");
      const resolved = path.resolve(path.dirname(encoded), target);
      if (resolved !== path.resolve(store)) {
        await fs.rm(encoded, { force: true });
        await fs.symlink(store, encoded);
      }
      return;
    }

    // A real directory of existing transcripts — migrate into the store, then
    // link. This is inside a home paddock owns, so such a directory can only be
    // paddock's own doing: a boot where the symlink could not be planted, or an
    // agent that ran before registration. (Pre-#691 this branch had to be gated
    // on ownership, because the home could BE `~/.claude` and the files somebody
    // else's. It cannot any more — see `resolveClaudeHome`.)
    if (st?.isDirectory()) {
      for (const entry of await fs.readdir(encoded)) {
        const from = path.join(encoded, entry);
        const to = path.join(store, entry);
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
      await fs.symlink(store, encoded);
      return;
    }

    // Nothing there yet — just create the symlink so future turns land in the store.
    await fs.symlink(store, encoded);
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
