/**
 * HerdctlService — REAL wrapper around @herdctl/core's FleetManager.
 *
 * This module is NOT a stub: it imports and constructs the public
 * @herdctl/core (5.11.0) API. It is the single seam between paddock and
 * herdctl, so that any remaining gaps in the public API are isolated here.
 *
 * As of @herdctl/core 5.11.0 the four prior app-layer workarounds are GONE —
 * paddock now uses the first-class APIs:
 *
 *  - **Runtime agents:** `fleet.addAgent({...})` / `fleet.removeAgent(name)`
 *    register/unregister a project's keeper + sweeper agents in memory. No more
 *    generate-per-agent-yaml + regenerate-herdctl.yaml + `reload()` dance. The
 *    FleetManager boots from a minimal zero-agent config (fleet + defaults only)
 *    and every agent is added programmatically. `addAgent` validates the config,
 *    deep-merges fleet `defaults`, resolves the working_directory to an absolute
 *    path, and wires it into the scheduler so it is immediately triggerable and
 *    shows up in `getFleetStatus()` / `getAgentInfo()`.
 *
 *  - **Sessions:** `fleet.getAgentSessions(name, {limit})` and
 *    `fleet.getAgentSessionMessages(name, sessionId)` derive the agent's
 *    working_directory + Docker mode from the loaded config — no hand-rolled
 *    SessionDiscoveryService keyed on working dirs.
 *
 *  - **Streaming:** `trigger(agent, schedule?, { onMessage, prompt, resume })`.
 *    `onMessage(msg: SDKMessage)` fires per SDK message; the returned
 *    TriggerResult carries the final `sessionId`. New chat = `resume: null`;
 *    resume = `resume: <sessionId>`.
 *
 *  - **Delete / rename a chat:** `fleet.deleteSession(name, sessionId)` removes
 *    the transcript (and invalidates the discovery cache), and
 *    `fleet.setSessionName(name, sessionId, customName)` sets a custom name —
 *    both keyed by agent name, no deep imports.
 *
 * Freshness note: `fleet.getAgentSessions` uses the FleetManager's internal
 * SessionDiscoveryService, which has a 30s directory cache. A brand-new
 * project's transcript dir does not exist until its first turn, and the
 * discovery service does NOT cache a missing directory — so the first session
 * of a project surfaces immediately. `deleteSession`/`setSessionName` invalidate
 * the cache internally. The one nuance vs. the prior code: a *second* new chat
 * created in an already-listed project within 30s may take up to the cache TTL
 * to appear (the prior code invalidated a private cache we can no longer reach).
 * Acceptable for the POC; a public post-turn invalidation hook is a herdctl
 * follow-up candidate.
 */
import {
  FleetManager,
  type DiscoveredSession,
  type ChatMessage,
  type SDKMessage,
  type TriggerResult,
  type AgentInfo,
  type FleetStatus,
  type SessionUsage,
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { PaddockConfig } from "./config.js";
import type { Project } from "./projects.js";
import { KEEPER_DEFAULT_MODEL, SWEEPER_DEFAULT_MODEL } from "./models.js";

/** Options passed through to a streamed trigger. */
export interface ChatTurnOptions {
  prompt: string;
  /** Session to resume; `null` forces a fresh session; omit for agent fallback. */
  resume?: string | null;
  onMessage?: (msg: SDKMessage) => void | Promise<void>;
  onJobCreated?: (jobId: string) => void;
  triggerType?: string;
}

/**
 * Maps a project slug to its keeper agent name. Kept deterministic so the
 * runtime registration and runtime lookups always agree.
 */
export function keeperAgentName(slug: string): string {
  return `keeper-${slug}`;
}

/** The agent used for one-off / scratch chats. */
export const SCRATCH_AGENT = "scratch";

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
  return `${SWEEPER_PREFIX}${slug}`;
}

/**
 * The model used by the sweeper agent (cheap curation/summarization).
 *
 * Re-exported alias of `SWEEPER_DEFAULT_MODEL` (the canonical constant lives in
 * models.ts now) so existing imports of `SWEEPER_MODEL` keep working.
 */
export const SWEEPER_MODEL = SWEEPER_DEFAULT_MODEL;

/**
 * The slug clients use to address one-off chats over WS/REST. Routed to the
 * scratch agent (working_directory = the scratch dir), not a real project.
 */
export const SCRATCH_SLUG = "scratch";

export class HerdctlService {
  private fleet: FleetManager | null = null;
  private started = false;

  /**
   * The model currently registered for each agent (keyed by agent name). Lets
   * `ensureKeeperModel`/`ensureScratchModel` skip a re-registration when the
   * requested model already matches the live agent config.
   *
   * SINGLE-USER CAVEAT: the keeper is one shared agent per project, so the
   * model is last-write-wins across concurrent chats of the same project — if
   * two chats of the same project pick different models, whichever triggered
   * last wins for both. Acceptable for paddock's single-user POC; a clean
   * per-trigger model override is a herdctl follow-up.
   */
  private agentModels = new Map<string, string>();

  constructor(private readonly cfg: PaddockConfig) {}

  /**
   * Construct + initialize the FleetManager against a minimal zero-agent
   * config (fleet + defaults only). Agents are then registered programmatically
   * via `fleet.addAgent(...)` — the scratch agent plus a keeper + sweeper for
   * each existing project. No per-agent yaml files; no `reload()`.
   */
  async init(projects: Project[]): Promise<void> {
    await this.ensureConfigFile();

    this.fleet = new FleetManager({
      configPath: this.cfg.herdctlConfigPath,
      stateDir: this.cfg.stateDir,
    });
    await this.fleet.initialize();

    // Register the scratch agent (one-off chats) at the keeper default model.
    await fs.mkdir(this.cfg.scratchDir, { recursive: true });
    await this.fleet.addAgent(this.scratchAgentConfig(), { replace: true });
    this.agentModels.set(SCRATCH_AGENT, KEEPER_DEFAULT_MODEL);

    // Register a keeper + sweeper for every existing project, recording each
    // keeper's resolved model so per-chat overrides can short-circuit later.
    for (const project of projects) {
      await this.fleet.addAgent(this.keeperAgentConfig(project), { replace: true });
      await this.fleet.addAgent(this.sweeperAgentConfig(project), { replace: true });
      this.agentModels.set(keeperAgentName(project.slug), project.model ?? KEEPER_DEFAULT_MODEL);
    }
  }

  /** Start the scheduler (keeper agents currently have no schedules, but this
   * keeps the fleet "running" for status + future cron curators). */
  async start(): Promise<void> {
    if (!this.fleet) throw new Error("HerdctlService not initialized");
    if (this.started) return;
    await this.fleet.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.fleet && this.started) {
      await this.fleet.stop({ waitForJobs: false }).catch(() => undefined);
      this.started = false;
    }
  }

  /** Expose the raw FleetManager (events, advanced ops) to callers that need it. */
  get manager(): FleetManager {
    if (!this.fleet) throw new Error("HerdctlService not initialized");
    return this.fleet;
  }

  async fleetStatus(): Promise<FleetStatus> {
    return this.manager.getFleetStatus();
  }

  async agents(): Promise<AgentInfo[]> {
    return this.manager.getAgentInfo();
  }

  /**
   * Register (or replace) a project's keeper + sweeper agents at runtime. Uses
   * `fleet.addAgent` (replace: true), so a re-create or rename of the same slug
   * is idempotent. The new agents are immediately triggerable and visible in
   * fleet status — no yaml + reload round-trip.
   */
  async ensureProjectAgent(project: Project): Promise<void> {
    if (!this.fleet) return;
    await this.fleet.addAgent(this.keeperAgentConfig(project), { replace: true });
    await this.fleet.addAgent(this.sweeperAgentConfig(project), { replace: true });
    // Record the keeper's resolved model so per-chat overrides can detect a
    // no-op. ensureProjectAgent re-registers at project.model (the persisted
    // default), so a model change via PATCH takes effect here too.
    this.agentModels.set(keeperAgentName(project.slug), project.model ?? KEEPER_DEFAULT_MODEL);
  }

  /**
   * Ensure a project's keeper agent is registered at `model`, re-registering it
   * (addAgent replace:true) only when the model actually changed. Used by the
   * WS chat path to honor a per-chat model override before triggering.
   *
   * No herdctl per-trigger model API exists yet, so a model override is applied
   * by re-registering the (single, shared) keeper agent. See the `agentModels`
   * single-user caveat: this is last-write-wins across concurrent chats of the
   * same project.
   */
  async ensureKeeperModel(project: Project, model: string): Promise<void> {
    if (!this.fleet) return;
    const name = keeperAgentName(project.slug);
    if (this.agentModels.get(name) === model) return;
    await this.fleet.addAgent(this.keeperAgentConfig(project, model), { replace: true });
    this.agentModels.set(name, model);
  }

  /**
   * Ensure the scratch agent is registered at `model`, re-registering it only
   * when the model actually changed. Same per-chat-override mechanism as
   * `ensureKeeperModel`, for one-off / scratch chats.
   */
  async ensureScratchModel(model: string): Promise<void> {
    if (!this.fleet) return;
    if (this.agentModels.get(SCRATCH_AGENT) === model) return;
    await this.fleet.addAgent(this.scratchAgentConfig(model), { replace: true });
    this.agentModels.set(SCRATCH_AGENT, model);
  }

  /**
   * Force the FleetManager's session-discovery cache to drop its cached listing
   * for an agent, so a brand-new chat surfaces immediately (rather than waiting
   * out the 30s directory cache). New public API in @herdctl/core 5.12.0. No-op
   * and never throws if the fleet isn't ready.
   */
  invalidateSessions(agentName: string): void {
    if (!this.fleet) return;
    this.fleet.invalidateSessions(agentName);
  }

  /**
   * Unregister a project's keeper + sweeper agents at runtime. Uses
   * `fleet.removeAgent`, the inverse of ensureProjectAgent. Running jobs are
   * unaffected; the scheduler stops triggering the removed agents.
   */
  async removeProjectAgent(slug: string): Promise<void> {
    if (!this.fleet) return;
    await this.fleet.removeAgent(keeperAgentName(slug)).catch(() => undefined);
    await this.fleet.removeAgent(sweeperAgentName(slug)).catch(() => undefined);
  }

  /**
   * Delete a single chat (session) by agent name + session id. The FleetManager
   * resolves the agent's working directory, removes the transcript JSONL, and
   * invalidates the discovery cache so the list reflects it immediately.
   * Validates the sessionId (rejects path traversal). Returns true if a
   * transcript file was removed, false if none existed.
   */
  async deleteSession(agentName: string, sessionId: string): Promise<boolean> {
    return this.manager.deleteSession(agentName, sessionId);
  }

  /**
   * Set (or clear) a chat's custom display name. Writes through the fleet's
   * shared SessionMetadataStore so a subsequent getAgentSessions reflects it
   * immediately. Pass null/empty to clear.
   */
  async renameSession(agentName: string, sessionId: string, name: string | null): Promise<void> {
    await this.manager.setSessionName(agentName, sessionId, name);
  }

  /**
   * Trigger an agent with a prompt and stream output via onMessage.
   * Returns the TriggerResult (carries the final sessionId).
   */
  async chat(agentName: string, opts: ChatTurnOptions): Promise<TriggerResult> {
    return this.manager.trigger(agentName, undefined, {
      prompt: opts.prompt,
      resume: opts.resume,
      triggerType: opts.triggerType ?? "web",
      onMessage: opts.onMessage,
      onJobCreated: opts.onJobCreated,
    });
  }

  /** Cancel a running job (best-effort; used by WS chat:cancel). */
  async cancel(jobId: string): Promise<void> {
    await this.manager.cancelJob(jobId).catch(() => undefined);
  }

  /**
   * Run a project's sweeper (curator) agent with a fresh session and the given
   * prompt. Used OUT OF BAND by SweepService — never from the user-chat path —
   * so a sweep can never enqueue another sweep. resume:null forces a clean
   * session each time (the sweep is stateless).
   *
   * The sweeper is tool-less and returns its result as plain assistant text
   * (the two marked sections SweepService parses), so we accumulate the
   * assistant text deltas via @herdctl/chat's shared translator (same pattern
   * as ws.ts) and return them alongside the TriggerResult.
   */
  async runSweeper(slug: string, prompt: string): Promise<{ result: TriggerResult; text: string }> {
    let text = "";
    const translate = createSDKMessageHandler({
      onText: (chunk) => {
        if (chunk) text += chunk;
      },
    });
    const result = await this.manager.trigger(sweeperAgentName(slug), undefined, {
      prompt,
      resume: null,
      triggerType: "manual",
      onMessage: async (m: SDKMessage) => {
        // core's SDKMessage types `message` as `unknown` (wider) than the
        // translator's structurally-narrower SDKMessage — same runtime object,
        // cast across the package boundary.
        await translate(m as unknown as ChatSDKMessage);
      },
    });
    return { result, text };
  }

  /** Recent sessions for a project's keeper agent, used to build the sweep digest. */
  async recentSessions(project: Project, limit = 10): Promise<DiscoveredSession[]> {
    return this.manager.getAgentSessions(keeperAgentName(project.slug), { limit });
  }

  /** List a project's sessions (chats) via its keeper agent. */
  async listSessions(project: Project): Promise<DiscoveredSession[]> {
    return this.manager.getAgentSessions(keeperAgentName(project.slug));
  }

  /** List one-off / scratch sessions. */
  async listScratchSessions(): Promise<DiscoveredSession[]> {
    return this.manager.getAgentSessions(SCRATCH_AGENT);
  }

  /** The working directory used by one-off / scratch chats. */
  get scratchDir(): string {
    return this.cfg.scratchDir;
  }

  /** Read the parsed messages of a session, by agent name. */
  async sessionMessages(agentName: string, sessionId: string): Promise<ChatMessage[]> {
    return this.manager.getAgentSessionMessages(agentName, sessionId);
  }

  /**
   * Token-usage for a session (most recent context-window fill level), read from
   * the transcript. Lets the UI show "context used" for a chat opened from
   * history — before any new turn streams a fresh usage value.
   */
  async sessionUsage(agentName: string, sessionId: string): Promise<SessionUsage> {
    return this.manager.getAgentSessionUsage(agentName, sessionId);
  }

  // --- agent configs -----------------------------------------------------

  /**
   * The scratch (one-off chats) agent config. Defaults to the keeper default
   * model; a per-chat override may re-register it at a different model via
   * `ensureScratchModel`.
   */
  private scratchAgentConfig(model?: string): Record<string, unknown> & { name: string } {
    return {
      name: SCRATCH_AGENT,
      description: "One-off / scratch chats.",
      working_directory: this.cfg.scratchDir,
      model: model ?? KEEPER_DEFAULT_MODEL,
      system_prompt:
        "You are a Claude Code agent for one-off chats. Be helpful and concise.",
      default_prompt: "How can I help?",
    };
  }

  /**
   * A project's keeper agent config. Inherits the fleet `defaults` (runtime,
   * max_turns, permission_mode, allowed/denied tools) via addAgent's deep-merge;
   * only project-specific fields are set here.
   *
   * Model resolution: `modelOverride` (a per-chat override) wins, else the
   * project's persisted `model`, else the keeper default (Opus).
   */
  private keeperAgentConfig(
    project: Project,
    modelOverride?: string,
  ): Record<string, unknown> & { name: string } {
    return {
      name: keeperAgentName(project.slug),
      description: project.summary || `Keeper agent for project ${project.name}.`,
      working_directory: project.dir,
      model: modelOverride ?? project.model ?? KEEPER_DEFAULT_MODEL,
      system_prompt:
        "You are a Claude Code keeper agent for this project directory. " +
        "Honor any CLAUDE.md present. Keep CHANGELOG.md current. " +
        "Create branches for significant changes; never force-push.",
      default_prompt: "Summarize the current state of this project.",
    };
  }

  /**
   * A project's sweeper (curator) agent config. TOOL-LESS: the sweeper has NO
   * tools (`allowed_tools: []`) — it never reads or writes files. Instead it
   * RETURNS the curated content as plain assistant text in two marked sections;
   * SweepService parses that text and writes OVERVIEW.md / CHANGELOG.md itself.
   *
   * This is cheaper and far more predictable than letting a Haiku agent drive
   * file edits: no tool-loop turns, no partial writes, no permission_mode /
   * denied_tools to reason about (all irrelevant with zero tools).
   */
  private sweeperAgentConfig(project: Project): Record<string, unknown> & { name: string } {
    return {
      name: sweeperAgentName(project.slug),
      description: `Overview/changelog curator (sweeper) for project ${project.name}.`,
      working_directory: project.dir,
      model: SWEEPER_DEFAULT_MODEL,
      // Tool-less: a handful of turns is plenty since there are no tool loops.
      max_turns: 4,
      // NO tools. The sweeper returns text only; SweepService does the writing.
      allowed_tools: [],
      system_prompt:
        "You are a concise project curator. You DO NOT use any tools — you only " +
        "return text. From the recent activity, the current OVERVIEW.md, and the " +
        "recent CHANGELOG.md provided in the user message, produce EXACTLY two " +
        "sections wrapped in these literal markers, and NOTHING else:\n" +
        "\n" +
        "<<<OVERVIEW>>>\n" +
        "<the full markdown OVERVIEW.md, which REPLACES the current one wholesale: " +
        "a synthesized snapshot of the project's CURRENT state for an LLM to read " +
        "at the start of a new chat — what the project is, key decisions/facts, " +
        "open questions, and next steps. No changelog or per-session history here.>\n" +
        "<<<CHANGELOG>>>\n" +
        "<exactly ONE changelog bullet line summarizing this recent activity, with " +
        'NO leading "- " and no date heading — just the bare sentence.>\n' +
        "<<<END>>>\n" +
        "\n" +
        "Be factual and terse. Do not invent details not present in the provided " +
        "activity. Output ONLY the two sections between the markers — no preamble, " +
        "no explanation, no tool use.",
      default_prompt: "Curate OVERVIEW.md and CHANGELOG.md from recent activity.",
    };
  }

  // --- config generation -------------------------------------------------

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
  private async ensureConfigFile(): Promise<void> {
    const configDir = path.dirname(this.cfg.herdctlConfigPath);
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(this.cfg.scratchDir, { recursive: true });

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
        // bounding runaway agents (CLAUDE.md: always set max_turns).
        max_turns: 200,
        // No Docker isolation yet (documented follow-up). The LXC has Docker
        // nesting available, but for the POC we keep keeper agents native with
        // acceptEdits + denied dangerous bash patterns.
        permission_mode: "acceptEdits",
        allowed_tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
        denied_tools: ["Bash(sudo *)", "Bash(rm -rf /)", "Bash(rm -rf /*)", "Bash(chmod 777 *)"],
      },
    };

    const header =
      "# GENERATED by paddock-server. Do NOT hand-edit. Agents are NOT listed\n" +
      "# here — they are registered at runtime via FleetManager.addAgent(). This\n" +
      "# file only carries the fleet identity + the defaults merged into them.\n";
    await fs.writeFile(this.cfg.herdctlConfigPath, header + YAML.stringify(doc), "utf8");
  }
}
