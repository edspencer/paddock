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
 */
import { promises as fs } from "node:fs";
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
 * Text bodies of injected/synthetic ("meta") user lines in a session transcript.
 *
 * Claude Code writes injected context — a skill's `SKILL.md`, slash-command
 * output, etc. — as its own `type:"user"` JSONL line flagged `isMeta:true`.
 * @herdctl/core's parser ignores that flag and emits the body as an ordinary
 * user message, so e.g. a skill's `SKILL.md` renders as a giant user bubble
 * (issue #31). We re-read the raw transcript to recover which user texts were
 * injected, keyed by their exact text so a caller can drop the matching parsed
 * messages. Text is extracted the same way the parser does (string content
 * verbatim, or `text` blocks joined with "\n") so the keys match exactly.
 *
 * Never throws: a missing/unreadable transcript yields an empty set (strip
 * nothing), so history hydration degrades gracefully.
 */
export async function metaUserTexts(
  projectDir: string,
  sessionId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const file = path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isMetaUserLine(parsed)) continue;
    const text = extractLineText((parsed as { message?: { content?: unknown } }).message?.content);
    if (text.length > 0) out.add(text);
  }
  return out;
}

function isMetaUserLine(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "user" &&
    (parsed as { isMeta?: unknown }).isMeta === true
  );
}

/** Mirror of @herdctl/core's `extractTextContent`, so keys match its output. */
function extractLineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Ensure `<projectDir>/.chats/` exists and that Claude Code's encoded transcript
 * path is a symlink pointing at it (migrating an existing real transcript dir in
 * the process). Safe to call on every agent registration. Never throws — a
 * failure here must not block agent registration or chat.
 */
export async function ensureProjectChats(projectDir: string): Promise<void> {
  try {
    const chatsDir = projectChatsDir(projectDir);
    await fs.mkdir(chatsDir, { recursive: true });

    const encoded = path.join(claudeHome(), "projects", encodeProjectDir(projectDir));
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
      for (const entry of await fs.readdir(encoded)) {
        const from = path.join(encoded, entry);
        const to = path.join(chatsDir, entry);
        if (await fs.lstat(to).then(() => true).catch(() => false)) continue; // don't clobber
        // cp+rm is robust across filesystems (rename would EXDEV across mounts).
        await fs.cp(from, to, { recursive: true });
        await fs.rm(from, { recursive: true, force: true });
      }
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
