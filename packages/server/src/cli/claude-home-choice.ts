/**
 * Which Claude home the INTERACTIVE CLI runs against (#683).
 *
 * ## The problem this exists for
 *
 * Since #620 paddock owns `<dataDir>/claude-home`, and herdctl therefore hands
 * Claude Code a `CLAUDE_CONFIG_DIR`. Claude Code derives its **secure-storage
 * service name** from whether that variable is SET AT ALL — unset gets the plain
 * name, set gets a path-hash suffix — so a macOS login held in the Keychain under
 * the plain name becomes invisible the moment paddock points at its own home.
 *
 * #620 anticipated this and bridges credentials by symlinking
 * `~/.claude/.credentials.json` in. That is the FILE-based store: it covers Linux
 * and the Docker image and is structurally incapable of covering macOS, because a
 * Keychain entry cannot be symlinked. Net effect on a Mac: `npx paddock --here`
 * boots, the UI loads, and every turn fails with `Not logged in`, two directories
 * away from a perfectly good login.
 *
 * ## Why the fix is a home choice and not a credential copy
 *
 * There is exactly one lever. herdctl injects `CLAUDE_CONFIG_DIR` only when the
 * configured home differs from `~/.claude` — it documents that same service-name
 * branch as its reason for staying quiet otherwise. So the only way to get the
 * plain service name, and with it the user's Keychain login, is to run against
 * `~/.claude` itself.
 *
 * The alternative — reading the Keychain secret and writing it to disk as
 * `.credentials.json` — is deliberately NOT done anywhere in this codebase. It
 * downgrades OS-protected storage to a plaintext file, and it would diverge the
 * moment Claude Code refreshed the token.
 *
 * ## Why the interactive CLI, and only the interactive CLI
 *
 * `--here` means *my* directory, *my* sessions, *my* login; isolation is a server
 * concern. A daemon, the container image and `node dist/index.js` all keep the
 * owned home — nothing here runs for them, and `resolveClaudeHome`'s precedence
 * is untouched. This module only decides what the CLI puts in `CLAUDE_HOME`
 * before it hands over, which is the same mechanism a user has always had.
 *
 * ## What continuity costs
 *
 * Running against the user's home means paddock plants no transcript symlink
 * there (#682, and the reason this was blocked on it), so transcripts stay in
 * `~/.claude/projects/<encoded-cwd>/` rather than being relocated into the
 * workspace's `.chats/`. Chats still list, open, resume and rename — paddock and
 * the engine read the one home — but the workspace directory is not
 * self-contained, and existing sessions for that directory are simply THERE
 * rather than being offered for import. The CLI says so out loud when it makes
 * this choice; see `paddock.ts`.
 */
import path from "node:path";

/** Env vars that authenticate Claude Code without any on-disk credential. */
const TOKEN_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** Variables that are an explicit choice of home, and are never overridden. */
const HOME_ENV_VARS = ["CLAUDE_HOME", "CLAUDE_CONFIG_DIR"];

export interface ClaudeHomeChoiceInput {
  /** The process environment to read. */
  env: NodeJS.ProcessEnv;
  /** The user's own Claude home — `os.homedir()/.claude`. */
  userClaudeHome: string;
  /** Does that directory exist? Nothing to be continuous with if it does not. */
  userHomeExists: boolean;
  /** Did the user ask for isolation explicitly (`--isolated-claude-home`)? */
  forceIsolated: boolean;
}

export interface ClaudeHomeChoice {
  /**
   * The value to put in `CLAUDE_HOME`, or `undefined` to leave the default
   * (`<dataDir>/claude-home`) alone.
   */
  claudeHome?: string;
  /** Short, user-facing reason — printed when continuity is chosen. */
  reason: string;
}

/**
 * Decide whether the interactive CLI should run against the user's own Claude
 * home for credential continuity.
 *
 * Pure, so the whole decision table is testable on a platform that has no
 * Keychain. Continuity is chosen only when all four hold:
 *
 *  1. **No explicit home in the environment.** `CLAUDE_HOME` or
 *     `CLAUDE_CONFIG_DIR` is somebody deciding this already; deferring to them is
 *     the same rule herdctl#423 follows.
 *  2. **No token in the environment.** A token authenticates regardless of home,
 *     so the isolated home works and is strictly better — this is the shape every
 *     CI, container and server run has.
 *  3. **`--isolated-claude-home` not passed.** The explicit opt-out.
 *  4. **`~/.claude` actually exists.** With no user home there is no login to be
 *     continuous with, and the owned home self-initializes cleanly.
 *
 * Note what is NOT a condition: the platform. The isolation/continuity trade is
 * the same argument on Linux, where it additionally makes the `.credentials.json`
 * bridge unnecessary rather than merely insufficient. Branching on `darwin` would
 * mean two behaviours to reason about and one of them untested on most machines.
 */
export function chooseClaudeHome(input: ClaudeHomeChoiceInput): ClaudeHomeChoice {
  const setHomeVar = HOME_ENV_VARS.find((v) => (input.env[v] ?? "").trim().length > 0);
  if (setHomeVar !== undefined) {
    return { reason: `${setHomeVar} is set — honouring it` };
  }
  if (input.forceIsolated) {
    return { reason: "--isolated-claude-home was passed" };
  }
  const tokenVar = TOKEN_ENV_VARS.find((v) => (input.env[v] ?? "").trim().length > 0);
  if (tokenVar !== undefined) {
    return { reason: `${tokenVar} is set — the isolated home can authenticate on its own` };
  }
  if (!input.userHomeExists) {
    return { reason: `no ${input.userClaudeHome} — nothing to inherit` };
  }
  return {
    claudeHome: input.userClaudeHome,
    reason: `using your existing Claude Code login and history in ${input.userClaudeHome}`,
  };
}

/** `~/.claude`, given a home directory. Kept here so callers do not re-spell it. */
export function userClaudeHomePath(homedir: string): string {
  return path.join(homedir, ".claude");
}
