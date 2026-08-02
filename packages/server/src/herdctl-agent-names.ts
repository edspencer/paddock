/**
 * herdctl-agent-names — the pure, stateless name/visibility helpers and
 * constants that map a project slug (+ hook/trigger name) to the deterministic
 * herdctl agent names Paddock registers, plus the small tool/model constants the
 * agent-config builders lean on.
 *
 * These are split out of {@link HerdctlService} (issue #403) because they only
 * read their arguments — no `fleet`/`cfg`/live-session state — so they are
 * independently readable and unit-testable. Everything here is re-exported from
 * `./herdctl.js` so external importers keep resolving via that path unchanged.
 */
import type { Project } from "./projects.js";
import { agentKeyFor, keyFromAgentKey } from "./project-paths.js";

/**
 * Maps a workspace key to its keeper agent name. Kept deterministic so the
 * runtime registration and runtime lookups always agree.
 *
 * The key is encoded through {@link agentKeyFor}, because the root workspace's
 * key is `""` and a bare `keeper-` is not a legal herdctl agent name. Every
 * builder below goes through the same encoding, so none of them needs a root
 * branch. See `project-paths.ts` for why the encoding lives at this boundary
 * rather than in the identity.
 */
export function keeperAgentName(slug: string): string {
  return `keeper-${agentKeyFor(slug)}`;
}

/**
 * Inverse of {@link keeperAgentName}: recover a workspace key from a keeper
 * agent name (`keeper-<agentKey>` → `<key>`). Returns `null` for a non-keeper
 * agent (e.g. a sweeper or a trigger agent), which is how a scheduler-fired wake
 * tells "this is a chat to route back to a workspace" from "this is not a chat
 * at all".
 *
 * **Callers must distinguish `null` from `""`.** The root workspace's key IS the
 * empty string, so a falsy check (`if (!key) return;`) silently drops every root
 * chat from wake/turn/job routing. Compare against `null` explicitly.
 */
export function keeperSlugFromAgent(agentName: string): string | null {
  if (!agentName.startsWith("keeper-")) return null;
  return keyFromAgentKey(agentName.slice("keeper-".length));
}

/**
 * The lightweight curator agent used by the post-turn sweep. Runs on a cheap
 * model (Haiku 4.5) with only read/write tools, no Bash.
 *
 * NOTE: herdctl agents bind working_directory per agent. Because a single
 * shared sweeper can only have one cwd, the SweepService registers ONE sweeper
 * agent PER PROJECT (keeper-style) so each has the right cwd. The name is
 * derived from the slug; the agent reads/writes that project's files.
 */
export const SWEEPER_PREFIX = "sweeper-";

/** Maps a project slug to its sweeper agent name. */
export function sweeperAgentName(slug: string): string {
  return `${SWEEPER_PREFIX}${agentKeyFor(slug)}`;
}

/**
 * The agent-name prefix for event hooks (Epic G / G1). Each hook is its OWN herdctl
 * agent `hook-<slug>-<name>` (GG-1) — registered alongside the keeper/sweeper — whose
 * tool config IS the hook's capability set.
 */
export const HOOK_AGENT_PREFIX = "hook-";

/**
 * Maps a project slug + hook name to its agent name `hook-<slug>-<name>`. Kept
 * deterministic so runtime registration and firing (`startAgentTurn`) always agree.
 * (`slug` is a kebab id and `name` matches `[A-Za-z0-9._-]+`, so the composed name is
 * a valid herdctl agent name; the reverse mapping for visibility (G3) is resolved
 * from a project's declared hooks, not by parsing this string.)
 */
export function hookAgentName(slug: string, hookName: string): string {
  return `${HOOK_AGENT_PREFIX}${agentKeyFor(slug)}-${hookName}`;
}

/**
 * The agent-name prefix for unified triggers (Epic T / T1). An EVENT trigger is its
 * OWN herdctl agent `trigger-<slug>-<name>` (tool config = capability), registered
 * alongside the keeper/sweeper — exactly like a hook agent. Schedule triggers run on
 * the keeper (T1) and webhook triggers are reserved, but every trigger carries this
 * deterministic name in its DTO so the mapping is stable across T2–T5.
 */
export const TRIGGER_AGENT_PREFIX = "trigger-";

/**
 * Maps a project slug + trigger name to its agent name `trigger-<slug>-<name>`. Kept
 * deterministic so runtime registration and firing always agree. The reverse mapping
 * (for visibility) is resolved from a project's declared triggers, not by parsing this
 * string (a slug may contain hyphens). Mirrors {@link hookAgentName}.
 */
export function triggerAgentName(slug: string, triggerName: string): string {
  return `${TRIGGER_AGENT_PREFIX}${agentKeyFor(slug)}-${triggerName}`;
}

/**
 * The agents whose chats are VISIBLE in a project's chat list (Epic G / G3, GG-5):
 * the keeper plus every event hook the project declares (`hook-<slug>-<name>`). This
 * is the generalization of the old hard "keeper-only" listing — "all of a project's
 * agents EXCEPT those marked hidden."
 *
 * The **sweeper** (`sweeper-<slug>`) is the one hidden agent: it is deliberately
 * omitted here so its post-turn curation chats never surface (the `hideChats` case),
 * exactly as before. Scratch is a separate, global one-off list and never a project
 * agent. Disabled hooks are still included — a hook chat that already ran should stay
 * visible regardless of whether the hook is currently armed.
 *
 * Kept pure + exported so the listing filter is unit-testable in isolation (the
 * sweeper-stays-hidden regression lives here), and so future callers have ONE place
 * that answers "which of a project's agents' chats do we show?".
 */
export function visibleProjectAgentNames(project: Project): string[] {
  const names = [keeperAgentName(project.slug)];
  for (const hookName of Object.keys(project.hooks ?? {})) {
    names.push(hookAgentName(project.slug, hookName));
  }
  // Unified triggers (Epic T): a trigger that runs on its OWN `trigger-<slug>-<name>`
  // agent produces visible chats (like a hook) — every event trigger, plus a scoped
  // schedule trigger (T2: one with a `run.tools` allow-list). An unscoped schedule runs
  // on the keeper (already listed) and a webhook never fires, so they add no distinct
  // agent — but registering the deterministic name for every trigger is harmless (a name
  // with no chats simply contributes nothing to the listing).
  for (const triggerName of Object.keys(project.triggers ?? {})) {
    names.push(triggerAgentName(project.slug, triggerName));
  }
  return names;
}

/**
 * The Claude Code tool pattern for the Playwright browser MCP. Must live on the
 * agent allowlist (both runtimes auto-deny any tool not on the allow-list —
 * `--allowedTools` on the CLI, `options.allowedTools` on the SDK — same reason
 * `Skill` is listed) — so it is added to `defaults.allowed_tools`,
 * which the keeper + scratch agents inherit and the tool-less sweeper overrides
 * away. Harmless when the server isn't enabled: an allowed-but-absent tool is a
 * no-op.
 */
export const BROWSER_MCP_TOOL = "mcp__playwright__*";

/**
 * The keeper's default `denied_tools` — a **best-effort, defence-in-depth**
 * denylist, NOT a sandbox. Real isolation (per-agent filesystem confinement)
 * is tracked in #7; these string patterns are trivially bypassable (a relative
 * path, a `$VAR`, a `find -delete`) and are here only to make the obvious
 * catastrophic footguns require deliberate rephrasing.
 *
 * Claude Code Bash patterns are prefix-with-`*` matches: `Bash(foo *)` denies
 * any command starting with `foo `, and `Bash(foo)` denies EXACTLY `foo`.
 *
 * History (#179): this list used to carry `Bash(rm -rf /*)`, intended as "don't
 * wipe root". But `/*` is a trailing wildcard, so it actually denied
 * `rm -rf /<ANYTHING>` — i.e. every absolute-path delete, including the keeper
 * cleaning up its OWN scratch/clone dirs (`rm -rf /tmp/foo`,
 * `rm -rf /var/lib/.../clones/x`). That was both over-broad (blocked legitimate
 * work, wasted turns, confusing "denied" cards) and false security (the agent
 * just switched to a relative `rm -rf clones/x` and it went through).
 *
 * The honest replacement targets genuinely-catastrophic *bare* roots:
 * - `rm -rf /` and `rm -rf / *` (root, incl. `--no-preserve-root` variants),
 * - `rm -rf ~` / `rm -rf $HOME` (home, exact — a trailing wildcard would block
 *   `rm -rf ~/.cache/foo`, which is legitimate),
 * - bare top-level system dirs matched EXACTLY (`Bash(rm -rf /etc)`, …) so that
 *   real subpath deletes under them (notably `/var/lib/paddock/...` and
 *   `/tmp/...`) are NOT denied.
 *
 * Note the deliberate gaps: a literal `rm -rf /*` glob command and
 * `rm -rf /usr/local/...` are NOT caught, because the only pattern that would
 * catch them (`Bash(rm -rf /*)`, `Bash(rm -rf /usr*)`) also re-blocks the
 * legitimate absolute-path deletes we exist to allow. Narrow-and-honest beats
 * broad-and-leaky; the sandbox (#7) is the real fix.
 */
export const DENIED_TOOLS: readonly string[] = [
  // Privilege / permission footguns (unchanged from the original list).
  "Bash(sudo *)",
  "Bash(chmod 777 *)",
  // Root wipes: exact `rm -rf /`, plus `rm -rf / <args>` (the trailing space
  // means this does NOT match `rm -rf /tmp...`, only `rm -rf / --no-preserve-root`
  // and friends).
  "Bash(rm -rf /)",
  "Bash(rm -rf / *)",
  // Home-directory wipes (exact — no trailing wildcard, see doc-comment).
  "Bash(rm -rf ~)",
  "Bash(rm -rf ~/)",
  "Bash(rm -rf $HOME)",
  "Bash(rm -rf $HOME/)",
  // Bare top-level system directories, matched EXACTLY so legitimate subpath
  // deletes (e.g. `/var/lib/paddock/...`, `/tmp/...`) still pass.
  "Bash(rm -rf /bin)",
  "Bash(rm -rf /boot)",
  "Bash(rm -rf /dev)",
  "Bash(rm -rf /etc)",
  "Bash(rm -rf /home)",
  "Bash(rm -rf /lib)",
  "Bash(rm -rf /lib64)",
  "Bash(rm -rf /opt)",
  "Bash(rm -rf /proc)",
  "Bash(rm -rf /root)",
  "Bash(rm -rf /sbin)",
  "Bash(rm -rf /srv)",
  "Bash(rm -rf /sys)",
  "Bash(rm -rf /usr)",
  "Bash(rm -rf /var)",
];

/**
 * The Playwright browser MCP server given to the keeper + scratch agents so
 * Claude Code can drive a headless Chromium (navigate / click / fill / snapshot
 * / screenshot). Returns `undefined` when `enabled` is false (sourced from
 * `cfg.browserMcp`, i.e. `PADDOCK_BROWSER_MCP=1` — issue #269), so a box WITHOUT
 * the browser stack simply omits the server (no failed spawns) and enabling it
 * is a per-box env flip — no code change.
 *
 * The browser is installed box-side by the homelab `paddock` Ansible role
 * (`npm i -g @playwright/mcp` + `playwright install chromium`, exposing the
 * `playwright-mcp` bin on PATH). The boxes are unprivileged LXCs, so Chromium
 * must run headless + `--no-sandbox` (the container is the isolation boundary);
 * `--isolated` keeps each session's profile in-memory (no persisted user-data
 * dir). `--browser chromium` is REQUIRED: @playwright/mcp defaults to the
 * `chrome` channel (branded Google Chrome), which isn't installed — without this
 * flag the server tries to `playwright install chrome` at first use and stalls.
 * The role installs the open-source `chromium` engine, so we select it here.
 * The tool-less sweeper deliberately never receives this server.
 */
export function browserMcpServers(enabled: boolean): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  return {
    playwright: {
      command: "playwright-mcp",
      args: ["--headless", "--no-sandbox", "--isolated", "--browser", "chromium"],
    },
  };
}

/**
 * How many chat turns a project's keeper may run at once. herdctl defaults an
 * agent to `max_concurrent: 1`, which would serialize a project's chats and make
 * a second turn (e.g. the first message of a freshly *forked* chat sent while the
 * parent is still streaming) fail with a ConcurrencyLimitError. Paddock is a
 * single-user box that explicitly wants parallel chats per project — especially
 * forks — so we lift the keeper's limit. (The shared-keeper model is still
 * last-write-wins across concurrent chats of the same project; forks default to
 * the parent's model, so that caveat rarely bites in practice.)
 */
export const KEEPER_MAX_CONCURRENT = 10;

/**
 * How long herdctl keeps a keeper's fallback session alive (Paddock#111). Sized
 * to the reaper's 7-day recurring-wake expiry so a fallback resume still finds
 * the session; explicit-id resume (Paddock's norm) bypasses this anyway.
 */
export const KEEPER_SESSION_TIMEOUT = "168h";
