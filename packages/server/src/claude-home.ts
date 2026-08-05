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
 *    that lives in `~/.claude`, put `claude.credentials` into the environment
 *    Claude Code runs in, and report anything an operator needs to know.
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
 * `catch {}` — is gone: paddock's home is never the user's, so the directory it
 * migrates can only be its own (#691, `resolveClaudeHome`).
 *
 * The one thing that DOES write under `~/.claude` is `claude.transcripts: host`,
 * which creates the encoded folder its symlink points at. That is the user
 * asking for their transcripts to be shared, by name, in a config file — see
 * `ensureProjectChats`.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";
import type { PaddockConfig } from "./config.js";
import { applyCredentialsMode, SECURE_STORAGE_DIR_VAR } from "./claude-credentials.js";
import { INSTRUCTION_ENTRIES } from "./claude-instructions.js";
import {
  planHostSettings,
  GENERATED_MARKER_FILE,
  SETTINGS_ENTRY,
  type HooksMode,
} from "./claude-settings.js";

/**
 * The user's file-based Claude Code login, bridged in only under
 * `claude.credentials: host` (#691).
 *
 * This is what the lever means on Linux and in the Docker image, where `claude
 * login` writes a file rather than using a keychain: on darwin `credentials: host`
 * is the `CLAUDE_SECURESTORAGE_CONFIG_DIR` empty-string trick, here it is this
 * symlink, and one config key has to mean the same thing on both.
 *
 * Symlinked rather than copied — a copy would duplicate a live secret onto disk
 * AND diverge the moment Claude Code refreshed the token.
 *
 * It was bridged unconditionally before the lever existed, which is why
 * `credentials` defaulting to `host` keeps every existing install working
 * unchanged; `own` is the new behaviour, and it has to also REMOVE a link a
 * previous boot planted, or "isolated" would be a claim that only holds for
 * instances that were never anything else.
 */
export const CREDENTIAL_ENTRY = ".credentials.json";

/**
 * Entries of the user's Claude home that paddock can bridge into its own — the
 * complete list, for callers that want to reason about the surface rather than
 * about one lever.
 *
 * There is no longer an "always bridged" set: since #691 step 4, every entry here
 * belongs to exactly one key of the `claude:` block, and the mapping is the whole
 * point of the block.
 *
 * | Entry | Lever |
 * |---|---|
 * | `CLAUDE.md`, `agents/`, `commands/`, `plugins/` | `claude.instructions` |
 * | `settings.json` (its `hooks` key) | `claude.hooks` |
 * | `.credentials.json` | `claude.credentials` |
 *
 * `settings.json` appears under `hooks` because that is the half of it a lever
 * governs; its OTHER keys — permissions, model, statusline, `enabledPlugins` —
 * are inherited in every mode, which is why `hooks: own` writes a filtered file
 * rather than declining to bridge one. See `claude-settings.ts`.
 *
 * Deliberately NOT bridged in any mode: `projects/` (that's the whole point), and
 * everything that is per-instance runtime state — `todos/`, `shell-snapshots/`,
 * `statsig/`, `sessions/`. Those are exactly what should be per-instance.
 *
 * The fifth lever, `claude.mcpServers`, has NO row here on purpose: MCP servers
 * are declared in `~/.claude.json`, which is a sibling of the home rather than an
 * entry inside it, so it is not bridgeable at all — paddock reads it and passes
 * the servers programmatically (`claude-mcp.ts`). That asymmetry is the reason
 * MCP inheritance broke separately from everything in this table.
 */
export const BRIDGEABLE_ENTRIES: readonly string[] = [
  SETTINGS_ENTRY,
  ...INSTRUCTION_ENTRIES,
  CREDENTIAL_ENTRY,
];

/** Env vars that authenticate Claude Code without any on-disk credential. */
const TOKEN_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * Keychain service names Claude Code is known to store its login under.
 *
 * Only the unsuffixed form matters here: with `CLAUDE_CONFIG_DIR` set, Claude
 * Code appends a path hash, and an entry under THAT name is one paddock's own
 * home can already see. What we are looking for is the login made before paddock
 * was involved.
 *
 * The first name is now **confirmed exact**, not guessed (#691): the SDK bundle
 * builds it as `` `Claude Code${OAUTH_FILE_SUFFIX}${"-credentials"}${hash}` ``,
 * with an empty production suffix and no hash when the config dir is unscoped —
 * see `claude-credentials.ts`, which quotes the function. The second is kept as a
 * cheap hedge against an older or future spelling; it costs one `security` call
 * that fails fast, and {@link probeMacosKeychainLogin} is built so a miss is
 * harmless either way.
 */
const KEYCHAIN_SERVICE_NAMES = ["Claude Code-credentials", "Claude Code"];

/**
 * What a Keychain probe concluded.
 *
 * `unknown` is the important one and the default: not darwin, no `security`
 * binary, the lookup errored, or we simply did not find an entry under a name we
 * guessed. It must never be reported to the user as "you have no login".
 */
export type KeychainFinding = "found" | "unknown";

/** Probe for a macOS login paddock's own home cannot see. Injectable for tests. */
export type KeychainProbe = () => Promise<KeychainFinding>;

/**
 * Ask the macOS Keychain whether a plain-name Claude Code login exists (#683).
 *
 * The whole value of this is turning "you appear to have no credentials" into
 * "you ARE logged in; paddock cannot see it, and here is the one-liner" — a
 * distinction paddock currently cannot make, and the difference between a
 * message that describes a problem and one that fixes it.
 *
 * ## The asymmetry, which is deliberate
 *
 * A positive result is trustworthy: an entry under that service name is a login.
 * A negative result is NOT — `security` can fail for a dozen reasons that have
 * nothing to do with the user, and the service name, though now read straight out
 * of the SDK bundle rather than guessed, is still Claude Code's internal detail
 * and can change. So a miss returns `unknown`, and the caller falls back to the
 * existing, correct, generic warning. Being wrong about the name therefore costs
 * nothing beyond the improvement not happening.
 *
 * Never prompts and never reads a secret: `find-generic-password` WITHOUT `-w`
 * reports existence only (attributes, which are discarded), so nothing sensitive
 * reaches a log, a transcript, or this process's memory.
 *
 * One known imprecision, left in on purpose: Claude Code's own lookup also passes
 * `-a` (`process.env.USER`, falling back to the OS username), and this does not.
 * So an entry filed under a DIFFERENT account still reads as `found` here while
 * Claude Code would miss it — a service running under a different `USER` than the
 * terminal that logged in. Matching that exactly would trade a rare false
 * positive for a rarer false negative, and a false negative is the one that costs
 * something: it downgrades a specific instruction back to the generic warning.
 */
export async function probeMacosKeychainLogin(
  platform: string = process.platform,
): Promise<KeychainFinding> {
  if (platform !== "darwin") return "unknown";
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  for (const service of KEYCHAIN_SERVICE_NAMES) {
    // No `-w`: existence only. Output is discarded either way.
    const found = await run("security", ["find-generic-password", "-s", service], {
      timeout: 5_000,
    }).then(
      () => true,
      () => false,
    );
    if (found) return "found";
  }
  return "unknown";
}

/** A message for the operator, at the level it should be logged at. */
export interface ClaudeHomeNotice {
  level: "info" | "warn";
  message: string;
}

export interface ClaudeHomeReport {
  /** Entries symlinked in from the user's home this boot. */
  bridged: string[];
  /**
   * Entries whose bridge symlink was REMOVED this boot because the lever that
   * governs them now says `own` (#691).
   *
   * The bridge is non-clobbering, so without this an instance that was ever
   * `host` would keep reading the user's file forever after being reconfigured —
   * "isolated" would be a claim that only holds for instances that were never
   * anything else.
   */
  withdrawn: string[];
  /**
   * Entries paddock WROTE into its own home this boot rather than symlinking,
   * because a lever needs part of a file and not the whole of it. Only
   * `settings.json` today — see `claude-settings.ts`.
   */
  generated: string[];
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
 * Symlink one entry of the user's home into paddock's, if paddock's does not
 * already have that name. Returns whether a link was planted THIS call.
 *
 * Non-clobbering by `lstat`, not `stat`: a bridge symlink planted on a previous
 * boot whose target has since been removed still occupies the name, and
 * re-linking it would be a no-op churn at best. Never throws — a race with
 * another instance, or a read-only home, is not a reason to fail a boot.
 */
async function bridgeEntry(
  cfg: Pick<PaddockConfig, "claudeHome" | "legacyClaudeHome">,
  entry: string,
): Promise<boolean> {
  const target = path.join(cfg.legacyClaudeHome, entry);
  const link = path.join(cfg.claudeHome, entry);
  const occupied = await fs
    .lstat(link)
    .then(() => true)
    .catch(() => false);
  if (occupied) return false;
  if (!(await exists(target))) return false;
  return fs.symlink(target, link).then(
    () => true,
    () => false,
  );
}

/**
 * Undo {@link bridgeEntry} for one entry: remove it IF it is a symlink pointing
 * into the user's home. Returns whether anything was removed.
 *
 * Deliberately narrow. A real file at that name is this instance's own — an
 * operator's, or the product of a `CLAUDE_CONFIG_DIR=<own home> claude login` —
 * and removing it would be paddock deleting a credential nobody asked it to
 * touch. A symlink pointing somewhere OTHER than the user's home is not ours
 * either. Only a link paddock itself would have planted is withdrawn, and the
 * withdrawal happens inside paddock's own home, so the "never write to
 * `~/.claude`" invariant is untouched.
 */
async function unbridgeEntry(
  cfg: Pick<PaddockConfig, "claudeHome" | "legacyClaudeHome">,
  entry: string,
): Promise<boolean> {
  const link = path.join(cfg.claudeHome, entry);
  const target = await fs.readlink(link).catch(() => null);
  if (target === null) return false; // absent, or a real file: not ours
  const resolved = path.resolve(path.dirname(link), target);
  if (resolved !== path.resolve(cfg.legacyClaudeHome, entry)) return false;
  return fs.unlink(link).then(
    () => true,
    () => false,
  );
}

/** What is sitting at `<ownHome>/<entry>`, from paddock's point of view. */
type OwnEntryState =
  /** Nothing there. */
  | "absent"
  /** A bridge symlink at the user's file — planted by paddock, so paddock's to remove. */
  | "bridge"
  /** A real file paddock wrote, unmodified since (see {@link GENERATED_MARKER_FILE}). */
  | "generated"
  /** Anything else: a human's file, or a link somewhere paddock never pointed. Hands off. */
  | "foreign";

const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

/** Read the entry → sha256 map of files paddock generated. Never throws. */
async function readGeneratedHashes(home: string): Promise<Record<string, string>> {
  const raw = await fs.readFile(path.join(home, GENERATED_MARKER_FILE), "utf8").catch(() => null);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

/** Record (or, with `null`, forget) the hash of a file paddock generated. */
async function recordGenerated(home: string, entry: string, hash: string | null): Promise<void> {
  const hashes = await readGeneratedHashes(home);
  if (hash === null) {
    if (!(entry in hashes)) return;
    delete hashes[entry];
  } else {
    if (hashes[entry] === hash) return;
    hashes[entry] = hash;
  }
  const marker = path.join(home, GENERATED_MARKER_FILE);
  await fs.writeFile(marker, `${JSON.stringify(hashes, null, 2)}\n`, "utf8").catch(() => {});
}

/**
 * Decide whether paddock may replace `<ownHome>/<entry>`.
 *
 * The `generated` case is the one that is new (#691 step 4) and the one the
 * whole copy-and-filter mechanism rests on. A symlink needs no such question —
 * paddock can always recognise its own by where it points — but a real file it
 * wrote is indistinguishable from a real file a human wrote, and getting that
 * wrong in either direction is bad: refuse to regenerate and the filtered copy
 * is stale forever, regenerate anyway and paddock silently overwrites an
 * operator's settings. Hashing what we wrote and comparing on the next boot
 * answers it exactly, and answers `foreign` — the safe way — for any file we
 * did not write or that has been edited since.
 */
async function classifyOwnEntry(
  cfg: Pick<PaddockConfig, "claudeHome" | "legacyClaudeHome">,
  entry: string,
): Promise<OwnEntryState> {
  const own = path.join(cfg.claudeHome, entry);
  const st = await fs.lstat(own).catch(() => null);
  if (st === null) return "absent";
  if (st.isSymbolicLink()) {
    const raw = await fs.readlink(own).catch(() => null);
    if (raw === null) return "foreign";
    const resolved = path.resolve(path.dirname(own), raw);
    return resolved === path.resolve(cfg.legacyClaudeHome, entry) ? "bridge" : "foreign";
  }
  const content = await fs.readFile(own, "utf8").catch(() => null);
  if (content === null) return "foreign";
  const recorded = (await readGeneratedHashes(cfg.claudeHome))[entry];
  return recorded !== undefined && recorded === sha256(content) ? "generated" : "foreign";
}

/** Remove a file paddock generated, and forget it. Returns whether it went. */
async function removeGenerated(home: string, entry: string): Promise<boolean> {
  const ok = await fs.rm(path.join(home, entry), { force: true }).then(
    () => true,
    () => false,
  );
  if (ok) await recordGenerated(home, entry, null);
  return ok;
}

/**
 * Put the right `settings.json` in paddock's home for the `claude.hooks` mode
 * (#691 step 4).
 *
 * Four states have to compose, and all four are reachable by editing one config
 * key on a running instance:
 *
 * | own home has | `hooks: host` | `hooks: own` |
 * |---|---|---|
 * | nothing | symlink the user's | symlink, or write the filtered copy |
 * | paddock's bridge symlink | leave it | replace with the filtered copy |
 * | paddock's generated file | delete it, symlink | regenerate from the user's |
 * | a human's file | leave it | leave it, and say so if hooks were in play |
 *
 * The last row is the existing non-clobbering bridge behaviour, extended to a
 * file rather than a name — with one addition, because silence there is
 * dangerous: if the user's settings define hooks and paddock is not allowed to
 * write the filtered copy, `hooks: own` is NOT in force for whatever that file
 * says, so it warns rather than leaving an operator to believe a guarantee that
 * is not holding.
 *
 * Never throws; a home it cannot write just keeps whatever it had.
 */
async function materializeSettings(
  cfg: Pick<PaddockConfig, "claudeHome" | "legacyClaudeHome">,
  hooks: HooksMode,
  report: ClaudeHomeReport,
): Promise<void> {
  const entry = SETTINGS_ENTRY;
  const own = path.join(cfg.claudeHome, entry);
  const state = await classifyOwnEntry(cfg, entry);
  const raw = await fs.readFile(path.join(cfg.legacyClaudeHome, entry), "utf8").catch(() => null);

  if (raw === null) {
    // The user has no settings.json at all — including the case where they
    // deleted one paddock had already bridged or filtered. Withdraw ours.
    if (state === "bridge" && (await unbridgeEntry(cfg, entry))) report.withdrawn.push(entry);
    else if (state === "generated" && (await removeGenerated(cfg.claudeHome, entry)))
      report.withdrawn.push(entry);
    return;
  }

  const plan = planHostSettings(hooks, raw);

  if (state === "foreign") {
    if (plan.action === "write") {
      report.notices.push({
        level: "warn",
        message:
          `\`claude.hooks: own\` cannot take effect: ${own} is a file paddock did not write, ` +
          `so it is left alone (as any entry of your own always is). Your ` +
          `~/.claude/${entry} defines hooks, and whatever THAT file says is what runs. ` +
          `Move or delete it to let paddock generate the filtered copy.`,
      });
    }
    return;
  }

  if (plan.action === "skip") {
    // Fail closed: a settings.json that will not parse cannot be filtered, and
    // linking it instead would hand over exactly the hooks `own` withholds.
    if (state === "bridge" && (await unbridgeEntry(cfg, entry))) report.withdrawn.push(entry);
    else if (state === "generated" && (await removeGenerated(cfg.claudeHome, entry)))
      report.withdrawn.push(entry);
    report.notices.push({
      level: "warn",
      message:
        `not using your ~/.claude/${entry}: ${plan.reason}. Paddock could not filter it, and ` +
        `\`claude.hooks: own\` means it must not be used unfiltered — so this instance runs ` +
        `with no user-level settings at all. Fix the JSON and restart.`,
    });
    return;
  }

  if (plan.action === "link") {
    // Nothing to filter (no hooks, or `hooks: host`): the symlink is strictly
    // better than a copy, so prefer it even under `own`. Only users who actually
    // have hooks pay the staleness of a copy.
    if (state === "generated") await removeGenerated(cfg.claudeHome, entry);
    if (await bridgeEntry(cfg, entry)) report.bridged.push(entry);
    return;
  }

  if (state === "bridge") await fs.unlink(own).catch(() => {});
  const existing = state === "generated" ? await fs.readFile(own, "utf8").catch(() => null) : null;
  if (existing !== plan.content) {
    const ok = await fs.writeFile(own, plan.content, "utf8").then(
      () => true,
      () => false,
    );
    if (!ok) {
      report.notices.push({
        level: "warn",
        message:
          `could not write ${own}, so \`claude.hooks: own\` is not in force — this instance ` +
          `has no user-level settings rather than filtered ones.`,
      });
      return;
    }
    report.generated.push(entry);
  }
  await recordGenerated(cfg.claudeHome, entry, sha256(plan.content));
  report.notices.push({
    level: "info",
    message:
      `Claude hooks: your ~/.claude/${entry} defines ${plan.dropped.join(", ")}, which this ` +
      `instance does NOT run (\`claude.hooks: own\`). Paddock writes its own ${entry} carrying ` +
      `every other key of yours — permissions, model, statusline — and regenerates it at ` +
      `startup, so restart paddock after editing yours. Set \`claude.hooks: host\` to run them.`,
  });
}

/**
 * Create paddock's Claude home and put the user-level config into it that this
 * instance's `claude:` levers say it should have (#691).
 *
 * Idempotent and non-clobbering: a real file the user put in paddock's home is
 * left completely alone, so this is safe to run on every start. What it DOES
 * maintain is what paddock itself planted — bridge symlinks, withdrawn when a
 * lever flips to `own`, and the generated `settings.json`, regenerated from the
 * user's current one. Ownership of a generated file is decided by hash
 * ({@link classifyOwnEntry}), never by "it is at a name we use".
 *
 * Never throws. A home that cannot be created is not a reason to refuse to boot
 * — Claude Code falls back to its own default and chat still works, which is the
 * same failure mode `ensureProjectChats` has always had.
 *
 * **Mutates `env`** (`process.env` by default) to carry `claude.credentials` into
 * the environment Claude Code runs in — see {@link applyCredentialsMode} for why
 * that is the only seam available and why it is safe process-wide. Done here
 * because this is already the one call that runs before the fleet starts, and
 * because the credential warning below has to describe the environment it just
 * set rather than the one it found.
 */
export async function ensureClaudeHome(
  cfg: Pick<PaddockConfig, "claudeHome" | "legacyClaudeHome" | "claude">,
  env: NodeJS.ProcessEnv = process.env,
  probeKeychain: KeychainProbe = probeMacosKeychainLogin,
): Promise<ClaudeHomeReport> {
  const report: ClaudeHomeReport = { bridged: [], withdrawn: [], generated: [], notices: [] };
  const credentials = cfg.claude.credentials;
  const decision = applyCredentialsMode(credentials, env);
  if (decision.action === "deferred") {
    report.notices.push({
      level: "info",
      message:
        `${SECURE_STORAGE_DIR_VAR} is already set to "${decision.value}"; honouring it and ` +
        `ignoring \`claude.credentials: ${credentials}\`. Unset it to let paddock choose.`,
    });
  }
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

  // No "is this home ours?" branch any more (#691): it always is, and a config
  // that resolves the home to `~/.claude` never gets this far — `resolveClaudeHome`
  // refuses to start. What remains is one lever per entry.

  // The login — `claude.credentials`, step 3. Its file half on Linux/Docker.
  if (credentials === "host") {
    if (await bridgeEntry(cfg, CREDENTIAL_ENTRY)) report.bridged.push(CREDENTIAL_ENTRY);
  } else if (await unbridgeEntry(cfg, CREDENTIAL_ENTRY)) {
    report.withdrawn.push(CREDENTIAL_ENTRY);
    report.notices.push({
      level: "info",
      message:
        `removed the bridged ${CREDENTIAL_ENTRY} symlink into ${cfg.legacyClaudeHome}: ` +
        `\`claude.credentials: own\` means this instance uses only its own login. A real ` +
        `${CREDENTIAL_ENTRY} in ${cfg.claudeHome} is left alone.`,
    });
  }

  // CLAUDE.md, agents, commands, plugins — `claude.instructions`, step 4.
  const instructions = cfg.claude.instructions;
  for (const entry of INSTRUCTION_ENTRIES) {
    if (instructions === "host") {
      if (await bridgeEntry(cfg, entry)) report.bridged.push(entry);
    } else if (await unbridgeEntry(cfg, entry)) {
      report.withdrawn.push(entry);
    }
  }
  if (instructions === "own") {
    // Named rather than left to be discovered. `own` is the default and it is a
    // real behaviour change for anyone with a curated `~/.claude/CLAUDE.md`:
    // their agents quietly stop knowing things, with no error to search for. So
    // paddock says which of their files it is not using, and which key turns
    // them back on. Only when they HAVE some — otherwise it is noise.
    const present: string[] = [];
    for (const entry of INSTRUCTION_ENTRIES) {
      if (await exists(path.join(cfg.legacyClaudeHome, entry))) present.push(entry);
    }
    if (present.length > 0) {
      report.notices.push({
        level: "info",
        message:
          `Claude instructions: this instance's own only (\`claude.instructions: own\`). Your ` +
          `~/.claude ${present.join(", ")} ${present.length === 1 ? "is" : "are"} NOT loaded — ` +
          `set \`claude.instructions: host\` (or PADDOCK_CLAUDE_INSTRUCTIONS=host) to share ` +
          `them. Each project's own CLAUDE.md is unaffected either way.`,
      });
    }
  }

  // settings.json — `claude.hooks`, step 4. Not a bridge decision: the file is a
  // mixed bag, so `own` writes a filtered copy. See `materializeSettings`.
  await materializeSettings(cfg, cfg.claude.hooks, report);

  report.notices.push({
    level: "info",
    message:
      `Claude home: ${cfg.claudeHome} (paddock-owned; ~/.claude is read-only)` +
      (report.bridged.length > 0 ? ` — bridged from ~/.claude: ${report.bridged.join(", ")}` : "") +
      (report.generated.length > 0 ? ` — generated: ${report.generated.join(", ")}` : "") +
      (report.withdrawn.length > 0 ? ` — withdrawn: ${report.withdrawn.join(", ")}` : ""),
  });

  // The credential question (#620, #683). Claude Code derives its secure-storage
  // service name from whether `CLAUDE_CONFIG_DIR` is SET AT ALL — unset gets the
  // plain name, set gets a path-hash suffix. Paddock always sets it, so a login
  // held in the macOS Keychain under the plain name is invisible unless
  // `credentials: host` un-scopes it above. A token in the environment is
  // unaffected, and a file-based login is bridged (under `host`); if none of that
  // applies we cannot see a credential at all, so say so BEFORE the first turn
  // fails with "Not logged in" rather than leaving the operator to work it out
  // from a chat that never replies.
  const hasTokenEnv = TOKEN_ENV_VARS.some((v) => (env[v] ?? "").trim().length > 0);
  const hasCredentialFile = await exists(path.join(cfg.claudeHome, CREDENTIAL_ENTRY));
  if (!hasTokenEnv && !hasCredentialFile) {
    // #683: "you have no login" and "your login exists but I changed the service
    // name it is filed under" were the same message, and only one of them is the
    // user's problem to solve. On darwin we can tell them apart, and a hit either
    // resolves the question outright (`host`) or upgrades a paragraph of
    // explanation into an instruction (`own`). A miss is inconclusive by design
    // (see probeMacosKeychainLogin), so it falls through to the generic wording
    // rather than asserting anything.
    const keychain = await probeKeychain();
    if (keychain === "found" && credentials === "host") {
      // Not a problem: this is the lever working. Said out loud anyway, because
      // "paddock found no credentials of its own and is using yours" is exactly
      // the kind of thing an operator should not have to deduce.
      report.notices.push({
        level: "info",
        message:
          `Claude login: this machine's own, from the macOS Keychain ` +
          `(\`claude.credentials: host\`). Paddock sets ${SECURE_STORAGE_DIR_VAR}="" so Claude ` +
          `Code reads the same unsuffixed entry your own \`claude\` does, while its config dir ` +
          `stays at ${cfg.claudeHome}. Set \`claude.credentials: own\` to use only a login of ` +
          `this instance's.`,
      });
    } else {
      report.notices.push({
        level: "warn",
        message:
          keychain === "found"
            ? `you ARE logged in to Claude Code, but paddock cannot see it. The login is in the ` +
              `macOS Keychain, and Claude Code files it under a service name derived from ` +
              `whether CLAUDE_CONFIG_DIR is set — paddock sets it, to ${cfg.claudeHome}, so it ` +
              `looks under a different name. \`claude.credentials: own\` is what keeps it that ` +
              `way. Fix it either way: drop that key (the default is \`host\`, which shares this ` +
              `machine's login and writes nothing), or log in for this home too with ` +
              `\`CLAUDE_CONFIG_DIR=${cfg.claudeHome} claude login\`.`
            : `no Claude credentials found for ${cfg.claudeHome}: no ${CREDENTIAL_ENTRY} and no ` +
              `${TOKEN_ENV_VARS.join("/")} in the environment` +
              (credentials === "host"
                ? ` — and \`claude.credentials: host\` found nothing on this machine to share ` +
                  `either (no ~/.claude/${CREDENTIAL_ENTRY}, and no macOS Keychain login under ` +
                  `the name Claude Code uses). `
                : `, and \`claude.credentials: own\` means this instance shares none of yours. ` +
                  `Claude Code scopes its credential store to CLAUDE_CONFIG_DIR, so a login in ` +
                  `the OS keychain against the default home will NOT be found here. `) +
              `If turns fail with "Not logged in", re-run \`claude login\` with ` +
              `CLAUDE_CONFIG_DIR=${cfg.claudeHome}, or put a token in the environment.`,
      });
    }
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
 * A folder paddock's own home ALREADY links to directly is skipped for the same
 * reason. That is the `claude.transcripts: host` case (#691): there the folder in
 * the user's home is a real directory that paddock itself writes through, so
 * mirroring it would offer every project's own live chats back as importable —
 * the #658 mistake with the arrow reversed. (Adoption de-duplicates sources by
 * resolved real path, so this was noise rather than breakage; it is skipped here
 * because a link paddock plants and then mirrors is confusing to find on disk.)
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
      // Already reachable directly from paddock's own home (`transcripts: host`)?
      // Then it is not an outside source to import; it is where this instance's
      // own chats live.
      const direct = await fs.readlink(path.join(to, folderName)).catch(() => null);
      if (direct !== null && path.resolve(to, direct) === path.resolve(legacyDir)) continue;
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

/** A `~/.claude/projects/<enc>` symlink pointing at some `.chats/` store. */
export interface PlantedChatsLink {
  /** The link itself, inside the user's home — the path to tell the user about. */
  link: string;
  /** What it points at, resolved. Always a `.chats` directory by construction. */
  target: string;
  /** Does the target still exist? A dangling link is the one that breaks tooling. */
  dangling: boolean;
}

/**
 * Find transcript symlinks planted in the user's home that point at a `.chats/`
 * store OUTSIDE `dataDir` (#682).
 *
 * The instance's own leftovers — links into this data dir — are already reported
 * by {@link countLegacyTranscriptLinks} as harmless pre-#620 residue, and they
 * are: they were planted for a project whose transcripts paddock does own.
 *
 * The ones this finds are the poisoned kind. Under `--here` the workspace's
 * `.chats/` sits at `<dir>/.chats` while the data dir is `<dir>/.paddock`, so a
 * link planted by an affected build points somewhere no `dataDir` prefix match
 * will ever catch. While it exists, every `claude` session the user starts in
 * that directory writes into paddock's store instead of their own history, and
 * anything that expects `~/.claude/projects/<enc>` to be a real directory
 * (`unzip -d ~/.claude` being the observed one) fails with an error impossible
 * to trace back here.
 *
 * Reported, never removed. Paddock not writing to `~/.claude` is the entire
 * point of #620, and that has to include cleaning up after itself — a boot that
 * silently deleted something under there would be the same class of surprise in
 * the opposite direction. Naming the exact path is enough: `rm` is one command
 * and the user can see what they are removing first.
 *
 * Never throws; an unreadable home just yields no findings.
 */
export async function findPlantedChatsLinks(
  legacyHome: string,
  dataDir: string,
): Promise<PlantedChatsLink[]> {
  const root = path.join(legacyHome, "projects");
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const ownPrefix = path.resolve(dataDir) + path.sep;
  const found: PlantedChatsLink[] = [];
  for (const name of names) {
    const link = path.join(root, name);
    const raw = await fs.readlink(link).catch(() => null);
    if (raw === null) continue;
    const target = path.resolve(path.dirname(link), raw);
    // `.chats` is paddock's store name and nothing else's — a precise enough
    // signature that a link the user made themselves won't be misreported.
    if (path.basename(target) !== ".chats") continue;
    if (target.startsWith(ownPrefix)) continue; // this instance's own residue
    found.push({ link, target, dangling: !(await exists(target)) });
  }
  return found;
}
