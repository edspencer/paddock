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
  countPendingAsyncQueueEntries,
  getCliSessionFile,
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
  type JobMetadata,
} from "@herdctl/core";
import { consumeResumedTurn, consumeBackgroundTurns } from "./resume-drain.js";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
import * as jobs from "./herdctl-jobs.js";

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
  /**
   * Gap B (session mode only): a sink for messages that arrive on the session's
   * stream AFTER the primary turn's terminal `result` — i.e. autonomous
   * background-completion re-invocation turns the reaper holds the session open
   * for. When provided, {@link chatSession} keeps consuming the same stream and
   * forwards each subsequent message here so the caller can render it live (see
   * `consumeBackgroundTurns` in ./resume-drain.ts). Omit for no live delivery of
   * background turns (they still persist to the transcript regardless).
   */
  onBackgroundMessage?: (msg: SDKMessage) => void | Promise<void>;
  /**
   * Gap B (session mode only): called once the background stream ENDS (the reaper
   * reaped the session). Lets the caller finalize the single hub turn it rendered
   * background re-invocations onto (emit chat:complete + end the turn) so the
   * streaming indicator clears. Paired with {@link onBackgroundMessage}.
   */
  onBackgroundDone?: () => void | Promise<void>;
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
  SCRATCH_AGENT,
  sweeperAgentName,
  hookAgentName,
  triggerAgentName,
  visibleProjectAgentNames,
} from "./herdctl-agent-names.js";

/**
 * Slice a Claude Code transcript to the PREFIX up to and including the message
 * turn anchored at `cutUuid` (issue #451 — fork/revert from a point). Returns the
 * sliced JSONL, or null if no record carries that uuid.
 *
 * A logical turn spans several JSONL records: one assistant message is written as
 * one record per content block (text, tool_use, …), all sharing one `message.id`
 * but each with its own `uuid`; a tool_use is then answered by a `type:"user"`
 * `tool_result` record. To keep the kept prefix internally consistent (no
 * assistant tool_use left without its result, which would break resume), after
 * the anchor record we greedily absorb (a) further records of the same
 * `message.id` — the anchor message's sibling blocks — and (b) immediately
 * following `type:"user"` tool_result records answering them, stopping at the
 * next genuine new turn. This is exact for plain chat turns (the primary case);
 * for deeply interleaved tool turns the boundary is a safe over-include.
 */
function sliceTranscriptAtUuid(raw: string, cutUuid: string): string | null {
  const lines = raw.split("\n");
  const meta = lines.map((ln) => {
    const t = ln.trim();
    if (!t) return null;
    try {
      const o = JSON.parse(t) as {
        uuid?: string;
        type?: string;
        message?: { id?: string; content?: unknown };
      };
      const content = o.message?.content;
      const hasToolResult =
        Array.isArray(content) &&
        content.some((b) => (b as { type?: string })?.type === "tool_result");
      return {
        uuid: typeof o.uuid === "string" ? o.uuid : undefined,
        type: o.type,
        mid: typeof o.message?.id === "string" ? o.message.id : undefined,
        hasToolResult,
      };
    } catch {
      return null;
    }
  });

  let idx = -1;
  let anchorMid: string | undefined;
  for (let i = 0; i < meta.length; i++) {
    if (meta[i]?.uuid === cutUuid) {
      idx = i;
      anchorMid = meta[i]!.mid;
      break;
    }
  }
  if (idx === -1) return null;

  let end = idx;
  for (let j = idx + 1; j < meta.length; j++) {
    const m = meta[j];
    if (m === null) {
      // Blank line — includable filler; keep scanning.
      end = j;
      continue;
    }
    if (anchorMid && m.mid === anchorMid) {
      end = j; // a sibling content block of the anchor's assistant message
      continue;
    }
    if (m.type === "user" && m.hasToolResult) {
      end = j; // a tool_result answering a kept tool_use
      continue;
    }
    break;
  }

  return lines.slice(0, end + 1).join("\n") + "\n";
}

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
   * Each agent's working directory (the keeper's cwd / scratch dir), recorded at
   * registration. Used to resolve the `claude` CLI transcript for a resume so we
   * can measure its pending async-input-queue depth (the resume self-interrupt
   * fix's residue gate — see {@link residueDepthFor} + `./resume-drain.ts`).
   */
  private agentWorkingDirs = new Map<string, string>();

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
    this.agentWorkingDirs.set(SCRATCH_AGENT, this.cfg.scratchDir);

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
      this.agentWorkingDirs.set(keeperAgentName(project.slug), project.workingDir);
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
    this.agentWorkingDirs.set(keeperAgentName(project.slug), project.workingDir);
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
   * Pending async-input-queue depth of a resumed session's `claude` transcript —
   * the residue gate for the resume self-interrupt drain (see `./resume-drain.ts`
   * and {@link drainBacklogThenConsume}). Resolves the agent's CLI transcript from
   * its recorded working directory. Returns 0 (→ no drain, original fast path) for
   * an unknown agent or any read error, so a detection failure never changes turn
   * behavior. Public so the ws.ts wake consumer can gate on it too.
   */
  async residueDepthFor(agentName: string, sessionId: string): Promise<number> {
    const workingDir = this.agentWorkingDirs.get(agentName);
    if (!workingDir) return 0;
    try {
      return await countPendingAsyncQueueEntries(getCliSessionFile(workingDir, sessionId));
    } catch {
      return 0;
    }
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
    const isResume = typeof opts.resume === "string";

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

    let sessionId: string | null = isResume ? (opts.resume as string) : null;
    let success = false;
    let error: Error | undefined;
    try {
      // Gap A — survival parity. BOTH fresh and resume now consume via the
      // NON-CLOSING consumeResumedTurn, which drives the stream with a manual
      // iterator and stops on the primary turn's terminal `result` WITHOUT calling
      // iterator.return() — leaving teardown to the reaper ("managed" session).
      // The fresh path used to use `for await … break`, and a `break` invokes the
      // iterator's `.return()`, which tears down the `claude` subprocess — killing
      // any background task the fresh FIRST turn launched, bypassing the reaper's
      // keepAlive (decideReap keeps a session alive while it holds background work).
      // On a fresh session the async-input queue is empty, so residueProbe returns
      // 0 and this breaks right after the first result exactly like the old fast
      // path — just without the close, so a fresh-turn bg task now SURVIVES. A
      // resume additionally drains any stale async-input backlog first (the #427
      // resume self-interrupt fix). The reaper owns teardown after we return.
      const consumed = await consumeResumedTurn(session, {
        residueProbe: () => this.residueDepthFor(agentName, sessionId ?? opts.resume ?? ""),
        onMessage: opts.onMessage,
        onSessionId: (id) => {
          sessionId = id;
        },
        log: (msg) =>
          // eslint-disable-next-line no-console
          console.log(`[resume-drain] chatSession ${agentName} (${sessionId ?? opts.resume}): ${msg}`),
      });
      success = consumed.success;
      if (consumed.sessionId) sessionId = consumed.sessionId;
      // Gap B — keep delivering autonomous background-completion turns. The reaper
      // may hold this (managed) session open because the turn launched continuous
      // background work; when a task completes, its re-invocation turn arrives
      // LATER on this SAME stream. Detach a consumer over the handed-back iterator
      // so those turns reach the live UI (via onBackgroundMessage) instead of only
      // landing in the transcript — and so the stream keeps advancing, feeding the
      // reaper its `activity`/`background_tasks_changed` signals. Detached (`void`)
      // so THIS call still returns the moment the primary turn is done; it ends
      // itself when the reaper reaps the idle session (stream yields `done`).
      if (opts.onBackgroundMessage) {
        void consumeBackgroundTurns(
          consumed.iterator,
          consumed.pending,
          opts.onBackgroundMessage,
          opts.onBackgroundDone,
        );
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
    const isResume = typeof opts.resume === "string";
    const session = await this.manager.openChatSession(agentName, {
      resume: opts.resume,
      // Stream the command's assistant text token-by-token (paddock#315).
      includePartialMessages: true,
    });
    let sessionId: string | null = isResume ? (opts.resume as string) : null;

    try {
      // Gap A parity: BOTH branches consume via the non-closing consumeResumedTurn
      // (no `for await … break`, whose break would iterator.return() and close the
      // CLI mid-consume). Send the command first — it queues behind any stale
      // async-input backlog the CLI replays — then consume with the queue-drain
      // break rule so a backlog turn's `result` can't tear the command turn down.
      // No backlog (the fresh case) → breaks right after the first result. NOTE:
      // unlike chatSession, runCommand opens WITHOUT manageLifecycle, so the reaper
      // does NOT own this session; we still close() it explicitly in `finally`, so
      // a slash-command turn's teardown is unchanged — this only unifies HOW we
      // stop consuming.
      await session.send(opts.command);
      const consumed = await consumeResumedTurn(session, {
        residueProbe: () => this.residueDepthFor(agentName, sessionId ?? opts.resume ?? ""),
        onMessage: opts.onMessage,
        onSessionId: (id) => {
          sessionId = id;
        },
        log: (msg) =>
          // eslint-disable-next-line no-console
          console.log(`[resume-drain] runCommand ${agentName} (${sessionId ?? opts.resume}): ${msg}`),
      });
      if (consumed.sessionId) sessionId = consumed.sessionId;
    } catch {
      // Stream error — fall through and let the caller surface completion.
    } finally {
      await session.close();
    }
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
   * The on-disk job-record reads (run history + the unread badge) live in
   * `./herdctl-jobs.js` as pure functions over `<stateDir>/jobs` (issue #403);
   * these thin wrappers thread `this.cfg.stateDir`. See there for the full
   * semantics of each (unread signal, per-project grouping, run history).
   */
  async lastTurnCompletedAt(): Promise<Map<string, string>> {
    return jobs.lastTurnCompletedAt(this.cfg.stateDir);
  }

  async lastTurnCompletedAtByProject(): Promise<Map<string, Map<string, string>>> {
    return jobs.lastTurnCompletedAtByProject(this.cfg.stateDir);
  }

  async listProjectRuns(project: Project, limit = 100): Promise<JobMetadata[]> {
    return jobs.listProjectRuns(this.cfg.stateDir, project, limit);
  }

  async listRunsForAgents(agents: string[], limit = 200): Promise<JobMetadata[]> {
    return jobs.listRunsForAgents(this.cfg.stateDir, agents, limit);
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
    await jobs.reattributeSession(this.cfg.stateDir, sessionId, project, st ? st.mtime : new Date());
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

  async forkSession(
    project: Project,
    sourceSessionId: string,
    name?: string,
    fromUuid?: string,
  ): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(sourceSessionId)) {
      throw new Error(`Invalid session id: ${sourceSessionId}`);
    }
    const dir = projectChatsDir(project.dir);
    // Read the source transcript (throws ENOENT for an unknown/absent session).
    let raw = await fs.readFile(path.join(dir, `${sourceSessionId}.jsonl`), "utf8");

    // Fork-from-here (issue #451): when a message uuid is given, copy only the
    // transcript PREFIX up to and including that message's turn, so the new chat
    // branches at the chosen point instead of inheriting the whole history. The
    // tail (later turns) is left out of the copy; the source is untouched.
    if (fromUuid) {
      const sliced = sliceTranscriptAtUuid(raw, fromUuid);
      if (sliced == null) {
        throw new Error(`Message ${fromUuid} not found in session ${sourceSessionId}`);
      }
      raw = sliced;
    }

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
    await jobs.writeAdoptionJob(this.cfg.stateDir, newId, project, new Date());
    this.invalidateSessions(keeper);
    return newId;
  }

  /**
   * Revert a chat back to an earlier message (issue #451): truncate the session's
   * transcript at `toUuid`, in place, keeping the SAME session id — so the chat's
   * identity/URL is preserved and the next turn continues as if the later
   * messages never happened. The dropped tail is backed up (recoverable) to a
   * `.reverts/` sidecar that is deliberately kept out of the discoverable
   * `<id>.jsonl` namespace so it never lists as a chat.
   *
   * NOTE: this rolls back the CONVERSATION only — real-world side-effects of the
   * reverted turns (files written, PRs opened, messages sent) are NOT undone. The
   * caller's UI is responsible for warning about that. Returns the number of
   * transcript records dropped.
   */
  async revertSession(
    project: Project,
    sessionId: string,
    toUuid: string,
  ): Promise<{ removed: number }> {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      throw new Error(`Invalid session id: ${sessionId}`);
    }
    const dir = projectChatsDir(project.dir);
    const file = path.join(dir, `${sessionId}.jsonl`);
    const raw = await fs.readFile(file, "utf8");
    const sliced = sliceTranscriptAtUuid(raw, toUuid);
    if (sliced == null) {
      throw new Error(`Message ${toUuid} not found in session ${sessionId}`);
    }
    const countLines = (s: string) => s.split("\n").filter((l) => l.trim()).length;
    const removed = countLines(raw) - countLines(sliced);
    // Back up the full transcript before truncating (recoverable revert). The
    // `.reverts/` dir is not the `<id>.jsonl` session namespace, so it is never
    // discovered/listed as a chat.
    const backupsDir = path.join(dir, ".reverts");
    await fs.mkdir(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs
      .copyFile(file, path.join(backupsDir, `${sessionId}-${stamp}.jsonl`))
      .catch(() => undefined);
    await fs.writeFile(file, sliced, "utf8");
    // The truncated file's shrunk mtime invalidates the usage/context mtime
    // caches automatically; drop the discovery cache so the shorter transcript
    // (new preview/last-turn) lists immediately.
    this.invalidateSessions(keeperAgentName(project.slug));
    return { removed };
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
    await jobs.writeAgentAdoptionJob(this.cfg.stateDir, sessionId, agentName, new Date());
    this.invalidateSessions(agentName);
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
