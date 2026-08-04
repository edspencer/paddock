/**
 * Paddock's OWN Claude home (#620).
 *
 * Paddock already acts as the outer container for everything it owns: the
 * projects tree, herdctl's entire state dir, the generated `herdctl.yaml`. Claude
 * Code's transcripts were the one exception — they lived in the user's
 * `~/.claude` and were reached by planting symlinks into it from outside. That
 * was never a design choice. Claude Code resolves its home from
 * `CLAUDE_CONFIG_DIR`, and until herdctl#423 nothing set it, so whatever home
 * paddock configured the SDK still wrote to `~/.claude`. The symlink was the only
 * lever there was.
 *
 * With `CLAUDE_CONFIG_DIR` now threaded (herdctl#423, `@herdctl/core@5.29.0`),
 * paddock points Claude Code at `<dataDir>/claude-home` and `~/.claude` becomes a
 * READ-ONLY source. This module owns everything that follows from that:
 *
 *  - **{@link ensureClaudeHome}** — create the home, bridge the user-level config
 *    that lives in `~/.claude`, and report anything an operator needs to know.
 *  - **{@link mirrorLegacyTranscriptFolders}** — keep adoption (#588) able to see
 *    the user's own CLI history, which by definition is in `~/.claude`.
 *
 * ## The invariant
 *
 * **Paddock never moves, deletes or overwrites anything under `~/.claude`.**
 *
 * Stated precisely, because the bridge below does create symlinks POINTING at
 * files in there, and Claude Code writing through one of those (refreshing an
 * OAuth token, installing a plugin) does land in the user's home. That is Claude
 * Code maintaining its own store in the place it has always kept it, which is
 * what a user wants; it is not paddock relocating their data behind their back.
 * The thing #620 exists to stop — `ensureProjectChats` copying a user's
 * transcripts out and then `fs.rm`-ing the originals, unprompted, inside a bare
 * `catch {}` — is gone, gated on `PaddockConfig.ownsClaudeHome`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";
import type { PaddockConfig } from "./config.js";

/**
 * Entries of a Claude home that are USER-LEVEL configuration rather than
 * per-instance state, symlinked from the user's home into paddock's own when
 * paddock's does not already have its own.
 *
 * Without this, relocating the home silently changes agent behaviour: the user's
 * `~/.claude/CLAUDE.md` is auto-loaded into every session, `settings.json`
 * carries permissions and hooks, and `agents/` `commands/` `plugins/` are
 * capability. Dropping them is not "a clean home", it is a behaviour regression
 * nobody asked for.
 *
 * `.credentials.json` is the one that matters most: on Linux (and in the Docker
 * image) it is where `claude login` puts the OAuth token, so without the bridge
 * every file-authenticated install would come back logged out. Symlinked rather
 * than copied — a copy would duplicate a live secret onto disk AND diverge the
 * moment Claude Code refreshed the token.
 *
 * Deliberately NOT bridged: `projects/` (that's the whole point), and everything
 * that is per-instance runtime state — `todos/`, `shell-snapshots/`, `statsig/`,
 * `sessions/`. Those are exactly what should now be per-instance.
 */
export const BRIDGED_ENTRIES = [
  ".credentials.json",
  "settings.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "plugins",
] as const;

/** Env vars that authenticate Claude Code without any on-disk credential. */
const TOKEN_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** A message for the operator, at the level it should be logged at. */
export interface ClaudeHomeNotice {
  level: "info" | "warn";
  message: string;
}

export interface ClaudeHomeReport {
  /** Entries symlinked in from the user's home this boot. */
  bridged: string[];
  /** Messages for `app.ts` to log — config resolution has no logger of its own. */
  notices: ClaudeHomeNotice[];
}

/** Does `p` exist (following symlinks)? */
async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Create paddock's Claude home and bridge the user-level config into it.
 *
 * Idempotent and non-clobbering: an entry paddock's home already has (whether a
 * real file the user put there or a symlink from a previous boot) is left
 * completely alone, so this is safe to run on every start.
 *
 * Never throws. A home that cannot be created is not a reason to refuse to boot
 * — Claude Code falls back to its own default and chat still works, which is the
 * same failure mode `ensureProjectChats` has always had.
 */
export async function ensureClaudeHome(
  cfg: Pick<PaddockConfig, "claudeHome" | "legacyClaudeHome" | "ownsClaudeHome">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeHomeReport> {
  const report: ClaudeHomeReport = { bridged: [], notices: [] };
  try {
    await fs.mkdir(path.join(cfg.claudeHome, "projects"), { recursive: true });
  } catch (err) {
    report.notices.push({
      level: "warn",
      message:
        `could not create the Claude home at ${cfg.claudeHome} (${String(err)}) — ` +
        `Claude Code will fall back to its own default and transcripts will not be ` +
        `relocated into each project's .chats/`,
    });
    return report;
  }

  // Running in the user's own home is the pre-#620 layout: nothing to bridge
  // (the files are already there) and nothing to warn about.
  if (!cfg.ownsClaudeHome) {
    report.notices.push({
      level: "info",
      message: `Claude home: ${cfg.claudeHome} (the user's own — paddock is not managing it)`,
    });
    return report;
  }

  for (const entry of BRIDGED_ENTRIES) {
    const target = path.join(cfg.legacyClaudeHome, entry);
    const link = path.join(cfg.claudeHome, entry);
    // lstat, not stat: a bridge symlink planted on a previous boot whose target
    // has since been removed still occupies the name, and re-linking it would be
    // a no-op churn at best.
    const occupied = await fs
      .lstat(link)
      .then(() => true)
      .catch(() => false);
    if (occupied) continue;
    if (!(await exists(target))) continue;
    try {
      await fs.symlink(target, link);
      report.bridged.push(entry);
    } catch {
      /* a race with another instance, or a read-only home — not fatal */
    }
  }

  report.notices.push({
    level: "info",
    message:
      `Claude home: ${cfg.claudeHome} (paddock-owned; ~/.claude is read-only)` +
      (report.bridged.length > 0 ? ` — bridged from ~/.claude: ${report.bridged.join(", ")}` : ""),
  });

  // The credential question (#620). Claude Code derives its secure-storage
  // service name from whether `CLAUDE_CONFIG_DIR` is SET AT ALL — unset gets the
  // plain name, set gets a path-hash suffix. Pointing paddock at its own home
  // means it is always set, so a login held in the macOS Keychain under the plain
  // name will not be found. A token in the environment is unaffected, and a
  // file-based login is bridged above; if neither applies we cannot see the
  // credential at all, so say so BEFORE the first turn fails with "Not logged in"
  // rather than leaving the operator to work it out from a chat that never
  // replies.
  const hasTokenEnv = TOKEN_ENV_VARS.some((v) => (env[v] ?? "").trim().length > 0);
  const hasCredentialFile = await exists(path.join(cfg.claudeHome, ".credentials.json"));
  if (!hasTokenEnv && !hasCredentialFile) {
    report.notices.push({
      level: "warn",
      message:
        `no Claude credentials found for ${cfg.claudeHome}: no .credentials.json and no ` +
        `${TOKEN_ENV_VARS.join("/")} in the environment. Claude Code scopes its credential ` +
        `store to CLAUDE_CONFIG_DIR, so a login stored in the OS keychain against the ` +
        `default home will NOT be found here. If turns fail with "Not logged in", either ` +
        `re-run \`claude login\` with CLAUDE_CONFIG_DIR=${cfg.claudeHome}, or set ` +
        `CLAUDE_HOME=${cfg.legacyClaudeHome} to keep using the previous layout.`,
    });
  }

  return report;
}

/** One of the user's transcript folders, made readable through paddock's home. */
export interface LegacyMirror {
  /** Folder name inside `<claudeHome>/projects/` — `encodePathForCli(engineCwd)`. */
  name: string;
  /**
   * The working directory the ENGINE must be handed to read this folder.
   *
   * Not the real cwd the transcripts were recorded in — see
   * {@link mirrorLegacyTranscriptFolders} for why it cannot be.
   */
  engineCwd: string;
  /** The user's real folder in `<legacyHome>/projects/`, which we only read. */
  legacyDir: string;
}

/**
 * The synthetic working directory a legacy transcript folder is offered to the
 * engine under: the folder's own path inside the user's home.
 *
 * Any stable, per-folder, collision-free path would do. This one is the obvious
 * choice because it already exists, is unique by construction, and is honest
 * about where the transcripts actually are.
 */
export function legacySourcePath(legacyHome: string, folderName: string): string {
  return path.join(legacyHome, "projects", folderName);
}

/**
 * Make the user's own transcript folders visible through paddock's Claude home,
 * so adoption (#588) still finds them.
 *
 * Adoption's whole premise is "you already have terminal `claude` history for
 * this directory" — and that history is, by definition, in `~/.claude`. But the
 * engine resolves every adoption path against the ONE home the FleetManager was
 * built with, with no per-call override, so once paddock owns its home the
 * user's folders are out of reach. Without this, #620 would silently gut #588.
 *
 * The fix is a read-only view: symlink each of the user's folders into
 * `<claudeHome>/projects/`. The engine then reads their transcripts through it,
 * and adoption's default `copy` mode writes the copy into the project's own
 * folder (itself the symlink to `.chats/`) — originals read, never touched.
 *
 * ## Why the mirror is not named after the recorded cwd
 *
 * The obvious mirror name — the same encoded name the user's folder has — is
 * wrong, and wrong in exactly the case adoption exists for. A folder's name is
 * `encodePathForCli(cwd)`, so the user's history for `/code/thing` and a paddock
 * project whose working directory IS `/code/thing` want the SAME name in the
 * same directory. Paddock's `.chats/` symlink is already there and must stay, so
 * the user's folder loses — and "I pointed a project at a directory I already
 * have `claude` history for", the headline case, silently offers nothing.
 *
 * (Pre-#620 this case worked only because `ensureProjectChats` had already MOVED
 * those transcripts into `.chats/` and deleted the originals. That destruction is
 * the thing #620 removes, so the case now needs a real mechanism.)
 *
 * So each mirror is named for a SYNTHETIC working directory
 * ({@link legacySourcePath}) that no agent will ever have, which makes
 * collisions structurally impossible rather than merely unlikely. The caller
 * keeps the folder's real recorded cwd for display and hands `engineCwd` to the
 * engine — see `AdoptableSource.importFrom`.
 *
 * Entries in the legacy home that are themselves SYMLINKS are skipped: those are
 * ones paddock planted under the old layout, pointing back at some `.chats/`, and
 * mirroring them would re-offer paddock's own chats as "adoptable". That also
 * makes the leftovers from before this change inert rather than confusing.
 *
 * Idempotent and never throws. Returns every mirror it maintains, not only the
 * ones planted this call, so a caller can rely on the mapping after any call.
 */
export async function mirrorLegacyTranscriptFolders(
  claudeHome: string,
  legacyHome: string,
): Promise<LegacyMirror[]> {
  if (path.resolve(claudeHome) === path.resolve(legacyHome)) return [];
  const from = path.join(legacyHome, "projects");
  const to = path.join(claudeHome, "projects");
  const mirrors: LegacyMirror[] = [];
  try {
    const names = await fs.readdir(from).catch(() => [] as string[]);
    if (names.length === 0) return [];
    await fs.mkdir(to, { recursive: true });
    for (const folderName of names) {
      const legacyDir = path.join(from, folderName);
      const st = await fs.lstat(legacyDir).catch(() => null);
      if (!st?.isDirectory()) continue; // skips files AND paddock's old symlinks
      const engineCwd = legacySourcePath(legacyHome, folderName);
      // encodePathForCli, not a local encoder: this name must be byte-identical
      // to what the engine derives from `engineCwd`, including the truncate+hash
      // branch it takes past 200 chars.
      const name = encodePathForCli(engineCwd);
      const link = path.join(to, name);
      const occupied = await fs
        .lstat(link)
        .then(() => true)
        .catch(() => false);
      if (!occupied) {
        const ok = await fs.symlink(legacyDir, link).then(
          () => true,
          () => false,
        );
        if (!ok) continue;
      }
      mirrors.push({ name, engineCwd, legacyDir });
    }
  } catch {
    /* non-fatal: adoption just sees fewer sources */
  }
  return mirrors;
}

/**
 * Count the transcript symlinks a paddock instance planted in the user's home
 * under the pre-#620 layout that point back into THIS data dir.
 *
 * Purely informational. They are harmless — they still resolve, and nothing
 * reads them any more — but they accumulate one per project per instance and go
 * stale as soon as a data dir is deleted, so an operator is better off being
 * told they exist than discovering a pile of dangling links months later.
 * Paddock does not remove them itself: they live in `~/.claude`, and not writing
 * there is the entire point.
 */
export async function countLegacyTranscriptLinks(
  legacyHome: string,
  dataDir: string,
): Promise<number> {
  const root = path.join(legacyHome, "projects");
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const prefix = path.resolve(dataDir) + path.sep;
  let count = 0;
  for (const name of names) {
    const target = await fs.readlink(path.join(root, name)).catch(() => null);
    if (target !== null && path.resolve(target).startsWith(prefix)) count++;
  }
  return count;
}
