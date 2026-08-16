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
 * A `.chats` symlink left behind by a `transcripts: host` period, removed by a
 * boot that is now running `own`. See {@link unplantChatsDir}.
 */
export interface UnplantedChatsLink {
  /** The `.chats` path that was a symlink and is now a real, empty directory. */
  chatsDir: string;
  /**
   * What it pointed at, resolved — normally `~/.claude/projects/<encoded-cwd>`.
   * Reported, never touched: the transcripts written during the `host` period
   * are still sitting there, exactly as they were.
   */
  target: string;
}

/**
 * The `own`-mode inverse of {@link pointChatsDirAt}: unplant a stale `.chats`
 * symlink and put a real, empty directory back in its place (#708).
 *
 * ## Why this has to exist
 *
 * `pointChatsDirAt` is only ever called under `host`, so before #708 nothing
 * un-planted the link. Flip an instance back to `own` and you keep a two-hop
 * chain into the user's real Claude home:
 *
 *     <projectDir>/.chats                  SYMLINK -> ~/.claude/projects/<enc>
 *     <claudeHome>/projects/<enc>          SYMLINK -> <projectDir>/.chats
 *
 * `mkdir(store, {recursive:true})` on a symlink-to-an-existing-dir is a silent
 * no-op, which is why three consecutive `own` boots did not heal it. The
 * consequences were verified in a sandbox, not inferred: new chats written under
 * `own` landed in the user's real folder (so `own` stopped isolating at all), and
 * `deleteSession`'s `own` branch — an `rm` of `<claudeHome>/projects/<enc>/<id>.jsonl`
 * — resolved through both hops and unlinked the user's actual terminal history.
 * That is #682's destruction class re-entered through a config flip.
 *
 * ## Why it only unplants, and does not migrate
 *
 * The obvious richer behaviour is to COPY the host folder's transcripts into the
 * new real `.chats` so they stay visible in paddock. Rejected, for three reasons
 * that compound:
 *
 *  1. **It cannot be done without breaking the promise `own` exists to make.**
 *     Copying means reading `~/.claude`. The module doc above and
 *     `website/…/what-paddock-touches.md` both state that under `own` nothing
 *     there is read or written — and the issue this fixes cites the falsification
 *     of exactly that line as the bug. A fix whose first act is to falsify it
 *     again is not a fix. So this function never touches `target`: it `readlink`s
 *     the name for the operator notice and stops. (Deliberately no file count in
 *     {@link UnplantedChatsLink} for the same reason — a `readdir` is a read.)
 *     The migration preview (#882) is the one read those two documents now
 *     admit, and it does not weaken this: it happens because a user asked for
 *     it, on a request, not silently at boot. That distinction — asked-for
 *     versus automatic — is the whole of what makes one acceptable and this
 *     one not.
 *  2. **The host folder is not paddock's to sweep up.** It holds whatever the
 *     user ran `claude` on in that directory, including chats they only ever had
 *     in a terminal and never in paddock. Copy-everything drags private terminal
 *     history into a paddock project; copy-some needs a heuristic to tell
 *     paddock's chats from the user's, and `deleteSession` already declines to
 *     make that same distinction ("distinguishing them well enough to risk an
 *     `rm` is not worth the failure mode of getting it wrong").
 *  3. **Paddock already has this feature, and it is user-driven.** Adoption /
 *     `import-chats` copies selected transcripts out of a Claude home into a
 *     project (`mode: "copy"`), with the user choosing which. Doing it silently
 *     at boot converts a deliberate gesture into an automatic one, and creates
 *     the same session id in two stores that then diverge the moment the user
 *     resumes one in a terminal.
 *
 * So the split this leaves — host-era chats still on disk but no longer in
 * paddock's list — is real, and is reported by name at boot rather than papered
 * over. It is NOT fully closable by import today, and the boot notice says so:
 * `listAdoptableSessions` excludes any session a run record is attributed to,
 * which is every chat paddock itself drove during the `host` period, so import
 * offers the user's own terminal sessions and not paddock's. Measured on a
 * flipped instance, not assumed. Closing that remainder means rewriting run
 * records as well as moving files — i.e. a migration, which is #882.
 *
 * Refusing to boot instead was also rejected: it leaves the dangerous symlink in
 * place, so the isolation breach and the destructive delete both survive the
 * refusal — it fixes nothing it warns about. And this whole module is built
 * never to fail a boot over transcript layout.
 *
 * Only symlinks are touched. A `.chats` that is already a real directory is the
 * correct `own` shape and is left alone.
 */
async function unplantChatsDir(chatsDir: string): Promise<UnplantedChatsLink | null> {
  const st = await fs.lstat(chatsDir).catch(() => null);
  if (!st?.isSymbolicLink()) return null;
  const raw = await fs.readlink(chatsDir).catch(() => "");
  const target = path.resolve(path.dirname(chatsDir), raw);
  // `rm` on a symlink removes the LINK, never what it points at — the whole
  // reason this is safe to do unconditionally.
  await fs.rm(chatsDir, { force: true });
  await fs.mkdir(chatsDir, { recursive: true });
  return { chatsDir, target };
}

/**
 * Is this project's `.chats` still a planted symlink? The corrupted-state
 * predicate {@link unplantChatsDir} exists to clear (#708).
 *
 * Split out because `deleteSession` needs it as a last-resort guard: the healing
 * above is best-effort by design (`ensureProjectChats` swallows its own errors so
 * a layout problem can never block chat), and the one operation that must not run
 * against an unhealed layout is the `rm`. `lstat` only — this never follows the
 * link, so it cannot touch `~/.claude` even when that is where the link goes.
 */
export async function chatsDirIsPlanted(chatsHostDir: string): Promise<boolean> {
  const st = await fs.lstat(projectChatsDir(chatsHostDir)).catch(() => null);
  return st?.isSymbolicLink() === true;
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
 * nothing under `~/.claude` is created or written at all. Since #708 that holds
 * even when the instance USED to run `host`: see {@link unplantChatsDir}.
 *
 * The `own → host` migration (#882) is the one exception under `own`, in both
 * directions, and it happens only on an explicit `POST`:
 *
 *  - `transcripts-migration.ts` READS the store, because a net-new chat and one
 *    that has diverged from a CLI original are indistinguishable without
 *    comparing the two;
 *  - `transcripts-migration-execute.ts` WRITES it, moving the transcripts in —
 *    which is the operation the user asked for. It never deletes anything and
 *    never overwrites a file in place: where paddock's copy supersedes the
 *    user's, the user's is moved to `<projectDir>/.chats-pre-migration/` first.
 *
 * Both are behind their own endpoint precisely so they are something the user
 * asks for, rather than something a background poll does silently.
 *
 * Returns the stale `.chats` symlink it had to unplant, so the caller can tell
 * the operator where their host-era transcripts still are, or `null` — the
 * overwhelmingly common case — when the layout already agreed with the mode.
 */
export async function ensureProjectChats(
  workingDir: string,
  chatsHostDir: string,
  home: ClaudeHomeTarget,
): Promise<UnplantedChatsLink | null> {
  try {
    const chatsDir = projectChatsDir(chatsHostDir);
    const store =
      home.transcripts === "host"
        ? encodedTranscriptDir(home.userHome, workingDir)
        : chatsDir;
    // BEFORE the mkdir, which is the ordering the bug turned on: under `own` the
    // store IS `.chats`, and `mkdir(recursive)` over a symlink-to-a-real-dir
    // succeeds without doing anything — which is why the stale link survived
    // every subsequent boot rather than being healed by one.
    const unplanted =
      home.transcripts === "own" ? await unplantChatsDir(chatsDir) : null;
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
      return unplanted;
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
        // the cache key for auto-name / preview / sidechain detection — so
        // without it, relocating a months-old archive re-derives every one of
        // those. It is no longer the chat-list sort key (#863, that now comes
        // from the last message INSIDE the transcript), which narrows the blast
        // radius of getting this wrong but does not remove it.
        await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
        await fs.rm(from, { recursive: true, force: true });
      }
      await fs.rmdir(encoded).catch(() => undefined);
      await fs.symlink(store, encoded);
      return unplanted;
    }

    // Nothing there yet — just create the symlink so future turns land in the store.
    await fs.symlink(store, encoded);
    return unplanted;
  } catch {
    /* non-fatal: fall back to Claude Code's default location for this project */
    return null;
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
