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
  KEEPER_DEFAULT_MODEL,
  SWEEPER_DEFAULT_MODEL,
  KEEPER_DEFAULT_PERMISSION_MODE,
  KEEPER_DEFAULT_MAX_TURNS,
} from "./models.js";
import {
  triggerToAgentToolConfig,
  triggersToHerdctlSchedules,
  curatorTriggerOf,
  type PaddockTrigger,
} from "./trigger-config.js";
import {
  SCRATCH_AGENT,
  keeperAgentName,
  sweeperAgentName,
  triggerAgentName,
  browserMcpServers,
  BROWSER_MCP_TOOL,
  KEEPER_DENIED_TOOLS,
  KEEPER_MAX_CONCURRENT,
  KEEPER_SESSION_TIMEOUT,
} from "./herdctl-agent-names.js";

/**
 * The scratch (one-off chats) agent config. Defaults to the keeper default
 * model; a per-chat override may re-register it at a different model via
 * `ensureScratchModel`.
 */
export function buildScratchConfig(
  cfg: PaddockConfig,
  model?: string,
): Record<string, unknown> & { name: string } {
  const config: Record<string, unknown> & { name: string } = {
    name: SCRATCH_AGENT,
    description: "One-off / scratch chats.",
    working_directory: cfg.scratchDir,
    // Explicit CLI runtime (Max plan). The fleet `defaults.runtime` is dropped
    // by @herdctl/core's config loader (runtime isn't a fleet-defaults field in
    // 5.13.x), so without this the runner falls back to the SDK runtime. Set it
    // per-agent to guarantee the Max/CLI path.
    runtime: "cli",
    model: model ?? KEEPER_DEFAULT_MODEL,
    default_prompt: "How can I help?",
  };
  // Scratch chats get the native default coding prompt + CLAUDE.md hierarchy by
  // default (issue #176), so an instance-wide CLAUDE.md (a common ancestor of
  // the scratch dir) reaches out-of-project chats too. Only a non-native
  // instance gets the terse replace prompt.
  if (!cfg.nativeSystemPrompt) {
    config.system_prompt =
      "You are a Claude Code agent for one-off chats. Be helpful and concise.";
  }
  // Browser MCP (headless Chromium) when enabled for this box; `mcp__playwright__*`
  // is already on the inherited defaults.allowed_tools.
  const browser = browserMcpServers(cfg.browserMcp);
  if (browser) config.mcp_servers = browser;
  return config;
}

/**
 * A project's keeper agent config. Inherits the fleet `defaults` (runtime,
 * max_turns, permission_mode, allowed/denied tools) via addAgent's deep-merge;
 * only project-specific fields are set here.
 *
 * Model resolution: `modelOverride` (a per-chat override) wins, else the
 * project's persisted `model`, else the keeper default (Opus).
 *
 * System prompt: by default (`nativeSystemPrompt`, issue #176) we set NO
 * `system_prompt`, so herdctl's CLI runtime passes no `--system-prompt` and
 * Claude Code's full default coding prompt applies together with the project's
 * CLAUDE.md hierarchy — the box's root CLAUDE.md (auto-loaded via the cwd
 * walk-up, e.g. `/var/lib/paddock/projects/CLAUDE.md`) plus a per-project
 * CLAUDE.md. This is now its OWN decision, independent of
 * `PADDOCK_DEV_SERVERS_ENABLED` (a `pm`-capability flag it used to be
 * conflated with). An instance with no CLAUDE.md files can opt back into the
 * terse replace prompt below with `PADDOCK_KEEPER_NATIVE_PROMPT=false`.
 */
export function buildKeeperConfig(
  cfg: PaddockConfig,
  project: Project,
  modelOverride?: string,
): Record<string, unknown> & { name: string } {
  const config: Record<string, unknown> & { name: string } = {
    name: keeperAgentName(project.slug),
    description: project.summary || `Keeper agent for project ${project.name}.`,
    // Repo-backed projects (issue #187): the keeper runs INSIDE the cloned
    // checkout (project.workingDir), so the repo's own CLAUDE.md + git tooling
    // apply. For a notebook project workingDir === dir, so this is unchanged.
    working_directory: project.workingDir,
    // Explicit CLI runtime (Max plan) — see the scratch agent note: the fleet
    // `defaults.runtime` is dropped by the core config loader, so set it here.
    runtime: "cli",
    model: modelOverride ?? project.model ?? KEEPER_DEFAULT_MODEL,
    // Per-project keeper settings (issue #12). The project DTO always carries
    // concrete values (fleet defaults resolved in projects.ts), so setting
    // them here just overrides the inherited fleet `defaults` per project.
    permission_mode: project.permissionMode ?? KEEPER_DEFAULT_PERMISSION_MODE,
    max_turns: project.maxTurns ?? KEEPER_DEFAULT_MAX_TURNS,
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
  // (PADDOCK_KEEPER_NATIVE_PROMPT=false) gets the terse replace prompt.
  if (!cfg.nativeSystemPrompt) {
    config.system_prompt =
      "You are a Claude Code keeper agent for this project directory. " +
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
  // Browser MCP (headless Chromium) when enabled for this box; `mcp__playwright__*`
  // is already on the inherited defaults.allowed_tools.
  const browser = browserMcpServers(cfg.browserMcp);
  if (browser) config.mcp_servers = browser;
  return config;
}

/**
 * A project's sweeper (curator) agent config. TOOL-LESS: the sweeper has NO
 * tools (`allowed_tools: []`) — it never reads or writes files. Instead it
 * RETURNS the curated content as plain assistant text in marked sections
 * (OVERVIEW / CHANGELOG / optional CLAUDE, issue #177); SweepService parses
 * that text and writes OVERVIEW.md / CHANGELOG.md / CLAUDE.md itself.
 *
 * This is cheaper and far more predictable than letting a Haiku agent drive
 * file edits: no tool-loop turns, no partial writes, no permission_mode /
 * denied_tools to reason about (all irrelevant with zero tools).
 */
export function buildSweeperConfig(
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
    working_directory: project.dir,
    // Explicit CLI runtime (Max plan) — see the scratch agent note.
    runtime: "cli",
    model: curatorModel ?? SWEEPER_DEFAULT_MODEL,
    // Tool-less: a handful of turns is plenty since there are no tool loops.
    max_turns: 4,
    // NO tools. The sweeper returns text only; SweepService does the writing.
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
      "open questions, and next steps. No changelog or per-session history here.>\n" +
      "<<<CHANGELOG>>>\n" +
      "<exactly ONE changelog bullet line summarizing this recent activity, with " +
      'NO leading "- " and no date heading — just the bare sentence.>\n' +
      "<<<CLAUDE>>>\n" +
      "<ONLY genuinely NEW, DURABLE facts to APPEND to CLAUDE.md — long-lived " +
      "identity/conventions (what the project fundamentally is, key decisions, " +
      "how we work on it) NOT already in the current CLAUDE.md. Bare markdown " +
      "bullets. CLAUDE.md is amend-only and rarely changes — never restate " +
      "current state/tasks/history or rewrite existing content. If there is " +
      "nothing genuinely new and durable to add, output exactly NOCHANGE.>\n" +
      "<<<END>>>\n" +
      "\n" +
      "OVERVIEW.md describes the PROJECT, not the box it runs on: never record " +
      "box/environment operational conventions (how to run/build/expose a dev " +
      "server, ports, localhost vs. dev hostnames/URLs, where to clone, process " +
      "managers) — those are owned by the box's own CLAUDE.md and must not be " +
      "re-described or contradicted here.\n" +
      "\n" +
      "Be factual and terse. Do not invent details not present in the provided " +
      "activity. Output ONLY the two sections between the markers — no preamble, " +
      "no explanation, no tool use.",
    default_prompt: "Curate OVERVIEW.md and CHANGELOG.md from recent activity.",
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
 * the keeper does). A tool-less trigger gets `allowed_tools: []` and can only return text.
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
    // Explicit CLI runtime (Max plan) — the fleet `defaults.runtime` is dropped by
    // the core config loader, so set it here (as keeper/sweeper/hook agents do).
    runtime: "cli",
    // Model defaults to the keeper default unless the run pins one;
    // triggerToAgentToolConfig sets `model` only when the run specifies it, so
    // provide the fallback here so a trigger never boots without a concrete model.
    model: trigger.run.model ?? project.model ?? KEEPER_DEFAULT_MODEL,
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
 * merged into each agent by addAgent (mergeDefaults defaults to true), so the
 * keeper agents inherit runtime/model/permission_mode/denied_tools from here.
 */
export async function ensureConfigFile(cfg: PaddockConfig): Promise<void> {
  const configDir = path.dirname(cfg.herdctlConfigPath);
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(cfg.scratchDir, { recursive: true });

  const doc = {
    version: 1,
    fleet: {
      name: "paddock",
      description: "Paddock keeper-agent fleet (agents registered at runtime).",
    },
    defaults: {
      runtime: "cli",
      // Keeper default (Opus) so the scratch agent and any default-inheriting
      // agent run on it; each keeper sets its own model explicitly anyway.
      model: KEEPER_DEFAULT_MODEL,
      // ~200 turns: enough for real multi-step coding sessions while still
      // bounding runaway agents (CLAUDE.md: always set max_turns). A project
      // can override this per-project (issue #12); this is the inherited
      // default (shared constant so the DTO resolution stays in sync).
      max_turns: KEEPER_DEFAULT_MAX_TURNS,
      // Keeper agents run native (no Docker) with acceptEdits + denied
      // dangerous bash patterns by default; a project can opt into Docker
      // isolation or a different permission mode per-project (issue #12).
      permission_mode: KEEPER_DEFAULT_PERMISSION_MODE,
      // `Skill` MUST be in the allowlist or every skill invocation is
      // permission-denied in `-p` (non-interactive) mode — the CLI is spawned
      // with an explicit `--allowedTools` list (cli-runtime), and any tool not
      // on it is auto-denied with no prompt. Built-in skills (claude-api,
      // code-review, deep-research, ...) ship inside the CLI binary and are
      // registered/visible regardless of setting-sources, so the ONLY thing
      // blocking them was this missing tool. Skills routinely fan out to
      // sub-agents (`Task`), track progress (`TodoWrite`), and edit notebooks
      // (`NotebookEdit`), each of which is likewise permission-checked against
      // this same allowlist — so include them here to keep skills functional
      // end-to-end (adds no capability the keeper's existing tools don't).
      // BROWSER_MCP_TOOL (mcp__playwright__*) is listed unconditionally: it is a
      // no-op unless the keeper/scratch agent actually attaches the playwright
      // server (gated by PADDOCK_BROWSER_MCP), and having it on the allowlist
      // means enabling the browser is a per-box env flip with no code change.
      // Timer-class autonomy tools (Paddock#111): `ScheduleWakeup` + the
      // session-only `Cron*` set + `Monitor` must be on the allowlist or the
      // runtime auto-denies them, so a keeper couldn't schedule a wake even in
      // session mode. `ToolSearch` is the harness's deferred-tool loader —
      // several of these surface as deferred tools reached through it. These
      // only actually DO anything in session drive-mode (the reaper re-fires
      // them); in batch mode they're inert (documented in the box CLAUDE.md).
      allowed_tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "Skill", "NotebookEdit", "ToolSearch", "ScheduleWakeup", "Monitor", "CronCreate", "CronList", "CronDelete", BROWSER_MCP_TOOL],
      // Best-effort denylist (#179): narrow, honest catastrophic-wipe patterns
      // that do NOT block legitimate absolute-path cleanup. See KEEPER_DENIED_TOOLS.
      denied_tools: [...KEEPER_DENIED_TOOLS],
    },
  };

  const header =
    "# GENERATED by paddock-server. Do NOT hand-edit. Agents are NOT listed\n" +
    "# here — they are registered at runtime via FleetManager.addAgent(). This\n" +
    "# file only carries the fleet identity + the defaults merged into them.\n";
  await fs.writeFile(cfg.herdctlConfigPath, header + YAML.stringify(doc), "utf8");
}
