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
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { ensureProjectChats, projectChatsDir } from "./transcripts.js";

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
 * Maps a project slug to its keeper agent name. Kept deterministic so the
 * runtime registration and runtime lookups always agree.
 */
export function keeperAgentName(slug: string): string {
  return `keeper-${slug}`;
}

/**
 * Inverse of {@link keeperAgentName}: recover a project slug from a keeper agent
 * name (`keeper-<slug>` → `<slug>`). Returns `null` for a non-keeper agent (e.g.
 * scratch or a sweeper), so a scheduler-fired wake can route back to the right
 * project or fall through to scratch (Paddock#111).
 */
export function keeperSlugFromAgent(agentName: string): string | null {
  return agentName.startsWith("keeper-") ? agentName.slice("keeper-".length) : null;
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
 * The Claude Code tool pattern for the Playwright browser MCP. Must live on the
 * agent allowlist (the CLI runtime auto-denies any tool not on `--allowedTools`,
 * same reason `Skill` is listed) — so it is added to `defaults.allowed_tools`,
 * which the keeper + scratch agents inherit and the tool-less sweeper overrides
 * away. Harmless when the server isn't enabled: an allowed-but-absent tool is a
 * no-op.
 */
export const BROWSER_MCP_TOOL = "mcp__playwright__*";

/**
 * The Playwright browser MCP server given to the keeper + scratch agents so
 * Claude Code can drive a headless Chromium (navigate / click / fill / snapshot
 * / screenshot). Returns `undefined` unless `PADDOCK_BROWSER_MCP=1` is set in
 * the instance env, so a box WITHOUT the browser stack simply omits the server
 * (no failed spawns) and enabling it is a per-box env flip — no code change.
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
export function browserMcpServers(): Record<string, unknown> | undefined {
  if (process.env.PADDOCK_BROWSER_MCP !== "1") return undefined;
  return {
    playwright: {
      command: "playwright-mcp",
      args: ["--headless", "--no-sandbox", "--isolated", "--browser", "chromium"],
    },
  };
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
const KEEPER_MAX_CONCURRENT = 10;

/**
 * How long herdctl keeps a keeper's fallback session alive (Paddock#111). Sized
 * to the reaper's 7-day recurring-wake expiry so a fallback resume still finds
 * the session; explicit-id resume (Paddock's norm) bypasses this anyway.
 */
const KEEPER_SESSION_TIMEOUT = "168h";

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
      await ensureProjectChats(project.dir);
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
    await ensureProjectChats(project.dir);
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
    const session = await this.manager.openChatSession(agentName, { resume: opts.resume });
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

  /** List a project's sessions (chats) via its keeper agent. */
  async listSessions(project: Project): Promise<DiscoveredSession[]> {
    return this.manager.getAgentSessions(keeperAgentName(project.slug));
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
    const rewritten = raw
      .split(`"cwd":"${this.cfg.scratchDir}"`)
      .join(`"cwd":"${project.dir}"`);

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

  /**
   * The scratch (one-off chats) agent config. Defaults to the keeper default
   * model; a per-chat override may re-register it at a different model via
   * `ensureScratchModel`.
   */
  private scratchAgentConfig(model?: string): Record<string, unknown> & { name: string } {
    const config: Record<string, unknown> & { name: string } = {
      name: SCRATCH_AGENT,
      description: "One-off / scratch chats.",
      working_directory: this.cfg.scratchDir,
      // Explicit CLI runtime (Max plan). The fleet `defaults.runtime` is dropped
      // by @herdctl/core's config loader (runtime isn't a fleet-defaults field in
      // 5.13.x), so without this the runner falls back to the SDK runtime. Set it
      // per-agent to guarantee the Max/CLI path.
      runtime: "cli",
      model: model ?? KEEPER_DEFAULT_MODEL,
      system_prompt:
        "You are a Claude Code agent for one-off chats. Be helpful and concise.",
      default_prompt: "How can I help?",
    };
    // Browser MCP (headless Chromium) when enabled for this box; `mcp__playwright__*`
    // is already on the inherited defaults.allowed_tools.
    const browser = browserMcpServers();
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
   * System prompt: on a dev-servers instance (PADDOCK_DEV_SERVERS_ENABLED — the
   * projects instance) we deliberately set NO `system_prompt`. herdctl's CLI
   * runtime then passes no `--system-prompt`, so Claude Code's full default
   * coding prompt applies together with the project's CLAUDE.md hierarchy — the
   * box's root CLAUDE.md (`/var/lib/paddock/projects/CLAUDE.md`, auto-loaded via
   * the cwd walk-up) carries the keeper guidance plus the `pm` dev-server
   * capability. Every other instance (house/homelab) keeps the terse replace
   * prompt below, so their behavior is unchanged.
   */
  private keeperAgentConfig(
    project: Project,
    modelOverride?: string,
  ): Record<string, unknown> & { name: string } {
    const config: Record<string, unknown> & { name: string } = {
      name: keeperAgentName(project.slug),
      description: project.summary || `Keeper agent for project ${project.name}.`,
      working_directory: project.dir,
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
    // Only non-dev-servers instances get a replace system_prompt; the projects
    // instance omits it so the default coding prompt + CLAUDE.md hierarchy apply.
    if (!this.cfg.devServers.enabled) {
      config.system_prompt =
        "You are a Claude Code keeper agent for this project directory. " +
        "Honor any CLAUDE.md present. Keep CHANGELOG.md current. " +
        "Create branches for significant changes; never force-push.";
    }
    // Browser MCP (headless Chromium) when enabled for this box; `mcp__playwright__*`
    // is already on the inherited defaults.allowed_tools.
    const browser = browserMcpServers();
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
  private sweeperAgentConfig(project: Project): Record<string, unknown> & { name: string } {
    return {
      name: sweeperAgentName(project.slug),
      description: `Overview/changelog curator (sweeper) for project ${project.name}.`,
      working_directory: project.dir,
      // Explicit CLI runtime (Max plan) — see the scratch agent note.
      runtime: "cli",
      model: SWEEPER_DEFAULT_MODEL,
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
