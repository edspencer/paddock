/**
 * herdctl-agent-config — the pure builders that project a Paddock `Project` (+
 * config) into the herdctl agent-config objects `FleetManager.addAgent` accepts,
 * plus {@link ensureConfigFile} which writes the minimal boot herdctl.yaml.
 *
 * Split out of {@link HerdctlService} (issue #403): every function here reads
 * only its arguments (the `PaddockConfig` bag + the project/trigger) and the
 * pure constants from {@link ./herdctl-agent-names.js} — no `fleet`/live-session
 * state — so they are independently readable and testable. {@link HerdctlService}
 * keeps thin private wrappers that delegate here (so `this.cfg` stays the single
 * source of config and the existing private-method test seams are unchanged).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { PaddockConfig } from "./config.js";
import type { Project } from "./projects.js";
import {
  EMPTY_MCP_SOURCES,
  mcpServersFor,
  mcpToolPattern,
  type McpSources,
} from "./claude-mcp.js";
import {
  DEFAULT_MODEL,
  SWEEPER_DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_MAX_TURNS,
} from "./models.js";
import {
  triggerToAgentToolConfig,
  triggersToHerdctlSchedules,
  curatorTriggerOf,
  type PaddockTrigger,
} from "./trigger-config.js";
import {
  keeperAgentName,
  sweeperAgentName,
  triggerAgentName,
  browserMcpServers,
  FLEET_ALLOWED_TOOLS,
  DENIED_TOOLS,
  KEEPER_MAX_CONCURRENT,
  KEEPER_SESSION_TIMEOUT,
} from "./herdctl-agent-names.js";


/**
 * A project's keeper agent config. Inherits the fleet `defaults` (runtime,
 * max_turns, permission_mode, allowed/denied tools) via addAgent's deep-merge;
 * only project-specific fields are set here.
 *
 * Model resolution: `modelOverride` (a per-chat override) wins, else the
 * project's persisted `model`, else the keeper default (Opus).
 *
 * System prompt: by default (`nativeSystemPrompt`, issue #176) we set NO
 * `system_prompt`, so Claude Code's full default coding prompt applies — the SDK
 * runtime falls back to the `claude_code` preset and the CLI runtime passes no
 * `--system-prompt`, which amount to the same thing. It applies together with
 * the project's CLAUDE.md hierarchy — the canonical instance-wide
 * `<projectsRoot>/CLAUDE.md`
 * (auto-loaded via the cwd walk-up, since a project dir is a child of the
 * projects root) plus a per-project CLAUDE.md. This is its own decision (issue
 * #176): an instance with no CLAUDE.md files can opt back into the terse replace
 * prompt below with `PADDOCK_NATIVE_PROMPT=false`.
 *
 * This is the reading #512 settled on, and the reason it is `projectsRoot` and
 * not `<dataDir>`: `projectsRoot` IS the instance's backing repo, so the file is
 * version-controlled. Since #516 the ROOT project reaches it the same way —
 * its cwd IS `projectsRoot`, so the walk-up needs no special-casing.
 *
 * `mcpSources` is the external MCP servers this instance attaches — the user's
 * own under `claude.mcpServers: host` (#691 step 5) plus the ones the instance
 * declares in its own `mcpServers:` block (step 6). Both are resolved once at
 * boot and passed in rather than re-read here, so this stays pure and so a
 * `.claude.json` is never opened under `mcpServers: own`. It defaults to empty,
 * which is both the isolated mode and what every existing caller means. The
 * KEEPER is the only agent that gets them: the sweeper is tool-less and each
 * trigger declares its own narrow allowlist, so neither could call one anyway.
 */
export function buildAgentConfig(
  cfg: PaddockConfig,
  project: Project,
  modelOverride?: string,
  mcpSources: McpSources = EMPTY_MCP_SOURCES,
): Record<string, unknown> & { name: string } {
  const config: Record<string, unknown> & { name: string } = {
    name: keeperAgentName(project.slug),
    description: project.summary || `Claude Code agent for project ${project.name}.`,
    // Repo-backed projects (issue #187): the keeper runs INSIDE the cloned
    // checkout (project.workingDir), so the repo's own CLAUDE.md + git tooling
    // apply. For a notebook project workingDir === dir, so this is unchanged.
    working_directory: project.workingDir,
    // `runtime` governs the ONE-SHOT `trigger()` path only — it does NOT decide
    // how chats run. `openChatSession` (session drive-mode, the default) hard-codes
    // `new SDKRuntime()` and never reads this field, so a normal chat runs on the
    // Claude Agent SDK regardless. This value bites only when a project is set to
    // `driveMode: batch`, whose turns go through `RuntimeFactory.create`. Set here
    // per-agent because core's `DefaultsSchema` has no `runtime` key: the fleet
    // `defaults.runtime` we write below is stripped when the file is parsed, so
    // there is nothing for addAgent's deep-merge to hand down. Same for the
    // sweeper and trigger copies.
    runtime: "cli",
    model: modelOverride ?? project.model ?? DEFAULT_MODEL,
    // Per-project keeper settings (issue #12). The project DTO always carries
    // concrete values (fleet defaults resolved in projects.ts), so setting
    // them here just overrides the inherited fleet `defaults` per project.
    permission_mode: project.permissionMode ?? DEFAULT_PERMISSION_MODE,
    max_turns: project.maxTurns ?? DEFAULT_MAX_TURNS,
    // Allow parallel chats per project (forks, and just multiple open chats)
    // instead of herdctl's serialize-by-default max_concurrent: 1.
    instances: { max_concurrent: KEEPER_MAX_CONCURRENT },
    // Session retention (Paddock#111): keep an agent-level session alive long
    // enough that a scheduler-fired wake can still resume its transcript. Note
    // Paddock always resumes by EXPLICIT session id, which bypasses this
    // timeout — and the transcript itself is governed by Claude Code's
    // `cleanupPeriodDays` (default 30d, adequate for realistic wake horizons;
    // set out-of-band via .claude/settings.json if longer horizons are needed).
    // So this is defense-in-depth for the fallback-resume path, sized to the
    // reaper's 7-day recurring-wake expiry.
    session: { timeout: KEEPER_SESSION_TIMEOUT },
    default_prompt: "Summarize the current state of this project.",
  };
  // Docker isolation: only set it when the project opts in, so a project that
  // leaves it off keeps inheriting the fleet default (no Docker) unchanged.
  if (project.docker) config.docker = { enabled: true };
  // Native by default: omit the replace prompt so the default coding prompt +
  // CLAUDE.md hierarchy apply (issue #176). Only a non-native instance
  // (PADDOCK_NATIVE_PROMPT=false) gets the terse replace prompt.
  if (!cfg.nativeSystemPrompt) {
    config.system_prompt =
      "You are a Claude Code agent for this project directory. " +
      "Honor any CLAUDE.md present. Keep CHANGELOG.md current. " +
      "Create branches for significant changes; never force-push.";
  }
  // Unified triggers (Epic T / T1): SCHEDULE-type triggers are forwarded into the
  // keeper agent's `schedules` block, in herdctl's OWN `ScheduleSchema` shape,
  // UNMOLESTED — herdctl's cron engine reads `agent.schedules` live every tick, so
  // declaring them here arms them with no translation. The Paddock-only `promptFile`
  // is stripped (the schedule-trigger handler resolves it at fire time). Event/webhook
  // triggers are excluded by triggersToHerdctlSchedules. Only set the key when
  // non-empty so a trigger-less project stays byte-identical to before.
  const schedules = triggersToHerdctlSchedules(project.triggers);
  if (schedules) config.schedules = schedules;
  // MCP servers, from three sources, all landing on the SAME `mcp_servers` key:
  //
  //  - the browser MCP (headless Chromium) when enabled for this box —
  //    `mcp__playwright__*` is already on the inherited defaults.allowed_tools;
  //  - the user's own servers under `claude.mcpServers: host` (#691 step 5);
  //  - the ones this instance declares in its own `mcpServers:` block (#691 step
  //    6), which win over the inherited ones (`mcpServersFor` merges them last).
  //
  // Neither of the latter two is on the default allowlist, because their names are
  // not knowable at config-file-write time — hence the widening below.
  //
  // Paddock's own server still wins a name collision, against BOTH: its flags are
  // box-specific (the Ansible-installed chromium engine, --no-sandbox for an
  // unprivileged LXC) and someone else's `playwright` would almost certainly not
  // start here. A declared collision is warned about by name at boot
  // (`declaredMcpNotices`) so it is not silent.
  const browser = browserMcpServers(cfg.browserMcp);
  const external = mcpServersFor(mcpSources, project.workingDir);
  const servers = { ...external, ...(browser ?? {}) };
  if (Object.keys(servers).length > 0) config.mcp_servers = servers;
  // Widen the allowlist by exactly those servers' tool patterns. WITHOUT this
  // both levers are a no-op with no error: both runtimes auto-deny any tool
  // missing from an explicit `allowed_tools`, so an attached-but-unlisted server
  // connects and then has every call refused. herdctl does this automatically for
  // INJECTED servers only (`cli-runtime.js`), never for config `mcp_servers` —
  // which is why `mcp__playwright__*` is hard-coded into the defaults.
  //
  // Patterns already on the defaults are filtered out, so nothing is restated
  // for an instance with no external servers (or one whose only server paddock's
  // own overrode above) — that config stays byte-identical to before this lever.
  const extra = Object.keys(external)
    .map(mcpToolPattern)
    .filter((pattern) => !FLEET_ALLOWED_TOOLS.includes(pattern));
  if (extra.length > 0) config.allowed_tools = [...FLEET_ALLOWED_TOOLS, ...extra];
  return config;
}

/**
 * The sweeper's working directory: a dedicated per-project dir under the data
 * root, deliberately NOT the project dir (issue #548).
 *
 * A CLI agent's working directory is what Claude Code encodes into its
 * transcript path, so two agents sharing a cwd share ONE session directory. The
 * sweeper's cwd used to be `project.dir`, which for a notebook project equals the
 * keeper's `project.workingDir` — so keeper and sweeper wrote their transcripts
 * into the same `.chats/`. herdctl identifies a freshly-spawned session by
 * set-difference against a pre-spawn directory snapshot, which is immune to a
 * co-located agent *appending* to its own session but NOT to one *creating* a new
 * file: whichever brand-new `*.jsonl` appears first is claimed as "ours". A sweep
 * is scheduled after every keeper turn, so the sweeper's spawn raced the next
 * keeper turn and a user's chat could be bound to the sweeper's hidden curation
 * transcript (wrong reply streamed, wrong transcript resumed, chat missing from
 * the project's list).
 *
 * The sweeper is TOOL-LESS, so its cwd is inert — nothing about curation depends
 * on it (SweepService reads the project's files itself and inlines them in the
 * prompt, then writes the results itself). Giving it its own directory removes
 * the shared directory, and with it the whole class of collisions, structurally.
 *
 * Kept OUTSIDE `projectsRoot` on purpose: core's discovery unions every
 * `~/.claude/projects/*` bucket whose decoded path is a strict *descendant* of an
 * agent's cwd, and the root workspace's cwd IS `projectsRoot`.
 */
export function sweeperWorkingDir(cfg: PaddockConfig, slug: string): string {
  // The root workspace's key is "" (see project-paths.ts); reuse the same
  // `_root` spelling the agent namespace uses so every sweeper dir is non-empty.
  // Any other slug is SLUG_RE-validated upstream, so it holds no separators.
  return path.join(cfg.dataDir, "sweepers", slug === "" ? "_root" : slug);
}

/**
 * A project's sweeper (curator) agent config. TOOL-LESS BY DESIGN: it declares
 * `allowed_tools: []` and never reads or writes files. Instead it RETURNS the
 * curated content as plain assistant text in marked sections (OVERVIEW /
 * CHANGELOG / optional CLAUDE, issue #177); SweepService parses that text and
 * writes OVERVIEW.md / CHANGELOG.md / CLAUDE.md itself.
 *
 * This is cheaper and far more predictable than letting a Haiku agent drive
 * file edits: no tool-loop turns, no partial writes, no permission_mode /
 * denied_tools to reason about.
 *
 * What makes it tool-less is NOT the empty `allowed_tools` — herdctl emits an
 * allow-list only when it is non-empty, so `[]` restricts nothing (#647). The
 * actual guarantees are: no injected MCP servers (the sweeper is the one turn
 * path that does not even get `send_file`), `max_turns: 4`, a system prompt
 * whose first line is "You DO NOT use any tools", and a non-interactive
 * `claude -p` run that cannot answer a permission prompt.
 */
export function buildSweeperConfig(
  cfg: PaddockConfig,
  project: Project,
): Record<string, unknown> & { name: string } {
  // T5: the sweeper IS the default `curate-overview` (event/afterTurn) trigger. When a
  // project declares that trigger with a `run.model`, honor it as the sweeper agent's
  // model (design §2.1 #4). herdctl's per-fire trigger API has no model override, so
  // the per-project `sweeper-<slug>` agent carries it — applied at (re-)registration
  // (boot / `ensureProjectAgent`). Absent ⇒ the cheap curation default, unchanged.
  const curatorModel = curatorTriggerOf(project.triggers)?.run.model;
  return {
    name: sweeperAgentName(project.slug),
    description: `Overview/changelog curator (sweeper) for project ${project.name}.`,
    // NOT project.dir — see sweeperWorkingDir (issue #548).
    working_directory: sweeperWorkingDir(cfg, project.slug),
    // The sweeper only ever runs via the one-shot `trigger()` path, so unlike the
    // keeper's copy this one really does take effect on every sweep: a `claude -p`
    // CLI subprocess. Set here per-agent because core's `DefaultsSchema` has no
    // `runtime` key — the fleet `defaults.runtime` never survives parsing, so
    // there is nothing to inherit (registering via addAgent is not the reason:
    // addAgent does deep-merge the loaded defaults, they just never carry it).
    runtime: "cli",
    model: curatorModel ?? SWEEPER_DEFAULT_MODEL,
    // A handful of turns is plenty since there are no tool loops — and this, not
    // the empty allow-list below, is one of the things actually bounding the run.
    max_turns: 4,
    // Declares NO tools: the sweeper returns text only; SweepService does the
    // writing. Note herdctl does not emit an empty allow-list at all, so this
    // restricts nothing on its own (#647) — see the doc comment above for the
    // properties that do make the sweeper tool-less in practice.
    allowed_tools: [],
    system_prompt:
      "You are a concise project curator. You DO NOT use any tools — you only " +
      "return text. From the recent activity, the current OVERVIEW.md, the " +
      "recent CHANGELOG.md, and the current CLAUDE.md provided in the user " +
      "message, produce these three sections wrapped in these literal markers, " +
      "and NOTHING else:\n" +
      "\n" +
      "<<<OVERVIEW>>>\n" +
      "<the full markdown OVERVIEW.md, which REPLACES the current one wholesale: " +
      "a synthesized snapshot of the project's CURRENT state for an LLM to read " +
      "at the start of a new chat — what the project is, key decisions/facts, " +
      "open questions, and next steps. No changelog or per-session history here. " +
      "Output exactly NOCHANGE only if the current one is already accurate.>\n" +
      "<<<CHANGELOG>>>\n" +
      "<the full markdown CHANGELOG.md, which REPLACES the current one wholesale. " +
      "PRESERVE the existing dated entries and add at most ONE new bullet under a " +
      "`## YYYY-MM-DD` heading at the TOP (newest-first), reusing today's heading " +
      "if present; coalesce near-duplicate recent bullets. What you return becomes " +
      "the ENTIRE file, so never emit a bare sentence or a lone bullet here — that " +
      "would destroy the file's history. If this activity is already captured by a " +
      "recent entry, output exactly NOCHANGE and change nothing.>\n" +
      "<<<CLAUDE>>>\n" +
      "<the full curated-notes body for CLAUDE.md — everything that belongs under " +
      "the `## Curated notes` heading — which REPLACES that managed section " +
      "wholesale (human-authored content above it is preserved for you). ONLY " +
      "long-lived identity/conventions: what the project fundamentally is, key " +
      "decisions, how we work on it. You are shown the whole current file, so " +
      "DEDUP — fold near-duplicate notes into one and drop stale ones. Never " +
      "restate current state/tasks/history (those are OVERVIEW/CHANGELOG). If " +
      "nothing durable changed, output exactly NOCHANGE.>\n" +
      "<<<END>>>\n" +
      "\n" +
      "OVERVIEW.md describes the PROJECT, not the box it runs on: never record " +
      "box/environment operational conventions (how to run/build/expose a dev " +
      "server, ports, localhost vs. dev hostnames/URLs, where to clone, process " +
      "managers) — those are owned by the box's own CLAUDE.md and must not be " +
      "re-described or contradicted here.\n" +
      "\n" +
      "Be factual and terse. Do not invent details not present in the provided " +
      "activity. Output ONLY the three sections between the markers — no preamble, " +
      "no explanation, no tool use.",
    default_prompt: "Curate OVERVIEW.md, CHANGELOG.md and CLAUDE.md from recent activity.",
  };
}

/**
 * A trigger's scoped herdctl agent config (Epic T) — the unified successor to
 * {@link hookAgentConfig}. A trigger that {@link triggerRunsOnOwnAgent} (every event
 * trigger; a schedule trigger with a non-empty `run.tools` allow-list — T2) is
 * registered as its OWN agent `trigger-<slug>-<name>` whose tool config
 * (`allowed_tools`/`permission_mode`/`model`/`max_turns`, projected by
 * {@link triggerToAgentToolConfig} from the trigger's `run`) IS its capability set.
 * Runs in the project's WORKING dir (so a trigger's Bash/Write act on the same tree
 * the keeper does). A trigger that declares no tools gets `allowed_tools: []` — which
 * herdctl does not enforce as a deny-all; see {@link triggerToAgentToolConfig} (#647).
 */
export function buildTriggerConfig(
  cfg: PaddockConfig,
  project: Project,
  triggerName: string,
  trigger: PaddockTrigger,
): Record<string, unknown> & { name: string } {
  const config: Record<string, unknown> & { name: string } = {
    name: triggerAgentName(project.slug, triggerName),
    description: `Trigger "${triggerName}" (${trigger.trigger.type}) for project ${project.name}.`,
    working_directory: project.workingDir,
    // Triggers fire through the one-shot `trigger()` path, so this takes effect on
    // every fire: a `claude -p` CLI subprocess. Set here per-agent for the same
    // reason as the keeper/sweeper copies: core's `DefaultsSchema` has no
    // `runtime` key, so the fleet `defaults.runtime` is stripped at parse and
    // never merged in.
    runtime: "cli",
    // Model defaults to the keeper default unless the run pins one;
    // triggerToAgentToolConfig sets `model` only when the run specifies it, so
    // provide the fallback here so a trigger never boots without a concrete model.
    model: trigger.run.model ?? project.model ?? DEFAULT_MODEL,
    // run → tool config (allowed tools, permission mode, model, max_turns).
    ...triggerToAgentToolConfig(trigger.run),
  };
  if (project.docker) config.docker = { enabled: true };
  const browser = browserMcpServers(cfg.browserMcp);
  if (browser) config.mcp_servers = browser;
  return config;
}

/**
 * Write the minimal herdctl.yaml the FleetManager boots from: a fleet block
 * plus the fleet-wide `defaults` (deep-merged into agents added at runtime),
 * and ZERO agents. All agents are registered programmatically via
 * `fleet.addAgent(...)` in init() — paddock no longer generates per-agent
 * yaml files or calls `reload()`.
 *
 * The `fleet` block is strict (name/description only). `defaults` are deep-
 * merged into each agent by addAgent (mergeDefaults defaults to true), so agents
 * inherit model/max_turns/permission_mode/allowed+denied_tools from here. NOT
 * `runtime`: core's `DefaultsSchema` has no such key, so it is stripped at parse
 * and every agent sets its own.
 */
export async function ensureConfigFile(cfg: PaddockConfig): Promise<void> {
  const configDir = path.dirname(cfg.herdctlConfigPath);
  await fs.mkdir(configDir, { recursive: true });

  const doc = {
    version: 1,
    fleet: {
      name: "paddock",
      description: "Paddock agent fleet (agents registered at runtime).",
    },
    defaults: {
      // Currently INERT: core's `DefaultsSchema` has no `runtime` key, so this is
      // stripped when the file is parsed and never reaches an agent — which is
      // exactly why the keeper/sweeper/trigger configs above each set `runtime`
      // themselves. Left in place because it costs nothing and records the
      // fleet-wide intent; if core ever accepts it, every agent still overrides
      // it. And even honoured it would govern the one-shot `trigger()` path only:
      // chats opened via `openChatSession` always run the SDK runtime.
      runtime: "cli",
      // The default model, so any agent that doesn't set its own runs on it;
      // in practice every agent above sets `model` explicitly anyway.
      model: DEFAULT_MODEL,
      // ~200 turns: enough for real multi-step coding sessions while still
      // bounding runaway agents (CLAUDE.md: always set max_turns). A project
      // can override this per-project (issue #12); this is the inherited
      // default (shared constant so the DTO resolution stays in sync).
      max_turns: DEFAULT_MAX_TURNS,
      // Keeper agents run native (no Docker) with acceptEdits + denied
      // dangerous bash patterns by default; a project can opt into Docker
      // isolation or a different permission mode per-project (issue #12).
      permission_mode: DEFAULT_PERMISSION_MODE,
      // `Skill` MUST be in the allowlist or every skill invocation is
      // permission-denied — both runtimes pass this list through verbatim (CLI:
      // `--allowedTools`; SDK: `options.allowedTools`) and auto-deny any tool not
      // on it, with no prompt. Built-in skills (claude-api,
      // code-review, deep-research, ...) ship inside the CLI binary and are
      // registered/visible regardless of setting-sources, so the ONLY thing
      // blocking them was this missing tool. Skills routinely fan out to
      // sub-agents (`Task`), track progress (`TodoWrite`), and edit notebooks
      // (`NotebookEdit`), each of which is likewise permission-checked against
      // this same allowlist — so include them here to keep skills functional
      // end-to-end (adds no capability the keeper's existing tools don't).
      // BROWSER_MCP_TOOL (mcp__playwright__*) is listed unconditionally: it is a
      // no-op unless the keeper agent actually attaches the playwright
      // server (gated by PADDOCK_BROWSER_MCP), and having it on the allowlist
      // means enabling the browser is a per-box env flip with no code change.
      // Timer-class autonomy tools (Paddock#111): `ScheduleWakeup` + the
      // session-only `Cron*` set + `Monitor` must be on the allowlist or the
      // runtime auto-denies them, so a keeper couldn't schedule a wake even in
      // session mode. `ToolSearch` is the harness's deferred-tool loader —
      // several of these surface as deferred tools reached through it. These
      // only actually DO anything in session drive-mode (the reaper re-fires
      // them); in batch mode they're inert (documented in the box CLAUDE.md).
      // The list itself lives in `herdctl-agent-names.ts` as FLEET_ALLOWED_TOOLS,
      // because a keeper with host MCP servers attached (#691 step 5) has to
      // restate it plus their `mcp__<server>__*` patterns — herdctl's
      // `mergeAgentConfig` REPLACES arrays rather than merging them, so an agent
      // that widens the allowlist inherits nothing from here.
      allowed_tools: [...FLEET_ALLOWED_TOOLS],
      // Best-effort denylist (#179): narrow, honest catastrophic-wipe patterns
      // that do NOT block legitimate absolute-path cleanup. See DENIED_TOOLS.
      denied_tools: [...DENIED_TOOLS],
    },
  };

  const header =
    "# GENERATED by paddock-server. Do NOT hand-edit. Agents are NOT listed\n" +
    "# here — they are registered at runtime via FleetManager.addAgent(). This\n" +
    "# file only carries the fleet identity + the defaults merged into them.\n";
  await fs.writeFile(cfg.herdctlConfigPath, header + YAML.stringify(doc), "utf8");
}
