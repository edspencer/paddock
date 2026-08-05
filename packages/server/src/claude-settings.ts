/**
 * The `claude.hooks` lever (#691): whether this instance runs the host machine's
 * Claude Code hooks.
 *
 * This is the one lever in the `claude:` block that is about code execution
 * rather than data. A hook is a shell command Claude Code runs on `PreToolUse`,
 * `PostToolUse`, `SessionStart` and friends, and since #620 paddock has symlinked
 * the user's `~/.claude/settings.json` into its own home unconditionally — so
 * every hook the user has ever configured fires inside every paddock turn, with
 * no key to turn it off. "Isolate it by just trying paddock" was not true, and
 * this is why.
 *
 * ## Why this cannot be a symlink decision
 *
 * `settings.json` is a mixed bag. It carries `hooks`, and also `permissions`,
 * `model`, `statusLine`, `enabledPlugins`, `env`, `outputStyle` — the things a
 * user configures once and expects everywhere. A symlink is all-or-nothing and
 * the file is not, so `hooks: own` has to leave the rest inherited while dropping
 * one key.
 *
 * So paddock WRITES `<ownHome>/settings.json` itself: parse the user's, drop
 * {@link HOST_ONLY_SETTINGS_KEYS}, serialise the remainder. `hooks: host` is the
 * old symlink, unchanged.
 *
 * ### The staleness this buys, and why it is acceptable
 *
 * A copy diverges the moment the user edits theirs; a symlink never does. Three
 * things make that tolerable rather than a design flaw:
 *
 * 1. **It is regenerated on every boot** (`ensureClaudeHome`), so a restart is
 *    the whole of the fix, and paddock says so in the boot notice.
 * 2. **Only users who actually have hooks pay it.** {@link planHostSettings}
 *    returns `link` when the user's file has none of the governed keys, which is
 *    most files — nothing to filter, so nothing is copied and there is nothing to
 *    go stale. The copy exists exactly where filtering is doing work.
 * 3. Claude Code reads user settings when a session process starts, and paddock's
 *    session runtime outlives any single turn, so even a symlink is not "live"
 *    for a session already running. A restart is already the reliable way to
 *    apply a settings change; the copy makes it the only one.
 *
 * A file-watcher that regenerated on change was the alternative. It buys a
 * narrower window at the cost of a watcher on a path in the user's home, a race
 * with paddock's own write, and a second way for the file to change — not worth
 * it for a file people edit a handful of times a year.
 *
 * ## What `own` does NOT stop, and should
 *
 * `hooks` is not the only key in `settings.json` that names a command to run.
 * Read straight out of the SDK's own settings schema
 * (`@anthropic-ai/claude-agent-sdk/sdk.mjs`), these do too:
 *
 * - `apiKeyHelper` — "Path to a script that outputs authentication values"
 * - `awsCredentialExport` — "Path to a script that exports AWS credentials"
 * - `awsAuthRefresh` — "Path to a script that refreshes AWS authentication"
 * - `gcpAuthRefresh` — "Command to refresh GCP authentication"
 * - `proxyAuthHelper` — "Shell command that outputs a Proxy-Authorization header"
 * - `otelHeadersHelper` — "Path to a script that outputs OpenTelemetry headers"
 * - `statusLine`, `subagentStatusLine`, `fileSuggestion` — `{type:"command", …}`
 *
 * #691 scopes this lever to `hooks`, so `hooks` is what {@link
 * HOST_ONLY_SETTINGS_KEYS} contains — widening a default-on security lever past
 * its brief is the maintainer's call, not this module's. It is one line when he
 * makes it, and the trade-off is not obvious in either direction: the first five
 * of those are how a user's login WORKS on a corporate setup, so dropping them
 * under a key named `hooks` would break authentication for exactly the people who
 * did nothing wrong — an argument that they belong under `claude.credentials`
 * rather than here. Until someone decides, `hooks: own` means "no host hooks",
 * not "no host commands", and this comment is the difference.
 */

/**
 * Whether this instance runs the host machine's Claude Code hooks — the
 * `claude.hooks` key.
 *
 * `own` (default) = paddock writes a `settings.json` carrying the user's other
 * keys with `hooks` dropped. `host` = the user's `~/.claude/settings.json`
 * symlinked in whole, hooks included, which is what every version before this
 * one did.
 */
export type HooksMode = "own" | "host";

/**
 * Isolation is the default, and here it is the only defensible one: `host` means
 * arbitrary commands from outside the data dir execute inside paddock's turns,
 * and that is not something a user should opt out of after the fact.
 */
export const DEFAULT_HOOKS_MODE: HooksMode = "own";

/** Type guard, so an unknown config value falls back instead of failing a boot. */
export function isKnownHooksMode(value: string): value is HooksMode {
  return value === "own" || value === "host";
}

/** The Claude home entry this lever filters. */
export const SETTINGS_ENTRY = "settings.json";

/**
 * Keys of `settings.json` that `hooks: own` drops. See the module doc for the
 * several others that arguably belong here and are deliberately not.
 */
export const HOST_ONLY_SETTINGS_KEYS = ["hooks"] as const;

/**
 * Where paddock records the SHA-256 of each file it generated in its own home,
 * so a later boot can tell its own output from something a human put there.
 *
 * A marker key inside `settings.json` would need no second file, but the schema
 * is Claude Code's and adding a key to it is asking for a validation warning on
 * some future version. A hash sidecar is inert by construction.
 */
export const GENERATED_MARKER_FILE = ".paddock-generated.json";

/** What {@link planHostSettings} decided to do with the user's settings file. */
export type SettingsPlan =
  /** Nothing governed is present: symlink it, exactly as `host` would. */
  | { action: "link" }
  /** Write this content into paddock's home instead of linking. */
  | { action: "write"; content: string; dropped: string[] }
  /** Unusable: plant nothing, and say why. Fail closed, never link. */
  | { action: "skip"; reason: string };

/**
 * Decide what paddock's own `settings.json` should be, given the user's.
 *
 * Pure, so the whole decision is testable without a filesystem.
 *
 * The `skip` case is the security-relevant one. A `settings.json` that will not
 * parse cannot be filtered, and the safe response is to plant NOTHING rather than
 * fall back to a symlink — a symlink would hand over the hooks this lever exists
 * to withhold, and it would do it precisely when something is already wrong.
 * Claude Code will not be able to read that file either, so the instance loses
 * nothing it would otherwise have had.
 */
export function planHostSettings(mode: HooksMode, raw: string): SettingsPlan {
  if (mode === "host") return { action: "link" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { action: "skip", reason: `it is not valid JSON (${String(err)})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { action: "skip", reason: "its top level is not a JSON object" };
  }
  const settings = parsed as Record<string, unknown>;
  const dropped = HOST_ONLY_SETTINGS_KEYS.filter((k) => k in settings);
  if (dropped.length === 0) return { action: "link" };
  const kept: Record<string, unknown> = {};
  // Insertion order preserved, minus the dropped keys — a user comparing the two
  // files should see a deletion, not a reshuffle.
  for (const [k, v] of Object.entries(settings)) {
    if (!(dropped as readonly string[]).includes(k)) kept[k] = v;
  }
  return { action: "write", content: `${JSON.stringify(kept, null, 2)}\n`, dropped: [...dropped] };
}
