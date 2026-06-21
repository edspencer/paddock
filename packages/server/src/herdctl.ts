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
// Deep import: the CLI session-path helpers are public + documented but not
// surfaced through the package barrel (no `exports` map gates this). They
// compute the exact `~/.claude/projects/<encoded-cwd>/<id>.jsonl` path the
// SessionDiscoveryService reads from, and getCliSessionFile validates the
// session id (rejects path traversal). This is the clean public way to locate
// — and thus delete — a single CLI session transcript.
import { getCliSessionFile } from "@herdctl/core/dist/runner/runtime/cli-session-path.js";
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

/**
 * The dedicated lightweight curator agent used by the post-turn sweep. Runs on
 * a cheap model (Haiku 4.5) with only read/write tools, no Bash. Registered
 * once (like keepers). Its working_directory is set PER TRIGGER to the project
 * being swept (via TriggerOptions has no cwd override, so the sweeper agent's
 * cwd must be the project dir at trigger time) — see SweepService.
 *
 * NOTE: herdctl agents bind working_directory in their yaml. Because a single
 * shared sweeper can only have one cwd, the SweepService instead registers ONE
 * sweeper agent PER PROJECT (keeper-style) so each has the right cwd. The name
 * is derived from the slug; the agent reads/writes that project's files.
 */
export const SWEEPER_PREFIX = "sweeper-";

/** Maps a project slug to its sweeper agent name. */
export function sweeperAgentName(slug: string): string {
  return `${SWEEPER_PREFIX}${slug}`;
}

/** The model used by the sweeper agent (cheap curation/summarization). */
export const SWEEPER_MODEL = "claude-haiku-4-5-20251001";

/**
 * The slug clients use to address one-off chats over WS/REST. Routed to the
 * scratch agent (working_directory = the scratch dir), not a real project.
 */
export const SCRATCH_SLUG = "scratch";

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
   * Remove a project's keeper agent and hot-reload the fleet.
   *
   * The inverse of ensureProjectAgent: regenerate the config from the surviving
   * projects (which no longer include the deleted one) and call `reload()`.
   * FleetManager.reload() computes added/removed agents and updates the
   * scheduler, so the dropped keeper is cleanly unregistered. Also deletes the
   * now-orphaned per-agent yaml file so the config dir stays tidy.
   *
   * GAP (same as ensureProjectAgent): the public API has no `removeAgent`, so
   * this uses the regenerate-config + reload path. See docs/INTEGRATION.md.
   */
  async removeProjectAgent(slug: string, survivingProjects: Project[]): Promise<void> {
    // Regenerate herdctl.yaml from the survivors (the deleted project is gone).
    await this.ensureConfigFile(survivingProjects);
    // Drop the orphaned per-agent yaml files (ensureConfigFile only writes the
    // survivors; it does not delete stale agent files). Both the keeper and the
    // sweeper for this project are now orphaned.
    const agentsDir = path.join(path.dirname(this.cfg.herdctlConfigPath), "agents");
    await fs
      .rm(path.join(agentsDir, `${keeperAgentName(slug)}.yaml`), { force: true })
      .catch(() => undefined);
    await fs
      .rm(path.join(agentsDir, `${sweeperAgentName(slug)}.yaml`), { force: true })
      .catch(() => undefined);
    if (this.fleet) {
      await this.fleet.reload();
    }
  }

  /**
   * Delete a single chat (session) by removing its CLI transcript JSONL, then
   * invalidate the discovery cache so the list reflects it immediately.
   *
   * Returns true if a transcript file was removed, false if none existed.
   * `getCliSessionFile` validates the session id (throws on traversal), so the
   * sessionId is safe to use in the path.
   */
  async deleteSession(workingDirectory: string, sessionId: string): Promise<boolean> {
    const file = getCliSessionFile(workingDirectory, sessionId);
    let removed = false;
    try {
      await fs.unlink(file);
      removed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.discovery?.invalidateAttributionCache(workingDirectory);
    return removed;
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

  /** Cancel a running job (best-effort; used by WS chat:cancel). */
  async cancel(jobId: string): Promise<void> {
    await this.manager.cancelJob(jobId).catch(() => undefined);
  }

  /**
   * Run a project's sweeper (curator) agent with a fresh session and the given
   * prompt. Used OUT OF BAND by SweepService — never from the user-chat path —
   * so a sweep can never enqueue another sweep. resume:null forces a clean
   * session each time (the sweep is stateless: it reads the project files +
   * provided digest and rewrites OVERVIEW.md / appends to CHANGELOG.md).
   */
  async runSweeper(slug: string, prompt: string): Promise<TriggerResult> {
    return this.manager.trigger(sweeperAgentName(slug), undefined, {
      prompt,
      resume: null,
      triggerType: "manual",
    });
  }

  /** Recent sessions for a project, used to build the sweep digest. */
  async recentSessions(project: Project, limit = 10): Promise<DiscoveredSession[]> {
    if (!this.discovery) throw new Error("HerdctlService not initialized");
    return this.discovery.getAgentSessions(keeperAgentName(project.slug), project.dir, false, {
      limit,
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

  /** The working directory used by one-off / scratch chats. */
  get scratchDir(): string {
    return this.cfg.scratchDir;
  }

  /** Invalidate session caches for a working dir (call after a new chat). */
  invalidateSessions(workingDirectory: string): void {
    this.discovery?.invalidateAttributionCache(workingDirectory);
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

    // Write one keeper/scratch agent yaml file per spec.
    const agentRefs: Array<{ path: string }> = [];
    for (const spec of specs) {
      const file = path.join(agentsDir, `${spec.name}.yaml`);
      await fs.writeFile(file, this.renderAgentYaml(spec), "utf8");
      agentRefs.push({ path: file });
    }

    // Plus one lightweight sweeper agent per project (curates OVERVIEW.md +
    // CHANGELOG.md after each turn). Cheap model, Read/Write/Glob/Grep only,
    // no Bash. working_directory = the project dir so it edits that project's
    // files. Triggered out-of-band by SweepService (never via the user-chat
    // path), so a sweep can't enqueue another sweep.
    for (const p of projects) {
      const name = sweeperAgentName(p.slug);
      const file = path.join(agentsDir, `${name}.yaml`);
      await fs.writeFile(
        file,
        this.renderSweeperYaml({ name, dir: p.dir, projectName: p.name }),
        "utf8",
      );
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
        // ~200 turns: enough for real multi-step coding sessions while still
        // bounding runaway agents (CLAUDE.md: always set max_turns).
        max_turns: 200,
        // No Docker isolation yet (documented follow-up). The LXC has Docker
        // nesting available, but for the POC we keep keeper agents native with
        // acceptEdits + denied dangerous bash patterns.
        permission_mode: "acceptEdits",
        allowed_tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
        denied_tools: [
          "Bash(sudo *)",
          "Bash(rm -rf /)",
          "Bash(rm -rf /*)",
          "Bash(chmod 777 *)",
        ],
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

  /**
   * Render the per-project sweeper (curator) agent yaml. Lightweight: a cheap
   * model, restricted to read/write/search tools (NO Bash — it only edits
   * OVERVIEW.md / CHANGELOG.md). acceptEdits so it can write without prompts.
   * Bounded with a small max_turns. Override the fleet defaults explicitly.
   */
  private renderSweeperYaml(spec: { name: string; dir: string; projectName: string }): string {
    const agent = {
      name: spec.name,
      description: `Overview/changelog curator (sweeper) for project ${spec.projectName}.`,
      working_directory: spec.dir,
      model: SWEEPER_MODEL,
      max_turns: 20,
      permission_mode: "acceptEdits",
      allowed_tools: ["Read", "Write", "Glob", "Grep"],
      // Defaults include Bash/Edit/WebFetch/etc.; the sweeper must not have them.
      denied_tools: ["Bash", "Edit", "WebFetch", "WebSearch"],
      system_prompt:
        "You are a concise project curator. You maintain two files in this " +
        "project directory:\n" +
        "- OVERVIEW.md: a synthesized snapshot of the project's CURRENT state, " +
        "written for an LLM to read at the start of a new chat. You REPLACE it " +
        "in full each time.\n" +
        "- CHANGELOG.md: an append-only, reverse-chronological narrative. You " +
        "APPEND one dated bullet per sweep; never rewrite existing entries.\n" +
        "Be factual and terse. Do not invent details not present in the " +
        "provided activity. Use only the Read/Write/Glob/Grep tools.",
      default_prompt: "Curate OVERVIEW.md and CHANGELOG.md from recent activity.",
    };
    return "# GENERATED by paddock-server — do not hand-edit.\n" + YAML.stringify(agent);
  }
}
