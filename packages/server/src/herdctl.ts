/**
 * HerdctlService — REAL wrapper around @herdctl/core's FleetManager.
 *
 * This module is NOT a stub: it imports and constructs the public
 * @herdctl/core (5.10.1) API. It is the single seam between paddock and
 * herdctl, so that gaps in the public API are isolated here.
 *
 * IMPORTANT FINDINGS (see docs/INTEGRATION.md for the full contract):
 *
 *  - There is NO public method to register an agent at runtime. The
 *    FleetManager loads agents from a herdctl.yaml on disk and exposes
 *    `reload()` to re-read that file. Therefore "new project -> new keeper
 *    agent" is implemented as: write/append a per-project agent yaml, point
 *    the generated herdctl.yaml at it, then call `reload()`. We own the
 *    config dir, so this is safe and reversible (it is regenerated, never
 *    hand-edited).
 *
 *  - Streaming is via `trigger(agent, schedule?, { onMessage, prompt, resume })`.
 *    `onMessage(msg: SDKMessage)` fires per SDK message; the returned
 *    TriggerResult carries the final `sessionId`. New chat = `resume: null`;
 *    resume = `resume: <sessionId>`.
 *
 *  - Sessions/messages are read via SessionDiscoveryService + the JSONL
 *    parser, keyed by the agent's working_directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  FleetManager,
  SessionDiscoveryService,
  type DiscoveredSession,
  type ChatMessage,
  type SDKMessage,
  type TriggerResult,
  type AgentInfo,
  type FleetStatus,
} from "@herdctl/core";
import YAML from "yaml";
import type { PaddockConfig } from "./config.js";
import { claudeHome } from "./config.js";
import type { Project } from "./projects.js";

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
 * generated yaml and runtime lookups always agree.
 */
export function keeperAgentName(slug: string): string {
  return `keeper-${slug}`;
}

/** The agent used for one-off / scratch chats. */
export const SCRATCH_AGENT = "scratch";

export class HerdctlService {
  private fleet: FleetManager | null = null;
  private discovery: SessionDiscoveryService | null = null;
  private started = false;

  constructor(private readonly cfg: PaddockConfig) {}

  /**
   * Construct + initialize the FleetManager against the generated config.
   *
   * We ensure a minimal herdctl.yaml exists first (a fleet with just the
   * scratch agent) so initialize() always has something valid to load.
   */
  async init(projects: Project[]): Promise<void> {
    await this.ensureConfigFile(projects);

    this.fleet = new FleetManager({
      configPath: this.cfg.herdctlConfigPath,
      stateDir: this.cfg.stateDir,
    });
    await this.fleet.initialize();

    this.discovery = new SessionDiscoveryService({
      stateDir: this.cfg.stateDir,
      claudeHomePath: claudeHome(),
    });
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
   * Add (or ensure) a keeper agent for a project and hot-reload the fleet.
   *
   * GAP: the public API has no `addAgent`, so this regenerates the config
   * file and calls `reload()`. Running jobs keep their old config; new
   * triggers use the new agent. See docs/INTEGRATION.md (question b).
   */
  async ensureProjectAgent(project: Project, allProjects: Project[]): Promise<void> {
    await this.ensureConfigFile(allProjects);
    if (this.fleet) {
      await this.fleet.reload();
    }
    // Touch project so TS knows it's intentionally part of the signature.
    void project;
  }

  /**
   * Trigger a keeper agent with a prompt and stream output via onMessage.
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

  /** List a project's sessions (chats). */
  async listSessions(project: Project): Promise<DiscoveredSession[]> {
    if (!this.discovery) throw new Error("HerdctlService not initialized");
    return this.discovery.getAgentSessions(
      keeperAgentName(project.slug),
      project.dir,
      /* dockerEnabled */ false,
    );
  }

  /** List one-off / scratch sessions. */
  async listScratchSessions(): Promise<DiscoveredSession[]> {
    if (!this.discovery) throw new Error("HerdctlService not initialized");
    return this.discovery.getAgentSessions(SCRATCH_AGENT, this.cfg.scratchDir, false);
  }

  /** Read the parsed messages of a session within a working directory. */
  async sessionMessages(workingDirectory: string, sessionId: string): Promise<ChatMessage[]> {
    if (!this.discovery) throw new Error("HerdctlService not initialized");
    return this.discovery.getSessionMessages(workingDirectory, sessionId);
  }

  // --- config generation -------------------------------------------------

  /**
   * Regenerate the herdctl.yaml that the FleetManager loads. One keeper agent
   * per project (working_directory = the project dir) plus a scratch agent for
   * one-off chats. Paddock owns this file; never hand-edit.
   *
   * NOTE (real-API constraint, verified against @herdctl/core 5.10.1): the
   * fleet `agents` array accepts ONLY path references (`{ path, overrides? }`)
   * — you cannot inline an agent definition. So each agent is written to its
   * own yaml file under <configDir>/agents/ and referenced by absolute path.
   * The `fleet` block is strict and accepts only `name`/`description`.
   */
  private async ensureConfigFile(projects: Project[]): Promise<void> {
    const configDir = path.dirname(this.cfg.herdctlConfigPath);
    const agentsDir = path.join(configDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.mkdir(this.cfg.scratchDir, { recursive: true });

    const specs: Array<{ name: string; dir: string; description: string }> = [
      { name: SCRATCH_AGENT, dir: this.cfg.scratchDir, description: "One-off / scratch chats." },
      ...projects.map((p) => ({
        name: keeperAgentName(p.slug),
        dir: p.dir,
        description: p.summary || `Keeper agent for project ${p.name}.`,
      })),
    ];

    // Write one agent yaml file per spec and collect path references.
    const agentRefs: Array<{ path: string }> = [];
    for (const spec of specs) {
      const file = path.join(agentsDir, `${spec.name}.yaml`);
      await fs.writeFile(file, this.renderAgentYaml(spec), "utf8");
      agentRefs.push({ path: file });
    }

    const doc = {
      version: 1,
      fleet: {
        name: "paddock",
        description: "Paddock keeper-agent fleet (generated — do not hand-edit).",
      },
      defaults: {
        runtime: "cli",
        model: "claude-sonnet-4-6",
        max_turns: 60,
        permission_mode: "acceptEdits",
        allowed_tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
        denied_tools: ["Bash(sudo *)", "Bash(rm -rf /)", "Bash(chmod 777 *)"],
      },
      agents: agentRefs,
    };

    const header =
      "# GENERATED by paddock-server. Do NOT hand-edit — regenerated on project\n" +
      "# create/update and reloaded via FleetManager.reload().\n";
    await fs.writeFile(this.cfg.herdctlConfigPath, header + YAML.stringify(doc), "utf8");
  }

  private renderAgentYaml(spec: { name: string; dir: string; description: string }): string {
    const agent = {
      name: spec.name,
      description: spec.description,
      working_directory: spec.dir,
      system_prompt:
        "You are a Claude Code keeper agent for this project directory. " +
        "Honor any CLAUDE.md present. Keep CHANGELOG.md current. " +
        "Create branches for significant changes; never force-push.",
      default_prompt: "Summarize the current state of this project.",
    };
    return "# GENERATED by paddock-server — do not hand-edit.\n" + YAML.stringify(agent);
  }
}
