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
  type SlashCommand,
  type InjectedMcpServerDef,
  type RuntimeSession,
  type SessionWakeHandler,
  type ResolveInjectedMcpServers,
  type ScheduleTriggerHandler,
  type ScheduleInfo,
  listJobs,
  type JobMetadata,
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import type { PaddockConfig } from "./config.js";
import type { Project } from "./projects.js";
import { KEEPER_DEFAULT_MODEL } from "./models.js";
import { ensureProjectChats, projectChatsDir } from "./transcripts.js";
import {
  triggerRunsOnOwnAgent,
  isCuratorTrigger,
  type PaddockTrigger,
} from "./trigger-config.js";
import {
  buildScratchConfig,
  buildKeeperConfig,
  buildSweeperConfig,
  buildTriggerConfig,
  ensureConfigFile as writeBootConfigFile,
} from "./herdctl-agent-config.js";

/** Options passed through to a streamed trigger. */
export interface ChatTurnOptions {
  prompt: string;
  /** Session to resume; `null` forces a fresh session; omit for agent fallback. */
  resume?: string | null;
  onMessage?: (msg: SDKMessage) => void | Promise<void>;
  onJobCreated?: (jobId: string) => void;
  triggerType?: string;
  /**
   * In-process MCP servers to inject for this turn (issue #112). herdctl's CLI
   * runtime stands up a localhost HTTP bridge per server and auto-allowlists its
   * `mcp__<key>__*` tools, so no change to the static `allowed_tools` is needed.
   */
  injectedMcpServers?: Record<string, InjectedMcpServerDef>;
}

/**
 * The name/visibility helpers + tool/model constants are pure (they only read
 * their arguments, no fleet/cfg/session state), so they live in a sibling module
 * for readability + isolated unit-testing (issue #403). Re-exported here so every
 * external importer keeps resolving them via `./herdctl.js` unchanged.
 */
export {
  keeperAgentName,
  keeperSlugFromAgent,
  SCRATCH_AGENT,
  SWEEPER_PREFIX,
  sweeperAgentName,
  HOOK_AGENT_PREFIX,
  hookAgentName,
  TRIGGER_AGENT_PREFIX,
  triggerAgentName,
  visibleProjectAgentNames,
  BROWSER_MCP_TOOL,
  KEEPER_DENIED_TOOLS,
  browserMcpServers,
  SWEEPER_MODEL,
  SCRATCH_SLUG,
  KEEPER_MAX_CONCURRENT,
  KEEPER_SESSION_TIMEOUT,
} from "./herdctl-agent-names.js";
import {
  keeperAgentName,
  keeperSlugFromAgent,
  SCRATCH_AGENT,
  sweeperAgentName,
  hookAgentName,
  triggerAgentName,
  visibleProjectAgentNames,
} from "./herdctl-agent-names.js";

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

  /**
   * Live session-mode turns keyed by the synthetic turn id we hand back as the
   * `jobId` (Paddock#111). `openChatSession` creates no herdctl job record, so
   * there's no core `jobId` to cancel via `cancelJob`; instead we register the
   * live {@link RuntimeSession} here and Stop → `session.interrupt()` (see
   * {@link cancel}). Entries are removed when the turn's stream ends.
   */
  private liveSessions = new Map<string, RuntimeSession>();

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
      // Per-deployment gate for programmatic schedule mutation (issue #265 / DD-7,
      // herdctl#376). OFF by default: an instance opts in (PADDOCK_SCHEDULE_MUTATION)
      // before herdctl's runtime schedule-mutation APIs can add or remove a
      // schedule at runtime. Declaring schedules in project.yaml is unaffected.
      allowScheduleMutation: this.cfg.scheduleMutationEnabled,
    });
    await this.fleet.initialize();

    // Register the scratch agent (one-off chats) at the keeper default model.
    await fs.mkdir(this.cfg.scratchDir, { recursive: true });
    await ensureProjectChats(this.cfg.scratchDir);
    await this.fleet.addAgent(this.scratchAgentConfig(), { replace: true });
    this.agentModels.set(SCRATCH_AGENT, KEEPER_DEFAULT_MODEL);

    // Register a keeper + sweeper for every existing project, recording each
    // keeper's resolved model so per-chat overrides can short-circuit later.
    // ensureProjectChats relocates this project's transcripts into <dir>/.chats
    // (migrating any existing real transcript dir) so the project is portable.
    for (const project of projects) {
      // Symlink Claude's encoded transcript dir for the keeper's cwd (workingDir)
      // at the .chats store in the metadata dir — so repo-backed transcripts stay
      // out of the external checkout's working tree (issue #187). For a notebook
      // project workingDir === dir, so this is the classic behavior.
      await ensureProjectChats(project.workingDir, project.dir);
      await this.fleet.addAgent(this.keeperAgentConfig(project), { replace: true });
      await this.fleet.addAgent(this.sweeperAgentConfig(project), { replace: true });
      // Register each EVENT trigger as its own agent `trigger-<slug>-<name>` (Epic T /
      // T1). Schedule triggers ride the keeper's forwarded `schedules` block (above);
      // webhook triggers are reserved.
      await this.registerTriggerAgents(project);
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

  /**
   * Is a `claude` SUBPROCESS still alive on this session at the SDK/reaper layer
   * (issue #397)? Consults herdctl's `SessionReaper` via the fleet's session
   * lifecycle manager: `true` while the reaper is keeping a session open for a
   * killed background task (keepAlive) or holding it through its re-invocation
   * grace. Paddock's recovery engine treats this as a busy signal so it never
   * fires a COMPETING resume into a session a prior subprocess still holds live
   * (which the SDK resolves by interrupting the in-flight turn). Null-safe: with
   * no fleet, no session-lifecycle manager (batch mode / reaper disabled), or any
   * error, returns `false` — the pre-#397 behaviour.
   */
  isSdkSessionLive(sessionId: string): boolean {
    try {
      return this.fleet?.getSessionLifecycle()?.reaper.isSessionLive(sessionId) ?? false;
    } catch {
      return false;
    }
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
    await ensureProjectChats(project.workingDir, project.dir);
    await this.fleet.addAgent(this.keeperAgentConfig(project), { replace: true });
    await this.fleet.addAgent(this.sweeperAgentConfig(project), { replace: true });
    // Re-register the project's EVENT-trigger agents (Epic T / T1) from the live
    // record (schedule triggers ride the keeper's forwarded `schedules` block above;
    // webhook triggers are reserved).
    await this.registerTriggerAgents(project);
    // Record the keeper's resolved model so per-chat overrides can detect a
    // no-op. ensureProjectAgent re-registers at project.model (the persisted
    // default), so a model change via PATCH takes effect here too.
    this.agentModels.set(keeperAgentName(project.slug), project.model ?? KEEPER_DEFAULT_MODEL);
  }

  /**
   * Register (or replace) every trigger a project declares that runs on its OWN scoped
   * agent `trigger-<slug>-<name>` (Epic T). Idempotent (`addAgent` replace:true). Which triggers
   * get a scoped agent is decided by {@link triggerRunsOnOwnAgent}: EVENT triggers
   * always; SCHEDULE triggers only when they declare a non-empty `run.tools` allow-list
   * (T2 — an unscoped schedule still rides the keeper's forwarded `schedules` block and
   * runs as the keeper); webhook triggers are reserved (no ingress). A scoped schedule
   * ALSO keeps its keeper `schedules` entry — that is only the cron TIMING; the fired
   * turn executes on this scoped agent. A trigger-less project is a no-op. Called at
   * boot ({@link init}) and on every {@link ensureProjectAgent}.
   */
  async registerTriggerAgents(project: Project): Promise<void> {
    if (!this.fleet) return;
    for (const [name, trigger] of Object.entries(project.triggers ?? {})) {
      // The post-turn CURATOR (event/afterTurn) trigger, T5, never runs as its own
      // agent — SweepService executes it via the project's `sweeper-<slug>` agent.
      // Registering a `trigger-<slug>-<name>` for it would be a dead, never-fired agent.
      if (!triggerRunsOnOwnAgent(trigger) || isCuratorTrigger(trigger)) continue;
      await this.fleet.addAgent(this.triggerAgentConfig(project, name, trigger), { replace: true });
    }
  }

  /**
   * Register (or replace) ONE trigger's scoped agent at runtime (Epic T) — the herdctl
   * half of a trigger mutation (the Paddock half persists it via
   * `ProjectStore.setTrigger`). Idempotent; immediately fireable. Consumed by
   * {@link import("./triggers.js").TriggerService}. A no-op for a trigger that does NOT
   * run on its own agent ({@link triggerRunsOnOwnAgent}) — an unscoped schedule arms via
   * the keeper re-register; a webhook is reserved.
   */
  async ensureTriggerAgent(project: Project, name: string, trigger: PaddockTrigger): Promise<void> {
    if (!this.fleet) return;
    // The curator (event/afterTurn) trigger, T5, is executed by SweepService (via the
    // `sweeper-<slug>` agent), not as its own agent — so never register one for it.
    if (!triggerRunsOnOwnAgent(trigger) || isCuratorTrigger(trigger)) return;
    await this.fleet.addAgent(this.triggerAgentConfig(project, name, trigger), { replace: true });
  }

  /**
   * Unregister one event trigger's agent at runtime (Epic T / T1) — the inverse of
   * {@link ensureTriggerAgent}. Never throws if the agent is already gone.
   */
  async removeTriggerAgent(slug: string, name: string): Promise<void> {
    if (!this.fleet) return;
    await this.fleet.removeAgent(triggerAgentName(slug, name)).catch(() => undefined);
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
   * Unregister a project's keeper + sweeper (+ any event-hook) agents at runtime.
   * Uses `fleet.removeAgent`, the inverse of ensureProjectAgent. Running jobs are
   * unaffected; the scheduler stops triggering the removed agents. `hookNames` are
   * the project's declared hook names (from its DTO) so their `hook-<slug>-<name>`
   * agents are torn down too — caller passes `Object.keys(project.hooks ?? {})`.
   */
  async removeProjectAgent(
    slug: string,
    hookNames: string[] = [],
    triggerNames: string[] = [],
  ): Promise<void> {
    if (!this.fleet) return;
    await this.fleet.removeAgent(keeperAgentName(slug)).catch(() => undefined);
    await this.fleet.removeAgent(sweeperAgentName(slug)).catch(() => undefined);
    for (const name of hookNames) {
      await this.fleet.removeAgent(hookAgentName(slug, name)).catch(() => undefined);
    }
    // Event triggers (Epic T / T1) register their own `trigger-<slug>-<name>` agent —
    // tear those down too; schedule/webhook trigger names contribute no agent, so
    // removeAgent is a harmless no-op for them.
    for (const name of triggerNames) {
      await this.fleet.removeAgent(triggerAgentName(slug, name)).catch(() => undefined);
    }
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
      injectedMcpServers: opts.injectedMcpServers,
    });
  }

  /**
   * Session-mode counterpart to {@link chat} (Paddock#111). Drives the turn
   * through a persistent, herdctl-managed `openChatSession` (`manageLifecycle:
   * true`) instead of a one-shot `trigger()`, so a `ScheduleWakeup` / `/loop` the
   * turn leaves behind is captured by the reaper (herdctl#307) and re-fired
   * through the scheduler — i.e. cross-turn autonomy actually works. The turn
   * itself streams identically (same `onMessage` shape), so callers are unchanged.
   *
   * Contract differences from {@link chat}:
   *  - No herdctl job record exists, so the returned `jobId` is a synthetic turn
   *    id we register in {@link liveSessions}; Stop maps to `session.interrupt()`
   *    via {@link cancel}.
   *  - We do NOT `close()` the session: it's managed, so the reaper tears it down
   *    when idle (and captures its wakeups on the Stop hook). Per the core
   *    contract, the message stream ending IS the reap.
   */
  async chatSession(agentName: string, opts: ChatTurnOptions): Promise<TriggerResult> {
    const startedAt = new Date().toISOString();
    const turnId = randomUUID();
    let session: RuntimeSession;
    try {
      session = await this.manager.openChatSession(agentName, {
        resume: opts.resume,
        prompt: opts.prompt,
        manageLifecycle: true,
        injectedMcpServers: opts.injectedMcpServers,
        // Stream assistant text token-by-token: the SDK emits `stream_event` /
        // `text_delta` chunks that the translator surfaces as incremental
        // `chat:response` frames (edspencer/herdctl#382, paddock#315).
        includePartialMessages: true,
      });
    } catch (err) {
      return {
        jobId: turnId,
        agentName,
        scheduleName: null,
        startedAt,
        prompt: opts.prompt,
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    this.liveSessions.set(turnId, session);
    // Surface the synthetic id as the turn's jobId so the client renders Stop and
    // a subsequent chat:cancel routes back to this live session.
    opts.onJobCreated?.(turnId);

    let sessionId: string | null = typeof opts.resume === "string" ? opts.resume : null;
    let success = false;
    let error: Error | undefined;
    try {
      // Consume the stream until the turn's terminal `result` (same pattern as
      // runCommand). The reaper owns teardown after we return.
      for await (const m of session.messages) {
        if (m.session_id) sessionId = m.session_id;
        if (opts.onMessage) await opts.onMessage(m);
        if (m.type === "result") {
          const errored =
            (typeof m.subtype === "string" && m.subtype.startsWith("error")) ||
            m.success === false;
          success = !errored;
          break;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.liveSessions.delete(turnId);
    }

    return {
      jobId: turnId,
      agentName,
      scheduleName: null,
      startedAt,
      prompt: opts.prompt,
      success,
      sessionId: sessionId ?? undefined,
      error,
    };
  }

  /**
   * Register the consumer that drives scheduler-fired session wakes (Paddock#111
   * gap 3). herdctl resumes the woken session (`manageLifecycle: true`) and hands
   * it here; the handler must consume the stream onto the hub/transcript so the
   * autonomous turn is visible even though no client is watching. A no-op if the
   * fleet has no lifecycle manager. Safe to call before/after {@link init}.
   */
  onSessionWake(handler: SessionWakeHandler | undefined): void {
    this.manager.setSessionWakeHandler(handler);
  }

  /**
   * Register the resolver herdctl calls to RE-ESTABLISH this session's in-process
   * injected MCP servers when a scheduler-fired wake resumes an idle/reaped session
   * (edspencer/herdctl#390, wired in @herdctl/core 5.22.1). The wake path drives the
   * turn inside herdctl (a `ScheduleWakeup` / `/loop` / `CronCreate` re-fire), so it
   * bypasses Paddock's per-turn injection — without this the resumed `claude`
   * subprocess re-spawns with the `mcp__paddock*__*` tools "allowed" but UNBACKED,
   * so they vanish from the catalog for the whole autonomous stretch (the "MCP flap").
   * The resolver is SYNCHRONOUS (herdctl threads its result into `openChatSession`
   * before the subprocess spawns) and MUST NOT throw — herdctl catches + logs a throw
   * and degrades to no-injection, but we return `undefined` (safe no-injection default)
   * rather than rely on that. A no-op if the fleet has no lifecycle manager; safe to
   * call before/after {@link init}. Thin passthrough, mirroring {@link onSessionWake}.
   */
  setResolveInjectedMcpServers(resolve: ResolveInjectedMcpServers | undefined): void {
    this.manager.setResolveInjectedMcpServers(resolve);
  }

  /**
   * Register the consumer that OWNS execution of a fired schedule (issue #265 /
   * DD-1, herdctl#375). When set, herdctl routes every scheduler-fired trigger
   * (interval / cron / forced "trigger now") here instead of running it headless
   * via its built-in ScheduleExecutor — so Paddock runs the turn on its OWN hub /
   * resume path (`startAgentTurn`), keeping the scheduled chat visible + re-attachable
   * (and never `isSidechain`-hidden). A no-op fallback to headless applies if no
   * handler is registered. Thin passthrough, mirroring {@link onSessionWake}.
   */
  onScheduleTrigger(handler: ScheduleTriggerHandler | undefined): void {
    this.manager.setScheduleTriggerHandler(handler);
  }

  /**
   * The runtime state of a project keeper's schedules (issue #266 / D4) — the
   * live `ScheduleInfo` herdctl tracks (status, `lastRunAt`/`nextRunAt`,
   * `lastError`) for the schedules Paddock forwarded into the keeper agent. The
   * D4 UI merges this with the project.yaml declaration (which carries the
   * Paddock-only `prompt`/`promptFile`/`resume_session`) for the list view. A
   * schedule-less keeper (or one herdctl hasn't finished arming) yields `[]`;
   * errors are swallowed to `[]` so the settings pane degrades to the declared
   * definitions rather than failing to render.
   */
  async listAgentSchedules(project: Project): Promise<ScheduleInfo[]> {
    const agent = keeperAgentName(project.slug);
    const all = await this.manager.getSchedules().catch(() => [] as ScheduleInfo[]);
    return all.filter((s) => s.agentName === agent);
  }

  /**
   * Run a slash command (e.g. `/compact`) against an agent's chat session.
   *
   * Unlike {@link chat}, which sends the text as a one-shot prompt via
   * `trigger()`, this drives herdctl's streaming session (`openChatSession`) —
   * the only mode in which the SDK dispatches slash commands and exposes control
   * requests. The command runs against the resumed `sessionId`, so `/compact`
   * compacts the real chat history. SDK messages stream via `onMessage` (same
   * shape as {@link chat}); resolves when the turn completes, then closes the
   * session. Returns the resolved session id.
   */
  async runCommand(
    agentName: string,
    opts: {
      command: string;
      resume?: string | null;
      onMessage?: (msg: SDKMessage) => void | Promise<void>;
    },
  ): Promise<{ sessionId: string | null }> {
    const session = await this.manager.openChatSession(agentName, {
      resume: opts.resume,
      // Stream the command's assistant text token-by-token (paddock#315).
      includePartialMessages: true,
    });
    let sessionId: string | null = typeof opts.resume === "string" ? opts.resume : null;

    // Consume the stream until the turn completes (a `result` message). Set up
    // the consumer BEFORE sending so no early messages are missed.
    const done = (async () => {
      try {
        for await (const m of session.messages) {
          if (m.session_id) sessionId = m.session_id;
          if (opts.onMessage) await opts.onMessage(m);
          if (m.type === "result") break;
        }
      } catch {
        // Stream error — fall through and let the caller surface completion.
      }
    })();

    await session.send(opts.command);
    await done;
    await session.close();
    return { sessionId };
  }

  /**
   * Cancel a running turn (Stop button → WS chat:cancel). Handles BOTH drive
   * modes off the single id the client holds as `jobId`:
   *  - **session mode** — the id is a synthetic turn id in {@link liveSessions};
   *    interrupt the live `RuntimeSession` (there is no herdctl job to cancel).
   *  - **batch mode** — the id is a real herdctl job id; abort it via `cancelJob`
   *    (which kills the CLI subprocess / aborts the SDK query).
   *
   * Returns `true` if something was actually cancelled. Errors are logged rather
   * than silently swallowed (the previous `.catch(() => undefined)` hid every
   * failure, so a broken Stop looked like a no-op).
   */
  async cancel(jobId: string): Promise<boolean> {
    const live = this.liveSessions.get(jobId);
    if (live) {
      try {
        await live.interrupt();
        return true;
      } catch (err) {
        console.warn(`[herdctl] session interrupt failed for ${jobId}:`, err);
        return false;
      }
    }
    try {
      await this.manager.cancelJob(jobId);
      return true;
    } catch (err) {
      // JobNotFoundError is expected if the turn already finished; log others.
      console.warn(`[herdctl] cancelJob failed for ${jobId}:`, err);
      return false;
    }
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

  /**
   * List a project's chats across ALL of its VISIBLE agents (Epic G / G3, GG-5):
   * the keeper PLUS every declared event-hook agent (`hook-<slug>-<name>`), so a
   * hook's chats show up in the sidebar alongside the keeper's. The sweeper is
   * deliberately excluded — it's the `hideChats` case (its curation chats stay
   * hidden, unchanged) — and scratch is a separate global list. See
   * {@link visibleProjectAgentNames}.
   *
   * Sessions are keyed by working directory in core's discovery, and every one of
   * a project's agents shares the project cwd, so `getAgentSessions` attributes each
   * session to the specific agent that owns it (keeper vs. a hook). We query each
   * visible agent and merge — deduping by session id defensively (attribution is
   * per-agent, so overlap shouldn't happen) — then re-sort mtime-descending to
   * restore the interleaved recency order a single listing would have had. Each
   * per-agent query is fault-isolated: a hook whose agent failed to register (or was
   * just removed) yields `[]` instead of failing the whole list.
   *
   * A **hook-less project** (the overwhelmingly common case) has exactly one visible
   * agent — its keeper — so we short-circuit to the single un-merged listing: same
   * one directory scan (and no dedup/sort work) the pre-G3 keeper-only path did, i.e.
   * zero added cost unless the project actually declares hooks. The extra per-hook
   * scans only kick in for a project that has hook chats to show.
   */
  async listSessions(project: Project): Promise<DiscoveredSession[]> {
    const agentNames = visibleProjectAgentNames(project);
    if (agentNames.length === 1) return this.manager.getAgentSessions(agentNames[0]);
    const perAgent = await Promise.all(
      agentNames.map((name) => this.manager.getAgentSessions(name).catch(() => [])),
    );
    const seen = new Set<string>();
    const merged: DiscoveredSession[] = [];
    for (const list of perAgent) {
      for (const s of list) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        merged.push(s);
      }
    }
    // ISO-8601 mtimes sort lexicographically in chronological order → descending.
    merged.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
    return merged;
  }

  /** List one-off / scratch sessions. */
  async listScratchSessions(): Promise<DiscoveredSession[]> {
    return this.manager.getAgentSessions(SCRATCH_AGENT);
  }

  /**
   * Map each chat session id to the ISO timestamp of its most recent COMPLETED
   * turn, read cheaply from herdctl's job-metadata records (NOT by parsing
   * transcripts). In the default batch drive mode every keeper turn runs via
   * `trigger()`, which writes a `job-*.yaml` whose `finished_at` is stamped when
   * the turn finishes and whose `session_id` is filled in on completion — so the
   * latest `finished_at` across a session's records is exactly "the agent last
   * finished a turn." This is the server signal for the unread affordance (#160,
   * reused per-project by #161): unlike the transcript mtime (`DiscoveredSession.
   * mtime`) it does NOT tick on the user's own sends.
   *
   * Records still running (no `finished_at`) or not yet session-resolved (no
   * `session_id`) are skipped. The synthetic adoption records paddock writes
   * carry an earlier, mid-turn `finished_at`, so the max naturally prefers the
   * real completion. Session-mode turns (`openChatSession`) write no job record,
   * so their chats have no server timestamp and rely on the client live event.
   *
   * One `readdir` + per-file parse of the shared jobs dir — the same access
   * pattern as {@link reattributeSession}, far cheaper than a transcript scan.
   */
  async lastTurnCompletedAt(): Promise<Map<string, string>> {
    const jobsDir = path.join(this.cfg.stateDir, "jobs");
    const out = new Map<string, string>();
    let entries: string[];
    try {
      entries = await fs.readdir(jobsDir);
    } catch {
      return out; // no jobs dir yet (fresh instance)
    }
    await Promise.all(
      entries.map(async (name) => {
        if (!name.endsWith(".yaml")) return;
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = YAML.parse(await fs.readFile(path.join(jobsDir, name), "utf8")) as
            | Record<string, unknown>
            | null;
        } catch {
          return; // skip an unreadable/half-written record
        }
        const sid = parsed?.session_id;
        const finished = parsed?.finished_at;
        if (typeof sid !== "string" || typeof finished !== "string") return;
        // ISO-8601 UTC strings sort lexicographically in chronological order.
        const prev = out.get(sid);
        if (!prev || finished > prev) out.set(sid, finished);
      }),
    );
    return out;
  }

  /**
   * Per-project variant of {@link lastTurnCompletedAt} for the sidebar unread
   * badge (#161): group the same cheap job-record scan by the KEEPER agent that
   * owns each session, so the projects-list payload can carry a compact
   * `{ sessionId, lastTurnCompletedAt }` list per project WITHOUT the N+1
   * `listSessions` fan-out or any transcript parse. Returns `slug -> (sessionId
   * -> latest finished_at)`.
   *
   * Only keeper-attributed records (`agent: keeper-<slug>`) are kept — scratch
   * and sweeper records carry their own session ids that are not project chats,
   * so `keeperSlugFromAgent` returning `null` naturally filters them out. A chat
   * promoted from scratch is grouped under its keeper slug (its keeper record).
   */
  async lastTurnCompletedAtByProject(): Promise<Map<string, Map<string, string>>> {
    const jobsDir = path.join(this.cfg.stateDir, "jobs");
    const out = new Map<string, Map<string, string>>();
    let entries: string[];
    try {
      entries = await fs.readdir(jobsDir);
    } catch {
      return out; // no jobs dir yet (fresh instance)
    }
    await Promise.all(
      entries.map(async (name) => {
        if (!name.endsWith(".yaml")) return;
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = YAML.parse(await fs.readFile(path.join(jobsDir, name), "utf8")) as
            | Record<string, unknown>
            | null;
        } catch {
          return; // skip an unreadable/half-written record
        }
        const sid = parsed?.session_id;
        const finished = parsed?.finished_at;
        const agent = parsed?.agent;
        if (typeof sid !== "string" || typeof finished !== "string" || typeof agent !== "string") {
          return;
        }
        const slug = keeperSlugFromAgent(agent);
        if (!slug) return; // only keeper (project) chats — skip scratch/sweeper
        let bySession = out.get(slug);
        if (!bySession) {
          bySession = new Map<string, string>();
          out.set(slug, bySession);
        }
        // ISO-8601 UTC strings sort lexicographically in chronological order.
        const prev = bySession.get(sid);
        if (!prev || finished > prev) bySession.set(sid, finished);
      }),
    );
    return out;
  }

  /**
   * The raw herdctl job records for one project's keeper agent, most-recent
   * first — the data source for the "while you were away" run-history view (E3 /
   * #268 / DD-6). Each `trigger()` (batch drive mode) turn writes one
   * `job-*.yaml` carrying `trigger_type`, `status`, `started_at`/`finished_at`,
   * `duration_seconds`, `session_id`, `schedule` and `forked_from`; this reads
   * them via core's `listJobs` (importable from `@herdctl/core`, sorted by
   * `started_at` descending) filtered to `keeper-<slug>`, so scratch/sweeper
   * records are excluded.
   *
   * The true human/scheduled/spawned provenance is carried by Paddock's
   * {@link RunProvenanceStore} (origin/depth keyed by `session_id`), NOT by
   * `trigger_type` — paddock-initiated turns still write `trigger_type:"manual"`
   * (see ws.ts). The caller joins the two.
   *
   * Caveat (documented at {@link lastTurnCompletedAt}): session-mode turns
   * (`openChatSession`) write NO job record, so runs driven that way don't
   * appear here — only batch `trigger()` turns and paddock's synthetic adoption
   * records do. Cost columns (DD-4) are P3 and not yet on the record.
   */
  async listProjectRuns(project: Project, limit = 100): Promise<JobMetadata[]> {
    const jobsDir = path.join(this.cfg.stateDir, "jobs");
    const agent = keeperAgentName(project.slug);
    const { jobs } = await listJobs(jobsDir, { agent }).catch(() => ({ jobs: [], errors: 0 }));
    return limit > 0 ? jobs.slice(0, limit) : jobs;
  }

  /**
   * Job records for a SET of agents, most-recent first (Epic T follow-up / #327) —
   * the data source for the Triggers tab's per-trigger last-run column. Used to pull
   * one project's keeper AND every scoped `trigger-<slug>-<name>` agent in a single
   * pass so {@link import("./trigger-runtime.js").buildTriggerRuntime} can attribute a
   * scoped trigger's newest run by agent name. `listJobs` has no multi-agent filter,
   * so this scans the jobs dir once (unfiltered) and keeps only the requested agents;
   * order (started_at descending) is preserved. Errors swallow to `[]` so the runtime
   * view degrades to config-only rather than failing to render.
   */
  async listRunsForAgents(agents: string[], limit = 200): Promise<JobMetadata[]> {
    if (agents.length === 0) return [];
    const jobsDir = path.join(this.cfg.stateDir, "jobs");
    const wanted = new Set(agents);
    const { jobs } = await listJobs(jobsDir).catch(() => ({ jobs: [], errors: 0 }));
    const filtered = jobs.filter((j) => wanted.has(j.agent));
    return limit > 0 ? filtered.slice(0, limit) : filtered;
  }

  /** The working directory used by one-off / scratch chats. */
  get scratchDir(): string {
    return this.cfg.scratchDir;
  }

  /**
   * Promote a one-off (scratch) chat into a project: re-home its transcript into
   * the project's `.chats/` (rewriting the embedded `cwd` so resume targets the
   * project dir) and synthesize a herdctl job record attributing the session to
   * the project's keeper agent. After this + the cache invalidations below the
   * chat lists and resumes under the project with NO restart — unlike
   * `scripts/migrate-chat.sh`, which writes the same files from outside the
   * process and therefore needs a restart to drop the attribution-index cache.
   *
   * The caller MUST have already created the project and registered its keeper
   * (ensureProjectAgent), so the project's `.chats/` + transcript symlink exist.
   * Throws if the scratch transcript can't be read (e.g. unknown session id).
   */
  async promoteScratchSession(sessionId: string, project: Project): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      throw new Error(`Invalid session id: ${sessionId}`);
    }
    const fromFile = path.join(projectChatsDir(this.cfg.scratchDir), `${sessionId}.jsonl`);
    const toFile = path.join(projectChatsDir(project.dir), `${sessionId}.jsonl`);

    // Read the scratch transcript (throws ENOENT for an unknown/absent session).
    const raw = await fs.readFile(fromFile, "utf8");
    // Rewrite ONLY the embedded `cwd` token. Claude Code writes compact JSON
    // (`"cwd":"/abs/path"` — no spaces, no escaping for a plain abs path), the
    // same assumption scripts/migrate-chat.sh relies on.
    // Rewrite the embedded cwd to the project's KEEPER cwd. For a repo-backed
    // project that's the nested checkout (workingDir), not the metadata dir, so a
    // promoted scratch chat resumes in the right place (issue #187).
    const rewritten = raw
      .split(`"cwd":"${this.cfg.scratchDir}"`)
      .join(`"cwd":"${project.workingDir}"`);

    await fs.mkdir(projectChatsDir(project.dir), { recursive: true });
    await fs.writeFile(toFile, rewritten, "utf8");

    // Preserve the real last-activity time on the moved file.
    const st = await fs.stat(fromFile).catch(() => null);
    if (st) await fs.utimes(toFile, st.atime, st.mtime).catch(() => undefined);

    // Drop the scratch copy AND evict the scratch agent's in-process tracking of
    // this session. The latter is essential for same-process resume: the scratch
    // agent that CREATED the session still "owns" the session id in herdctl's
    // live session state, so resuming under the keeper without evicting it forks
    // a fresh session instead of continuing (a process restart clears the same
    // state, which is why it "worked after restart"). deleteSession removes the
    // scratch transcript (already moved → no-op on content) and clears that state.
    await this.manager.deleteSession(SCRATCH_AGENT, sessionId).catch(() => undefined);
    await fs.rm(fromFile, { force: true });

    // Re-attribute the session to the keeper, then drop the discovery +
    // attribution caches so the move shows immediately.
    await this.reattributeSession(sessionId, project, st ? st.mtime : new Date());
    this.invalidateSessions(keeperAgentName(project.slug));
    this.invalidateSessions(SCRATCH_AGENT);
  }

  /**
   * Fork a project chat: eagerly duplicate `sourceSessionId`'s transcript into a
   * brand-new session in the SAME project, so the fork exists immediately — a
   * real, resumable chat with the full parent history visible — rather than being
   * materialized only when the user sends a first message. The source is left
   * untouched (this is a copy, not a move).
   *
   * Same mechanics as {@link promoteScratchSession} (copy the JSONL, keep it
   * discoverable + attributed), with two differences: a NEW session id is minted
   * and rewritten onto every transcript line (so the copy is internally
   * consistent with its new filename — Claude Code stamps appended lines with the
   * file's id, and a mismatch is version-fragile), and the source file is kept.
   * `cwd` is unchanged (the fork stays in the same project). Returns the new id.
   */
  /**
   * Whether a chat transcript exists for `sessionId` in `project`. Used by the
   * self-management MCP write tools (#214) to validate a caller-supplied target
   * before forking / messaging it, so a bad id yields a clean "not found" instead
   * of a raw ENOENT (fork) or a false-positive success (send_message). Rejects a
   * malformed id (path-traversal guard) as non-existent.
   */
  async sessionExists(project: Project, sessionId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return false;
    try {
      await fs.access(path.join(projectChatsDir(project.dir), `${sessionId}.jsonl`));
      return true;
    } catch {
      return false;
    }
  }

  async forkSession(project: Project, sourceSessionId: string, name?: string): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(sourceSessionId)) {
      throw new Error(`Invalid session id: ${sourceSessionId}`);
    }
    const dir = projectChatsDir(project.dir);
    // Read the source transcript (throws ENOENT for an unknown/absent session).
    const raw = await fs.readFile(path.join(dir, `${sourceSessionId}.jsonl`), "utf8");

    const newId = randomUUID();
    // Rewrite the embedded session id on every line. Claude Code writes compact
    // JSON (`"sessionId":"<id>"` / `"session_id":"<id>"` — no spaces), the same
    // assumption promoteScratchSession/migrate-chat.sh rely on for `cwd`.
    const rewritten = raw
      .split(`"sessionId":"${sourceSessionId}"`)
      .join(`"sessionId":"${newId}"`)
      .split(`"session_id":"${sourceSessionId}"`)
      .join(`"session_id":"${newId}"`);
    await fs.writeFile(path.join(dir, `${newId}.jsonl`), rewritten, "utf8");

    // Name it (e.g. "Fork of <parent>") and make it discoverable + attributed to
    // the keeper immediately (a fresh transcript with no job records otherwise
    // relies on cwd attribution alone).
    const keeper = keeperAgentName(project.slug);
    if (name) await this.manager.setSessionName(keeper, newId, name).catch(() => undefined);
    await this.writeAdoptionJob(newId, project, new Date());
    this.invalidateSessions(keeper);
    return newId;
  }

  /**
   * Point every herdctl job record for `sessionId` at the project's keeper so
   * the core attribution index (last-write-wins per session) lists the session
   * under the project. A scratch chat writes one job record PER TURN (all
   * `agent: scratch`); simply adding a keeper record alongside them is not
   * enough — whichever record the index visits last wins. So we rewrite the
   * `agent` field of all existing records for the session. When none exist
   * (e.g. a transcript migrated from outside paddock), we synthesize one.
   */
  private async reattributeSession(
    sessionId: string,
    project: Project,
    when: Date,
  ): Promise<void> {
    const jobsDir = path.join(this.cfg.stateDir, "jobs");
    await fs.mkdir(jobsDir, { recursive: true });
    const keeper = keeperAgentName(project.slug);

    let entries: string[] = [];
    try {
      entries = await fs.readdir(jobsDir);
    } catch {
      entries = [];
    }

    let matched = 0;
    for (const name of entries) {
      if (!name.endsWith(".yaml")) continue;
      const file = path.join(jobsDir, name);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> | null;
      } catch {
        continue;
      }
      if (!parsed || parsed.session_id !== sessionId) continue;
      matched++;
      if (parsed.agent === keeper) continue;
      parsed.agent = keeper;
      await fs.writeFile(file, YAML.stringify(parsed), "utf8");
    }

    // No existing job records for the session — synthesize one (migration path).
    if (matched === 0) await this.writeAdoptionJob(sessionId, project, when);
  }

  /**
   * Attribute an *in-flight* session to its agent the moment its id is known —
   * mid first turn — so a brand-new chat lists in the sidebar immediately
   * instead of only after the turn's `claude -p` process exits (issue #100).
   *
   * The core attribution index is built from herdctl job records, and herdctl
   * writes the resolved `session_id` into a run's own job record only on
   * completion. While the first turn runs, that record has `session_id: null`,
   * so the session is unattributed and {@link SessionDiscoveryService.getAgentSessions}
   * filters it out. We close that window with the SAME synthetic-job-record
   * trick used for fork/promote: write an adoption record keyed to the session
   * id, then drop the discovery + attribution caches so the next list call
   * surfaces it. Idempotent — a stable per-session job id means a repeat call
   * just overwrites the same file, and when the real run later finalizes its own
   * record (same session id, same agent) the attribution is unchanged.
   *
   * @param sessionId - The freshly-resolved session id of the running turn
   * @param agentName - The qualified agent the session belongs to (keeper or scratch)
   */
  async attributeRunningSession(sessionId: string, agentName: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return;
    await this.writeAgentAdoptionJob(sessionId, agentName, new Date());
    this.invalidateSessions(agentName);
  }

  /**
   * Write a herdctl job-metadata YAML mapping `sessionId -> keeper agent` so the
   * core attribution index lists the session under the project. Mirrors the
   * shape `scripts/migrate-chat.sh` writes (and the JobMetadataSchema: the id
   * must match `job-YYYY-MM-DD-[a-z0-9]{6}`).
   */
  private async writeAdoptionJob(sessionId: string, project: Project, when: Date): Promise<void> {
    await this.writeAgentAdoptionJob(sessionId, keeperAgentName(project.slug), when);
  }

  /**
   * Underlying adoption-record writer, parametrized by the target agent name so
   * it serves both project keepers (fork/promote/adopt) and the scratch agent
   * (see {@link attributeRunningSession}). Writes a `<jobId>.yaml` mapping the
   * session id to `agentName` plus a matching empty `.jsonl` output file.
   */
  private async writeAgentAdoptionJob(
    sessionId: string,
    agentName: string,
    when: Date,
  ): Promise<void> {
    const jobsDir = path.join(this.cfg.stateDir, "jobs");
    await fs.mkdir(jobsDir, { recursive: true });
    const iso = (Number.isNaN(when.getTime()) ? new Date() : when).toISOString();
    const date = iso.slice(0, 10);
    const jobId = `job-${date}-${sessionId.slice(0, 6).toLowerCase()}`;
    const outputFile = path.join(jobsDir, `${jobId}.jsonl`);
    const record = {
      id: jobId,
      agent: agentName,
      schedule: null,
      trigger_type: "web",
      status: "completed",
      exit_reason: "success",
      session_id: sessionId,
      forked_from: null,
      started_at: iso,
      finished_at: iso,
      duration_seconds: 0,
      output_file: outputFile,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId}.yaml`), YAML.stringify(record), "utf8");
    // herdctl's listJobs tolerates a missing output file, but keep parity with
    // a real job record (and migrate-chat.sh) by touching an empty one.
    await fs.writeFile(outputFile, "", "utf8").catch(() => undefined);
  }

  /** Read the parsed messages of a session, by agent name. */
  async sessionMessages(agentName: string, sessionId: string): Promise<ChatMessage[]> {
    // Injected/synthetic (`isMeta:true`) user lines — a skill's SKILL.md,
    // command output — are dropped by @herdctl/core's parser (>=5.13.2), so a
    // skill body no longer renders as a giant user bubble (issue #31).
    return this.manager.getAgentSessionMessages(agentName, sessionId);
  }

  // Per-session token usage (last-turn context fill AND cumulative totals) is
  // read directly from the transcript in ./usage.ts (readSessionTokenUsage) —
  // paddock owns the `.chats/` layout, and core's SessionUsage only exposes the
  // last-turn fill, so the cumulative extractor supersedes the old
  // sessionUsage/sessionUsageCached wrappers that used to live here (issue #152).

  /**
   * Slash commands available to an agent, memoized per agent name. The set is
   * stable per project (built-ins + the project's `.claude/commands` + any
   * MCP-provided commands) and each underlying `listAgentCommands` call spawns a
   * short-lived `claude` streaming subprocess (open → query → close), so we
   * cache aggressively. The cache is process-lifetime: it fills on first use and
   * only clears on server restart — the same boot-only invalidation the fleet's
   * agent registration already relies on. A concurrent first call is
   * deduplicated by caching the in-flight promise, so a burst of composer fetches
   * spawns exactly one subprocess.
   */
  private commandsCache = new Map<string, Promise<SlashCommand[]>>();

  async listCommands(agentName: string): Promise<SlashCommand[]> {
    const hit = this.commandsCache.get(agentName);
    if (hit) return hit;
    // Cache the promise (not the resolved value) so concurrent callers share one
    // subprocess; drop it on rejection so a transient failure can be retried.
    const pending = this.manager.listAgentCommands(agentName).catch((err) => {
      this.commandsCache.delete(agentName);
      throw err;
    });
    this.commandsCache.set(agentName, pending);
    return pending;
  }

  // --- agent configs -----------------------------------------------------
  //
  // Thin instance wrappers over the pure builders in `./herdctl-agent-config.js`
  // (issue #403): each threads `this.cfg` so the extracted functions stay pure
  // (config in via params, no `this`). The private names are unchanged so the
  // existing unit-test seams (which reach `sweeperAgentConfig`/`ensureConfigFile`
  // via a cast) and internal callers keep working.

  private scratchAgentConfig(model?: string): Record<string, unknown> & { name: string } {
    return buildScratchConfig(this.cfg, model);
  }

  private keeperAgentConfig(
    project: Project,
    modelOverride?: string,
  ): Record<string, unknown> & { name: string } {
    return buildKeeperConfig(this.cfg, project, modelOverride);
  }

  private sweeperAgentConfig(project: Project): Record<string, unknown> & { name: string } {
    return buildSweeperConfig(project);
  }

  private triggerAgentConfig(
    project: Project,
    triggerName: string,
    trigger: PaddockTrigger,
  ): Record<string, unknown> & { name: string } {
    return buildTriggerConfig(this.cfg, project, triggerName, trigger);
  }

  private async ensureConfigFile(): Promise<void> {
    await writeBootConfigFile(this.cfg);
  }
}
