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
