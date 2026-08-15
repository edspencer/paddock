/**
 * Named config profiles (#878) — `paranoid` / `balanced` / `yolo`.
 *
 * Paddock has a dozen independent security/capability levers, each with its own
 * code default. A profile is the single place to express *posture* — "locked
 * down" / "full capability" — instead of hand-setting twelve `PADDOCK_*` vars.
 *
 * ## Why this is a resolved key, not something an installer writes
 *
 * Config resolves as code default < YAML file < `PADDOCK_*` env. A profile
 * implemented as "the installer materialises concrete values into
 * `paddock.config.yaml`" only ever touches the FILE layer — so it only works on
 * the one distribution that runs an installer. Docker and bare `node dist` would
 * keep falling through to code defaults and the distributions would stay
 * divergent, which is the actual complaint #878 opens with. Resolving `profile`
 * at every layer — file, env, and a code default underneath both — is what makes
 * every distribution converge on the same posture.
 *
 * ## Where a profile sits in the precedence chain
 *
 * A profile supplies the DEFAULT that each lever's loader falls back to. It does
 * not become a config layer of its own. So the full chain is:
 *
 *     code-default profile  <  resolved profile  <  individual file key  <  individual env var
 *
 * The consequence worth stating out loud, because it inverts this codebase's
 * otherwise universal env-beats-file rule: **an individual key in the YAML file
 * beats `PADDOCK_PROFILE` in the env.** `PADDOCK_PROFILE=paranoid` with
 * `claude: {hooks: host}` in a mounted file resolves hooks to `host`.
 *
 * That is deliberate — specific beats general. `PADDOCK_PROFILE` is a statement
 * about the dozen levers you did NOT mention; a key you wrote by hand is a
 * statement about the one you did. The alternative makes the env var a blunt
 * instrument that silently discards deliberate per-key config, which is a worse
 * failure than the surprise of a file winning. (Env still beats file for the same
 * key, exactly as everywhere else: `PADDOCK_CLAUDE_HOOKS` beats
 * `claude.hooks`.)
 *
 * ## Posture keys only
 *
 * Profiles govern the `claude:` inheritance modes, `maxSpawnDepth`, and the
 * capability toggles — and define ALL of them (see `POSTURE_KEYS`, pinned by a
 * test). They are silent on operational keys (port, data dir, bind host, auth,
 * models, drive mode, curation/recovery/attachments, git author). Switching
 * profile must never change your port or clobber your auth config.
 *
 * ## Two guardrails
 *
 * - Profiles stay orthogonal to bind address and auth. `yolo` must NOT open the
 *   bind or relax auth — network exposure remains its own explicit decision,
 *   already gated by the dangerous-allow-open opt-in. Otherwise "yolo" quietly
 *   becomes "yolo, reachable from the whole network".
 * - `host` resolves against whatever `~/.claude` actually exists: rich on a
 *   workstation, typically empty in a container. **The profile sets the levers,
 *   the environment sets the blast radius** — which is why the permissive
 *   profiles are far more reasonable in a disposable container than on a primary
 *   machine.
 */

import { DEFAULT_MAX_SPAWN_DEPTH } from "./spawn-capability.js";
import type { CredentialsMode } from "./claude-credentials.js";
import type { HooksMode } from "./claude-settings.js";
import type { InstructionsMode } from "./claude-instructions.js";
import type { McpServersMode } from "./claude-mcp.js";
import type { TranscriptsMode } from "./transcripts.js";

/** The three built-in profiles, in ascending order of capability. */
export const PROFILE_NAMES = ["paranoid", "balanced", "yolo"] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

/**
 * The code-default profile (#878).
 *
 * `balanced` rather than `paranoid` because of the **superset principle**:
 * paddock is a presentation layer over the Claude Code CLI, so its capability
 * surface should be a superset of what the plain CLI already gives you. A user
 * whose CLI has MCP servers configured (and plugin-provided MCP servers, which
 * additionally need `instructions: host`) reasonably expects those to work here;
 * defaulting them off is experienced as a capability regression versus the tool
 * paddock wraps.
 */
export const DEFAULT_PROFILE: ProfileName = "balanced";

/**
 * The posture surface: every lever a profile governs, and the only ones it may.
 *
 * Adding a capability lever means adding it here AND giving all three profiles a
 * value for it — `profiles.test.ts` fails until you do. That is the point of the
 * invariant: today a new toggle just gets a code default and the postures are
 * never revisited, so they silently drift out of date.
 */
export interface Posture {
  /** `claude.transcripts` — share the host's transcript store. */
  transcripts: TranscriptsMode;
  /** `claude.credentials` — read the host's Claude login. */
  credentials: CredentialsMode;
  /** `claude.instructions` — inherit the host's CLAUDE.md hierarchy. */
  instructions: InstructionsMode;
  /** `claude.hooks` — inherit the host's hook definitions. */
  hooks: HooksMode;
  /** `claude.mcpServers` — inherit the host's configured MCP servers. */
  mcpServers: McpServersMode;
  /** How deep an agent may spawn sub-agents. */
  maxSpawnDepth: number;
  /** The read-only self-management MCP. */
  selfMcpEnabled: boolean;
  /** The self-management MCP WRITE tools. */
  selfMcpWriteEnabled: boolean;
  /** The self-management MCP PROJECT tools (`create_project`). */
  selfMcpProjectsEnabled: boolean;
  /** Programmatic schedule mutation. */
  scheduleMutationEnabled: boolean;
  /** The hook-management MCP tools. */
  hooksMcpEnabled: boolean;
  /** The Playwright browser MCP. */
  browserMcp: boolean;
}

/**
 * Every posture key, as data — so a test can assert that all three profiles
 * cover exactly this set. Kept in sync with `Posture` by that same test: a key
 * added to the interface but not here fails to typecheck against
 * `Record<keyof Posture, …>` at the `PROFILES` declaration below.
 */
export const POSTURE_KEYS = [
  "transcripts",
  "credentials",
  "instructions",
  "hooks",
  "mcpServers",
  "maxSpawnDepth",
  "selfMcpEnabled",
  "selfMcpWriteEnabled",
  "selfMcpProjectsEnabled",
  "scheduleMutationEnabled",
  "hooksMcpEnabled",
  "browserMcp",
] as const satisfies readonly (keyof Posture)[];

/**
 * The three postures. All three define the same key set, differing only in
 * values — so a diff between two columns is a diff in posture, never in
 * coverage.
 *
 * Two choices here are argued rather than assumed:
 *
 * - **`hooks: own` in `balanced`.** Host hooks are shell commands that fire
 *   AUTOMATICALLY on every matching tool call — inherited arbitrary code
 *   execution. That is a different risk class from MCP servers, which are tools
 *   an agent deliberately chooses to call. So `hooks` does not ride along with
 *   the other `host` modes; it is `host` only under `yolo`.
 * - **`browserMcp: false` in `balanced`.** It needs a browser installed on the
 *   box. Enabling it by default on a host without one leads agents to fall back
 *   to scripting a system browser instead, which is worse than not having it.
 */
export const PROFILES: Record<ProfileName, Posture> = {
  /**
   * Everything isolated, every capability off. This is paddock's historical code
   * default, unchanged — `profiles.test.ts` pins it against the legacy
   * `DEFAULT_*` constants, so selecting it is a no-op for anyone who was relying
   * on those. `credentials` is the one lever that was never `own` by default:
   * reading a login risks no file of the user's, and an instance that boots
   * clean then fails every turn (#683) is the worse failure.
   */
  paranoid: {
    transcripts: "own",
    credentials: "host",
    instructions: "own",
    hooks: "own",
    mcpServers: "own",
    maxSpawnDepth: DEFAULT_MAX_SPAWN_DEPTH,
    selfMcpEnabled: false,
    selfMcpWriteEnabled: false,
    selfMcpProjectsEnabled: false,
    scheduleMutationEnabled: false,
    hooksMcpEnabled: false,
    browserMcp: false,
  },

  /**
   * The default. Inherits what the host CLI already gives the user —
   * `transcripts`, `instructions`, `mcpServers` — and turns on read-only
   * self-MCP, while leaving the genuinely additive/riskier capabilities off:
   * write-side self-MCP, project creation, schedule mutation, hooks MCP, host
   * hooks, deeper spawning.
   */
  balanced: {
    transcripts: "host",
    credentials: "host",
    instructions: "host",
    hooks: "own",
    mcpServers: "host",
    maxSpawnDepth: DEFAULT_MAX_SPAWN_DEPTH,
    selfMcpEnabled: true,
    selfMcpWriteEnabled: false,
    selfMcpProjectsEnabled: false,
    scheduleMutationEnabled: false,
    hooksMcpEnabled: false,
    browserMcp: false,
  },

  /**
   * Full capability. Note what it still does NOT do: it does not touch the bind
   * address or auth (see the guardrail in this file's header).
   */
  yolo: {
    transcripts: "host",
    credentials: "host",
    instructions: "host",
    hooks: "host",
    mcpServers: "host",
    maxSpawnDepth: 2,
    selfMcpEnabled: true,
    selfMcpWriteEnabled: true,
    selfMcpProjectsEnabled: true,
    scheduleMutationEnabled: true,
    hooksMcpEnabled: true,
    browserMcp: true,
  },
};

/** Whether `v` names a built-in profile. */
export function isKnownProfile(v: string): v is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(v);
}

/**
 * Resolve the profile NAME from env > file > {@link DEFAULT_PROFILE}.
 *
 * An unrecognised name falls back to the default rather than failing the boot —
 * the rule every other enum in `config.ts` follows (`driveMode`, the `claude:`
 * modes, whisper `mode`). The direction is defensible here in a way it is not
 * for a single lever: the fallback is `balanced`, so a typo can only ever land
 * you on the same posture a config-less instance already has, never on `yolo`.
 *
 * Deliberately NOT tsconfig-style `extends`: a closed set of names, one level,
 * no chains, no path resolution. The inheritance is fine; arbitrary-file
 * inheritance graphs are what make `extends` unpleasant.
 */
export function resolveProfileName(
  fileVal: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ProfileName {
  const raw = env.PADDOCK_PROFILE?.trim() || (fileVal === undefined || fileVal === null ? "" : String(fileVal).trim());
  const name = raw.toLowerCase();
  return name && isKnownProfile(name) ? name : DEFAULT_PROFILE;
}

/** The posture a profile name expands to. */
export function posture(name: ProfileName): Posture {
  return PROFILES[name];
}
