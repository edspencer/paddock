/**
 * Shared context types for the WebSocket chat handler (extracted #403).
 *
 * `makeChatHandler` in ws.ts closes over one `deps` bag plus a few shared inner
 * closures (`startAgentTurn`, `composePreloadedPrompt`, `fireTrigger`, the hub).
 * To split the ~2000-line handler into sibling modules (ws-self-mcp.ts,
 * ws-triggers.ts, ws-turn.ts) those pieces need NAMED types instead of relying on
 * closure scope — this module holds them. It has NO runtime imports from ws.ts, so
 * both ws.ts and its siblings can import from here without an import cycle.
 */
import type { HerdctlService } from "./herdctl.js";
import type { ProjectStore } from "./projects.js";
import type { SweepService } from "./sweep.js";
import type { PaddockConfig } from "./config.js";
import type { DriveMode } from "./models.js";
import type { SessionHub } from "./session-hub.js";
import type { AttachmentStore } from "./attachments.js";
import type { QueuedMessageStore } from "./queued-message.js";
import type { ArchiveStore } from "./archive.js";
import type { ScheduleSessionStore } from "./schedule-session.js";
import type { RunProvenanceStore, TurnOrigin } from "./run-provenance.js";
import type { MessageProvenanceStore, MessageSender } from "./message-provenance.js";
import type { PaddockEventBus } from "./event-bus.js";
import type { TriggerService } from "./triggers.js";
import type { TriggerSessionStore } from "./trigger-session.js";

/**
 * The store/service bag `makeChatHandler` is constructed with. Extracted to a
 * named interface (#403) so the handler's extracted sibling modules can accept it
 * by type instead of closing over it.
 */
export interface ChatHandlerDeps {
  herdctl: HerdctlService;
  projects: ProjectStore;
  attachments: AttachmentStore;
  /** Server config — carries the global keeper drive-mode default (Paddock#111). */
  cfg: PaddockConfig;
  /** Optional: post-turn overview/changelog curation engine (issues #2/#6). */
  sweep?: SweepService;
  /** Per-chat queued message persistence (#197). */
  queuedMessage?: QueuedMessageStore;
  /**
   * Per-chat provenance sidecar (issue #261 / DD-3, DD-6): records how each chat
   * was created (origin human/scheduled/spawned + spawn depth) so #262 can
   * depth-gate spawning and #267 can badge provenance. A1 only carries/persists
   * the marker — nothing gates on it yet.
   */
  runProvenance?: RunProvenanceStore;
  /**
   * Per-MESSAGE provenance sidecar (issue #290): records WHO injected each
   * machine-added turn (send_message / schedule / spawn kickoff) keyed by the
   * TARGET session, so the chat history can attribute injected turns. Optional so
   * existing tests need not supply it; absent ⇒ injected turns just render as
   * unlabelled user bubbles (today's behaviour).
   */
  messageProvenance?: MessageProvenanceStore;
  /**
   * Per-chat archived-flag sidecar (#95). Used by the self-MCP archive_chat /
   * unarchive_chat write tools (#263) so a keeper can file a chat away — most
   * usefully ITSELF, powering the "work → archive myself on success" convention.
   */
  archive: ArchiveStore;
  /**
   * Owned-session sidecar for accreting schedules (issue #265 / DD-2): maps a
   * `resume_session: true` schedule to the one chat it owns, created on its first
   * fire and reused thereafter. Absent ⇒ scheduled chats still work but every
   * accreting schedule would start fresh each fire (degrades to `resume_session:
   * false`); wired in production, optional so existing tests need not supply it.
   */
  scheduleSessions?: ScheduleSessionStore;
  /**
   * In-process lifecycle event bus (Epic T). When present (with {@link triggers}),
   * this handler subscribes to lifecycle events (v1: `onArchive`) and fires each of
   * the project's ENABLED matching EVENT triggers as its own `trigger-<slug>-<name>`
   * agent turn via {@link startAgentTurn}. Absent ⇒ no event-trigger dispatch, so
   * tests that don't exercise triggers need not supply it.
   */
  events?: PaddockEventBus;
  /**
   * Unified trigger registry (Epic T / T1). When present, this handler fires the
   * project's enabled EVENT triggers (via the {@link events} bus) and its SCHEDULE
   * triggers (via herdctl's `setScheduleTriggerHandler`) through the SAME
   * {@link startAgentTurn} core — the single execution engine for every trigger. Absent
   * ⇒ no trigger dispatch, so tests that don't exercise triggers need not supply it.
   */
  triggers?: TriggerService;
  /**
   * Owned-session sidecar for accreting triggers (`run.session: "resume"`, Epic T /
   * T1) — maps a resume-type trigger to the one chat it accretes into across fires,
   * created on its first fire and rebound off this store after a restart. Absent ⇒
   * resume-type triggers degrade to a fresh chat each fire; wired in production,
   * optional so existing tests need not supply it.
   */
  triggerSessions?: TriggerSessionStore;
}

/**
 * Options for the shared per-turn execution engine `startAgentTurn` (ws-turn.ts /
 * ws.ts). Named here so the sibling modules that RECEIVE `startAgentTurn` as a
 * context callback (self-MCP write tools, trigger firing) can type it.
 */
export interface StartAgentTurnOpts {
  projectSlug: string;
  agentName: string;
  workingDir: string;
  resume: string | null;
  prompt: string;
  driveMode: DriveMode;
  fallbackModel: string;
  /**
   * Provenance of this server-initiated turn (issue #261 / DD-3). The self-MCP
   * write tools pass `spawned` + the child's depth. Persisted for a NEW chat
   * only (a resume/message keeps the target chat's existing marker).
   */
  origin: TurnOrigin;
  depth: number;
  /**
   * The effective `maxSpawnDepth` for the chat this turn runs in (issue #262),
   * already resolved by the caller from the TARGET project (per-project override
   * else instance default). Gates whether this turn receives the self-MCP.
   */
  maxSpawnDepth: number;
  /**
   * WHO caused this injected turn (issue #290). Present for a machine injection
   * (another chat `send_message` / a schedule fire / a spawn kickoff); absent for
   * a turn with no attributable non-human sender.
   */
  sender?: MessageSender;
}

/** The shared per-turn execution engine — resolves the chat's sessionId as soon as known. */
export type StartAgentTurn = (opts: StartAgentTurnOpts) => Promise<string>;

/** Resolve a preloaded (OVERVIEW+CHANGELOG) prompt for a new chat (issues #1/#188). */
export type ComposePreloadedPrompt = (projectSlug: string, baseMessage: string) => Promise<string>;

/** Fire a project's named trigger on demand; resolves the started chat's id or null. */
export type FireTrigger = (slug: string, triggerName: string) => Promise<string | null>;

/**
 * The context the self-MCP builder + trigger-firing cluster need: the deps bag,
 * the shared hub, and the shared inner closures. Assembled once in ws.ts and
 * passed to the extracted sibling functions.
 */
export interface ChatHandlerContext {
  deps: ChatHandlerDeps;
  hub: SessionHub;
  startAgentTurn: StartAgentTurn;
  composePreloadedPrompt: ComposePreloadedPrompt;
  fireTrigger: FireTrigger;
}
