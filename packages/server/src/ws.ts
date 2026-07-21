/**
 * WebSocket chat transport.
 *
 * Protocol (the contract the frontend agent matches):
 *
 *   client -> server:
 *     { type: "chat:send", payload: {
 *         projectSlug: string,        // project slug, or "scratch" for one-off
 *         sessionId: string | null,   // resume an existing chat, or null = new
 *         message: string,
 *         preloadContext?: boolean,   // new chat: prepend the project OVERVIEW.md
 *         model?: string,             // per-chat model override (a known model id)
 *     } }
 *     { type: "chat:cancel", payload: { jobId } }   // optional: stop a running turn
 *     { type: "ping" }
 *
 *   server -> client (all carry projectSlug + sessionId + jobId for routing):
 *     { type: "chat:response",         payload: { projectSlug, sessionId, jobId, chunk } }
 *     { type: "chat:tool_call",        payload: { projectSlug, sessionId, jobId,
 *                                                  toolName, inputSummary, output,
 *                                                  isError, durationMs } }
 *     { type: "chat:message_boundary", payload: { projectSlug, sessionId, jobId } }
 *     { type: "chat:complete",         payload: { projectSlug, sessionId, jobId, success, error?,
 *                                                  model?, usage? } }
 *         // model: the model the turn ran on (lastModel ?? effectiveModel).
 *         // usage: { inputTokens, outputTokens, cacheReadTokens,
 *         //          cacheCreationTokens, contextTokens, contextLimit } — the
 *         //          LAST per-turn usage observed; omitted (with model) if none.
 *         //          contextTokens = input + cacheRead + cacheCreation;
 *         //          contextLimit  = getContextLimit(model). Stale-by-one-turn
 *         //          by design (it reflects the just-completed turn's input).
 *     { type: "chat:injected",         payload: { projectSlug, sessionId, jobId,
 *                                                  sender, content, timestamp } }
 *         // A machine-injected user turn (issue #290 Part 2): another chat
 *         // send_message'd / a schedule fired into this session. Emitted so a
 *         // client already viewing the recipient chat renders the injected user
 *         // bubble LIVE (with its sender attribution) instead of only seeing the
 *         // assistant reply and needing a refresh. `sender` is the MessageSender.
 *     { type: "chat:error",            payload: { projectSlug, error } }
 *     { type: "pong" }
 *
 * Streaming is wired for real via HerdctlService.chat()'s onMessage callback
 * (the public trigger API supports it). The SDKMessage -> chat-event translation
 * (assistant text deltas, message boundaries, and paired tool_use -> tool_result
 * calls enriched with input summaries + wall-clock durations) is done by
 * @herdctl/chat's `createSDKMessageHandler` — the shared, transport-agnostic
 * translator every herdctl chat surface uses — so paddock no longer reimplements
 * it (and as of @herdctl/chat@0.4.1 it pairs CLI tool results correctly, so the
 * prior `normalizeForTranslator` shim is gone). We compose it with a tiny wrapper
 * that also captures, from each raw SDK message, the session id and the per-turn
 * usage + model (the translator only exposes text/boundary/tool events).
 *
 * Field-name note: legacy clients may send `target` instead of `projectSlug`;
 * we accept both. Server events always carry both `projectSlug` and the legacy
 * `target` alias so existing/early frontends keep working.
 */
import { promises as fs } from "node:fs";
import type { WebSocket } from "@fastify/websocket";
import type {
  SDKMessage,
  RuntimeSession,
  SessionWakeEntry,
  InjectedMcpServerDef,
  TriggerInfo,
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import type { HerdctlService } from "./herdctl.js";
import {
  keeperAgentName,
  keeperSlugFromAgent,
  hookAgentName,
  triggerAgentName,
  SCRATCH_AGENT,
  SCRATCH_SLUG,
} from "./herdctl.js";
import type { Project, ProjectStore } from "./projects.js";
import type { SweepService } from "./sweep.js";
import type { PaddockConfig } from "./config.js";
import {
  isKnownModel,
  getContextLimit,
  KEEPER_DEFAULT_MODEL,
  isKnownDriveMode,
  type DriveMode,
} from "./models.js";
import { SessionHub, type TurnHandle, type ActiveInfo } from "./session-hub.js";
import { wrapPreload, composePreloadContext } from "./preload.js";
import { resolveAttachmentsConfig } from "./attachments-config.js";
import { wrapAttachments, inferAttachmentKind, type PromptAttachment } from "./attachments-hint.js";
import { sendFileServerDef, SEND_FILE_SERVER_KEY } from "./send-file-mcp.js";
import {
  selfMcpServerDef,
  SELF_MCP_SERVER_KEY,
  type SelfMcpContext,
  type SelfMcpWriteContext,
  type SelfMcpTrigger,
} from "./self-mcp.js";
import type { AttachmentStore } from "./attachments.js";
import type { QueuedMessageStore } from "./queued-message.js";
import type { ArchiveStore } from "./archive.js";
import type { ScheduleSessionStore } from "./schedule-session.js";
import { schedulePromptFileAbsPath } from "./schedule-config.js";
import {
  type RunProvenanceStore,
  type RunProvenance,
  type TurnOrigin,
  HUMAN_ROOT,
  SCHEDULED_ROOT,
  childOf,
} from "./run-provenance.js";
import type { MessageProvenanceStore, MessageSender } from "./message-provenance.js";
import {
  buildInjectedMcpServers,
  createWakeInjectionCache,
  type InjectedMcpBuildArgs,
  type InjectedMcpBuildContext,
} from "./wake-injection.js";
import { resolveMaxSpawnDepth } from "./spawn-capability.js";
import { resolveRecoveryConfig } from "./recovery-config.js";
import { RecoveryEngine } from "./recovery.js";
import type { PaddockEventBus } from "./event-bus.js";
import type { HookService } from "./hooks.js";
import {
  hookPromptFileAbsPath,
  resolveHooksMcpEnabled,
  type HookDto,
  type HookEvent,
} from "./hook-config.js";
import type { TriggerService } from "./triggers.js";
import type { TriggerSessionStore } from "./trigger-session.js";
import {
  triggerPromptFileAbsPath,
  triggerRunsOnOwnAgent,
  mergeTriggerUpdate,
  type TriggerDto,
  type TriggerEvent,
} from "./trigger-config.js";

/**
 * Per-turn token usage as observed on the SDK stream, normalized to camelCase.
 * Read defensively from either an assistant message (`m.message.usage`) or the
 * final result message (`m.usage`) — fields are loosely typed in core.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** A model id seen on the SDK stream paired (best-effort) with its usage. */
interface ExtractedUsage {
  usage: TurnUsage | null;
  model: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Defensively extract per-turn usage + model from a raw SDK message. The SDK's
 * `message` is typed `unknown` in core, and the CLI/SDK runtimes shape usage
 * slightly differently, so every field access is guarded.
 *
 * - assistant message: `m.message.usage` (Anthropic usage block) + `m.message.model`.
 * - result message: top-level `m.usage` (same field names).
 *
 * Returns `{ usage: null, model: null }` when neither is present.
 */
export function extractUsage(m: SDKMessage): ExtractedUsage {
  const raw = m as unknown as {
    type?: string;
    usage?: unknown;
    message?: { usage?: unknown; model?: unknown } | unknown;
  };

  // Locate the usage block + model from whichever shape this message carries.
  let usageBlock: unknown;
  let model: string | null = null;

  const inner =
    raw.message && typeof raw.message === "object"
      ? (raw.message as { usage?: unknown; model?: unknown })
      : undefined;
  if (inner) {
    if (inner.usage !== undefined) usageBlock = inner.usage;
    if (typeof inner.model === "string") model = inner.model;
  }
  // Result messages (and some shapes) carry usage at the top level.
  if (usageBlock === undefined && raw.usage !== undefined) usageBlock = raw.usage;

  if (usageBlock === undefined || usageBlock === null || typeof usageBlock !== "object") {
    return { usage: null, model };
  }

  const u = usageBlock as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
  const usage: TurnUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
  };
  // A usage block of all-zeros (e.g. a stub) is not informative; treat as none.
  const anyTokens =
    usage.inputTokens || usage.outputTokens || usage.cacheCreationTokens || usage.cacheReadTokens;
  return { usage: anyTokens ? usage : null, model };
}

/** The `<synthetic>` model marker CC stamps on placeholder assistant turns. */
const SYNTHETIC_MODEL = "<synthetic>";
/**
 * Bare synthetic placeholders that carry no output worth surfacing — e.g. the
 * "No response requested." turn CC injects after a `/compact` continuation. Only a
 * synthetic message with *substantive* text is a genuine local-command result.
 */
const SYNTHETIC_PLACEHOLDERS = new Set(["No response requested."]);

/**
 * The rendered output of a client-local slash command (`/context`, `/usage`, …) to
 * surface as an assistant note, or null when this SDK message isn't one (issue #158).
 *
 * The interactive TUI renders these locally; a non-interactive SDK session (Paddock's
 * path) instead surfaces the output as EITHER a `type:"system"` / `local_command`
 * entry (its `content` wraps the output in `<local-command-stdout>…`) or a
 * `model:"<synthetic>"` assistant placeholder carrying the text. @herdctl/chat's
 * translator drops both (synthetic messages are skipped; system entries aren't text),
 * so the live command turn would otherwise read as a silent no-op. We recover the text
 * and emit it as an assistant note (mirroring the `compact_boundary` special-case),
 * consistent with the history-path recovery in `localcommand.ts`. Bare placeholders
 * (e.g. `/compact`'s "No response requested.") yield null so they stay quiet. Paddock's
 * own context ring + cost meter remain the primary usage view; this just stops the
 * output vanishing.
 */
export function extractLocalCommandOutput(m: SDKMessage): string | null {
  const raw = m as unknown as {
    type?: string;
    subtype?: string;
    content?: unknown;
    message?: { model?: unknown; content?: unknown } | unknown;
  };
  // Disk/canonical form: a `system` / `local_command` entry wrapping the stdout.
  if (raw.type === "system" && raw.subtype === "local_command") {
    const content = typeof raw.content === "string" ? raw.content : "";
    const inner = /<local-command-stdout>([\s\S]*)<\/local-command-stdout>/.exec(content)?.[1];
    const text = (inner ?? "").trim();
    return text.length > 0 ? text : null;
  }
  // Live/stream form: a synthetic placeholder assistant message carrying the text.
  if (raw.type !== "assistant") return null;
  const inner =
    raw.message && typeof raw.message === "object"
      ? (raw.message as { model?: unknown; content?: unknown })
      : undefined;
  if (!inner || inner.model !== SYNTHETIC_MODEL) return null;
  let text = "";
  if (typeof inner.content === "string") text = inner.content;
  else if (Array.isArray(inner.content)) {
    for (const block of inner.content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type === "text" && typeof b.text === "string") text += b.text;
    }
  }
  text = text.trim();
  if (text.length === 0 || SYNTHETIC_PLACEHOLDERS.has(text)) return null;
  return text;
}

/**
 * The context snapshot a usage block implies: the tokens resident in the model's
 * context window for this turn (fresh input + cache reads + cache creation).
 */
function contextTokensOf(u: TurnUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * Merge the turn's running usage with a newly-seen block, keeping whichever best
 * reflects the context snapshot (issue #165).
 *
 * A turn emits two usage-bearing messages: the assistant message (full usage,
 * carrying `cache_read_input_tokens`/`cache_creation_input_tokens`) followed by
 * the terminal `result` message, whose top-level usage carries `input_tokens`
 * but ZEROED cache fields. A naive "keep the last non-null usage" therefore lets
 * the cache-less result block clobber the assistant block, dropping the cache
 * tokens and under-reporting context (meter showed 3,071 instead of 21,461).
 *
 * So we keep the block with the MAX contextTokens (input + cacheRead +
 * cacheCreation): the cache-less result block can never lower the snapshot, yet
 * if the result block is the ONLY usage seen this turn (some runtimes) it is
 * still adopted. `outputTokens` is tracked separately as the max seen, since the
 * result message typically carries the final cumulative output.
 */
export function pickTurnUsage(prev: TurnUsage | null, next: TurnUsage): TurnUsage {
  if (!prev) return next;
  const chosen = contextTokensOf(next) >= contextTokensOf(prev) ? next : prev;
  return {
    ...chosen,
    outputTokens: Math.max(prev.outputTokens, next.outputTokens),
  };
}

// --- client -> server --------------------------------------------------------

export interface ChatSendMessage {
  type: "chat:send";
  payload: {
    /** Project slug, or "scratch" for one-off chats. (`target` accepted as alias.) */
    projectSlug?: string;
    target?: string;
    /** Session to resume; null/omitted starts a new chat. */
    sessionId?: string | null;
    message: string;
    /**
     * When true AND this is a NEW chat (sessionId null/omitted) AND the project
     * has an OVERVIEW.md, prepend that overview to the prompt as a delimited
     * context block (issue #1). No-op for scratch or when no overview exists.
     */
    preloadContext?: boolean;
    /**
     * Optional per-chat model override (a known model id). Unknown/absent ->
     * the project's persisted model (scratch -> keeper default). The keeper /
     * scratch agent is re-registered at this model before triggering. (§7.)
     */
    model?: string;
    /**
     * Files the user attached in the composer (issue #328). Each references an
     * attachment already uploaded via `POST …/chats/:id/upload` (bytes in the
     * store). The server validates them against the project's effective attachment
     * config, then prepends a `<paddock-attachments>` hint block to the prompt
     * pointing the keeper's `Read` tool at the absolute paths. Project chats only.
     */
    attachments?: Array<{ id: string; filename: string; kind?: string }>;
  };
}

export interface ChatCancelMessage {
  type: "chat:cancel";
  payload: { jobId: string };
}

/**
 * Run a slash command (e.g. `/compact`) in the current chat.
 *
 * Unlike `chat:send`, this drives herdctl's streaming session so the CLI
 * dispatches the command instead of treating the text as a plain prompt. The
 * command acts on the resumed `sessionId`, so `/compact` compacts the real
 * chat history. Output streams back over the same `chat:response` /
 * `chat:tool_call` / `chat:complete` events as a normal turn.
 */
export interface ChatCommandMessage {
  type: "chat:command";
  payload: {
    projectSlug?: string;
    target?: string;
    /** Session the command runs against. Required (a command needs a chat). */
    sessionId?: string | null;
    /** The full command text, including the leading slash (e.g. "/compact"). */
    command: string;
  };
}

/**
 * Attach a socket to a session's live stream (issue #54). Sent on (re)connect so
 * a socket that dropped mid-turn can re-attach to the still-running turn and be
 * replayed the frames it missed.
 *
 * `wantReplay` MUST be false on a fresh mount (which also hydrates the transcript
 * over REST) so buffered frames don't duplicate the transcript; it is true only
 * for a genuine reconnect of a socket that was mid-turn, with `lastSeq` = the
 * last per-turn `seq` the client applied (the replay is exactly the gap after it).
 */
export interface ChatSubscribeMessage {
  type: "chat:subscribe";
  payload: {
    projectSlug?: string;
    target?: string;
    /** The session to attach to. Required. */
    sessionId: string;
    /** Replay the missed gap of a live turn (reconnect); false = future frames only. */
    wantReplay?: boolean;
    /** Last per-turn `seq` the client applied; the server replays everything after it. */
    lastSeq?: number;
  };
}

/**
 * Store a queued message to be auto-sent when the current turn completes (#197).
 * The client sends this to persist the queue server-side so it survives browser
 * close; the server stores it, checks after turn completion, and auto-sends if
 * present. The web client also keeps a localStorage copy for live editing UX.
 */
export interface ChatSetQueueMessage {
  type: "chat:set_queue";
  payload: {
    projectSlug?: string;
    target?: string;
    sessionId?: string | null;
    /** The queued message text, or null/empty to clear. */
    text?: string | null;
    /**
     * Client-stamped identity of this queued message (#245): the ms timestamp of
     * when it was first enqueued, stable across reloads. The server records the ts
     * of the message it last drained per session so it can skip re-sending a stale
     * copy a reloaded client re-asserts. Absent → the server stamps `Date.now()`.
     */
    ts?: number | null;
  };
}

/**
 * Manually re-drive a keeper that hung because its background task was killed at
 * the turn boundary (issue #301, Layer 2). The keeper's session stayed ALIVE (see
 * edspencer/herdctl#374) so it's still injectable — this action injects a recovery
 * nudge into it via {@link startAgentTurn}, exactly the message a human sends by
 * hand today to unstick it, but one click and correctly attributed
 * (`sender: { kind: "recovery" }`). Gated server-side on the resolved
 * `recovery.surfaceKilledTask` (per-project override else instance default), so a
 * client can't re-drive when the operator turned Layer 2 off.
 */
export interface ChatContinueMessage {
  type: "chat:continue";
  payload: {
    projectSlug?: string;
    target?: string;
    /** The hung keeper session to re-drive. Required (recovery needs a chat). */
    sessionId: string;
  };
}

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | ChatSendMessage
  | ChatCommandMessage
  | ChatCancelMessage
  | ChatSubscribeMessage
  | ChatSetQueueMessage
  | ChatContinueMessage
  | PingMessage;

/**
 * The recovery nudge injected by a manual Continue (issue #301, Layer 2) — and,
 * later, by Layer 3 auto re-drive. It tells the keeper the truth (its background
 * task was KILLED AT THE TURN BOUNDARY, not "stopped by the user" — cf #216) so it
 * reacts sensibly: re-run the work in the FOREGROUND this turn, or report what
 * happened. Kept terse; the killed `<task-notification>` is already in its context.
 */
export const RECOVERY_NUDGE =
  "[Paddock recovery] Your previous turn ended while a background task was still " +
  "running, and that task was then KILLED at the turn boundary by the runtime — " +
  "this is a known limitation (see herdctl#374), NOT a user cancellation. Nothing " +
  "is running now. Please pick up where you left off: if you still need that work, " +
  "re-run it in the FOREGROUND this turn (do not background it), otherwise summarise " +
  "what happened and continue.";

// --- server -> client --------------------------------------------------------

interface Routing {
  projectSlug: string;
  /** Alias for early frontends. */
  target: string;
  sessionId: string | null;
  jobId: string | null;
  /**
   * Per-turn, monotonic sequence number stamped by the SessionHub as the frame
   * is emitted (issue #54). Lets a reconnecting client tell the server the last
   * frame it applied so the exact missed gap can be replayed. Absent on frames
   * not routed through the hub (e.g. chat:error).
   */
  seq?: number;
}

export interface ChatResponseMessage {
  type: "chat:response";
  payload: Routing & { chunk: string };
}

export interface ChatToolCallMessage {
  type: "chat:tool_call";
  payload: Routing & {
    toolName: string;
    inputSummary?: string;
    output: string;
    isError: boolean;
    durationMs?: number;
    /**
     * The originating tool_use id. Lets a client reconcile this completion with
     * the pending row it created on the earlier `chat:tool_start` frame (#175).
     */
    toolUseId?: string;
  };
}

/**
 * An in-flight tool_use, emitted the moment the tool STARTS — before it runs or
 * produces a result (#175). Lets a client render a pending "running…" row for
 * slow tools (especially subagents that run for minutes), keyed by `toolUseId`,
 * then reconcile it when the matching `chat:tool_call` completion arrives.
 * Sourced from `@herdctl/chat`'s `onToolStart` (v0.6.0+).
 */
export interface ChatToolStartMessage {
  type: "chat:tool_start";
  payload: Routing & {
    toolName: string;
    inputSummary?: string;
    toolUseId?: string;
    /** Subagent attribution: null = main agent, else the spawning Task tool_use id. */
    parentToolUseId: string | null;
  };
}

export interface ChatMessageBoundaryMessage {
  type: "chat:message_boundary";
  payload: Routing;
}

/** Per-turn token usage surfaced on chat:complete (camelCase, with the meter math). */
export interface ChatCompleteUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + cacheRead + cacheCreation (what the context window holds). */
  contextTokens: number;
  /** getContextLimit(model). */
  contextLimit: number;
}

export interface ChatCompleteMessage {
  type: "chat:complete";
  payload: Routing & {
    success: boolean;
    error?: string;
    /** The model this turn ran on (lastModel ?? effectiveModel). Omitted if unknown. */
    model?: string;
    /** Last per-turn usage observed; omitted (with model) if none was seen. */
    usage?: ChatCompleteUsage;
  };
}

export interface ChatErrorMessage {
  type: "chat:error";
  payload: { projectSlug: string; target: string; error: string };
}

/**
 * Tell a re-attaching client to re-hydrate from the transcript instead of a
 * frame replay (issue #54). Emitted only when the missed gap has aged out of the
 * turn's bounded buffer — the rare fallback that trades live-ness for correctness.
 */
export interface ChatResyncMessage {
  type: "chat:resync";
  payload: { projectSlug: string; target: string; sessionId: string };
}

/**
 * A session's live-turn status (issues #52/#53). Broadcast to all clients on a
 * turn's start/stop transition, sent as a snapshot to a newly-connected socket,
 * and sent in reply to a `chat:subscribe` for a session with a running turn. It
 * lets a client restore the Stop button + `jobId` for a returning/remounted pane
 * (#52) and drive the in-chat + per-chat-sidebar streaming indicators (#53).
 */
export interface ChatActiveMessage {
  type: "chat:active";
  payload: {
    projectSlug: string;
    target: string;
    sessionId: string;
    /** The running turn's cancellable job id, when known. */
    jobId: string | null;
    running: boolean;
  };
}

/**
 * Notify the client that the queued message was auto-sent by the server (#197).
 * The client clears its localStorage copy of the queued message when it receives
 * this frame, so queued messages don't duplicate if the browser closes before
 * the turn completes.
 */
export interface ChatQueuedFlushedMessage {
  type: "chat:queued_flushed";
  payload: {
    projectSlug: string;
    target: string;
    sessionId: string;
    /**
     * The queued text the server is now auto-sending as a turn (#245). Present
     * when the server actually drained+sent it — the client renders it as the
     * user bubble in-transcript (the drained turn streams only the reply). Absent
     * when the frame is just telling the client to clear a stale/already-sent copy.
     */
    text?: string;
  };
}

/**
 * A background task was killed at the turn boundary and the keeper is idle
 * (issue #347). Broadcast LIVE by the recovery engine the moment the kill is
 * detected — the notification is otherwise trapped in the SDK input queue until
 * a later turn flushes it, so without this the "keeper is idle / Continue"
 * affordance only appeared after a manual refresh. The client renders it as the
 * amber killed-task notice inline. Gated server-side on `recovery.surfaceKilledTask`.
 */
export interface ChatKilledTaskMessage {
  type: "chat:killed_task";
  payload: {
    projectSlug: string;
    target: string;
    sessionId: string;
    /** The killed `<task-notification>`'s `<summary>`, or a generic fallback. */
    summary: string;
    /** ISO timestamp of detection — used by the client to dedup replays. */
    timestamp: string;
  };
}

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | ChatResponseMessage
  | ChatToolCallMessage
  | ChatToolStartMessage
  | ChatMessageBoundaryMessage
  | ChatCompleteMessage
  | ChatErrorMessage
  | ChatResyncMessage
  | ChatActiveMessage
  | ChatQueuedFlushedMessage
  | ChatKilledTaskMessage
  | PongMessage;

function readSlug(p: ChatSendMessage["payload"]): string | undefined {
  return p.projectSlug ?? p.target;
}

export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.type === "ping") return true;
  if (m.type === "chat:cancel") {
    const p = m.payload as Record<string, unknown> | undefined;
    return !!p && typeof p.jobId === "string";
  }
  if (m.type === "chat:send") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.message !== "string") return false;
    const slug = p.projectSlug ?? p.target;
    if (typeof slug !== "string") return false;
    if (p.preloadContext !== undefined && typeof p.preloadContext !== "boolean") return false;
    if (p.model !== undefined && typeof p.model !== "string") return false;
    if (p.attachments !== undefined) {
      if (!Array.isArray(p.attachments)) return false;
      for (const a of p.attachments) {
        if (!a || typeof a !== "object") return false;
        const ao = a as Record<string, unknown>;
        if (typeof ao.id !== "string" || typeof ao.filename !== "string") return false;
        if (ao.kind !== undefined && typeof ao.kind !== "string") return false;
      }
    }
    return p.sessionId === undefined || p.sessionId === null || typeof p.sessionId === "string";
  }
  if (m.type === "chat:command") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.command !== "string" || p.command.length === 0) return false;
    const slug = p.projectSlug ?? p.target;
    if (typeof slug !== "string") return false;
    return p.sessionId === undefined || p.sessionId === null || typeof p.sessionId === "string";
  }
  if (m.type === "chat:subscribe") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.sessionId !== "string" || p.sessionId.length === 0) return false;
    if (p.wantReplay !== undefined && typeof p.wantReplay !== "boolean") return false;
    if (p.lastSeq !== undefined && typeof p.lastSeq !== "number") return false;
    return true;
  }
  if (m.type === "chat:continue") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.sessionId !== "string" || p.sessionId.length === 0) return false;
    const slug = p.projectSlug ?? p.target;
    return typeof slug === "string";
  }
  if (m.type === "chat:set_queue") {
    // NOTE: this case was missing until #245 — every chat:set_queue was rejected
    // as "Unknown message", so the server-side queue (#197) never persisted a
    // thing. That's the deeper reason a queued message could strand: the backstop
    // was never armed. Validate leniently (all payload fields optional bar slug).
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p) return false;
    const slug = p.projectSlug ?? p.target;
    if (typeof slug !== "string") return false;
    if (p.sessionId !== undefined && p.sessionId !== null && typeof p.sessionId !== "string")
      return false;
    if (p.text !== undefined && p.text !== null && typeof p.text !== "string") return false;
    if (p.ts !== undefined && p.ts !== null && typeof p.ts !== "number") return false;
    return true;
  }
  return false;
}

/**
 * Register the /ws route handler. Pure transport: it validates messages,
 * resolves the target agent, and streams a real trigger back to the socket.
 */
// Server-side keepalive: how often to ping each client and, if the previous
// ping went unanswered, reap the dead socket. Protocol-level ping frames also
// keep intermediaries (proxies/NAT) from evicting an otherwise-idle connection.
// See issue #46.
const SERVER_PING_INTERVAL_MS = 30_000;

/**
 * Frame an agent-initiated FORK kickoff (issue #214 Phase 2). A fork inherits the
 * parent's transcript as context — and when the parent is the *live* chat doing
 * the forking, that snapshot is taken mid-turn, so the child would otherwise
 * inherit the parent's "I am still mid-task" identity and reject the seeded
 * instruction (observed in QA). This preamble tells the child the history above
 * is inherited background and that its job now is the given directive — which is
 * exactly the fan-out contract ("fork this chat N times, one work-item each").
 */
export function forkKickoffPrompt(directive: string): string {
  return (
    "[Paddock fan-out] You are a NEW chat forked from the conversation above. " +
    "That history is INHERITED CONTEXT — you are NOT in the middle of the prior " +
    "turn, and its final exchange may be truncated at the fork point; do not try " +
    "to continue it. Use it as background, then carry out this instruction as your " +
    "task now:\n\n" +
    directive
  );
}

/**
 * The slice of herdctl's `ScheduleInfo` the self-MCP schedule DTO surfaces (issue
 * #289) — live runtime state herdctl tracks for an armed schedule. Kept as a local
 * structural type (mirrors routes.ts's `ScheduleRuntimeInfo`) so this module stays
 * off `@herdctl/core`'s import surface.
 */
interface ScheduleRuntimeInfo {
  status?: "idle" | "running" | "disabled";
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string | null;
}

/**
 * Project a persisted {@link TriggerDto} (+ optional herdctl runtime state for a
 * schedule trigger) onto the flat {@link SelfMcpTrigger} shape the unified trigger
 * tools return (Epic T / T3). Flattens the discriminated `trigger` WHEN + the shared
 * `run` WHAT + null-normalises so the agent reads ONE flat record regardless of type;
 * `info` is only meaningful for an armed schedule trigger (absent for event/webhook).
 */
function toSelfMcpTrigger(dto: TriggerDto, info?: ScheduleRuntimeInfo): SelfMcpTrigger {
  const when = dto.trigger;
  const run = dto.run;
  const isSchedule = when.type === "schedule";
  return {
    name: dto.name,
    agentName: dto.agentName,
    type: when.type,
    cron: when.type === "schedule" ? when.cron ?? null : null,
    interval: when.type === "schedule" ? when.interval ?? null : null,
    event: when.type === "event" ? when.on : null,
    path: when.type === "webhook" ? when.path : null,
    prompt: run.prompt ?? null,
    promptFile: run.promptFile ?? null,
    session: run.session,
    tools: run.tools ?? [],
    maxSpawnDepth: run.maxSpawnDepth ?? null,
    permissionMode: run.permissionMode ?? null,
    model: run.model ?? null,
    maxTurns: run.maxTurns ?? null,
    enabled: dto.enabled === true,
    // Live runtime state is only tracked for an armed SCHEDULE trigger.
    status: isSchedule
      ? info?.status ?? (dto.enabled === false ? "disabled" : "idle")
      : null,
    lastRunAt: isSchedule ? info?.lastRunAt ?? null : null,
    nextRunAt: isSchedule ? info?.nextRunAt ?? null : null,
    lastError: isSchedule ? info?.lastError ?? null : null,
  };
}

/**
 * The context a fired lifecycle event carries into the hook prompt (Epic G / G1).
 * v1 (`onArchive`) supplies the archived chat's session id so the hook knows what to
 * act on; a future event would extend this.
 */
interface HookEventContext {
  /** The session id of the chat whose lifecycle event fired the hook. */
  sessionId: string;
}

/**
 * The context a fired lifecycle event carries into an EVENT trigger's prompt (Epic T /
 * T1) — the unified successor to {@link HookEventContext}. v1 (`onArchive`) supplies
 * the archived chat's session id so the trigger knows what to act on.
 */
interface TriggerEventContext {
  /** The session id of the chat whose lifecycle event fired the trigger. */
  sessionId: string;
}

export function makeChatHandler(deps: {
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
   * In-process lifecycle event bus (Epic G / G1). When present (with {@link hooks}),
   * this handler subscribes to lifecycle events (v1: `onArchive`) and fires each of
   * the project's ENABLED matching hooks as its own `hook-<slug>-<name>` agent turn
   * via {@link startAgentTurn}. Absent ⇒ no hook dispatch (existing behaviour), so
   * tests that don't exercise hooks need not supply it.
   */
  events?: PaddockEventBus;
  /**
   * Hook CRUD service (Epic G / G1) — the dispatcher reads a project's enabled hooks
   * for a fired event through it. Paired with {@link events}; absent ⇒ no dispatch.
   */
  hooks?: HookService;
  /**
   * Unified trigger registry (Epic T / T1). When present, this handler fires the
   * project's enabled EVENT triggers (via the {@link events} bus) and its SCHEDULE
   * triggers (via herdctl's `setScheduleTriggerHandler`) through the SAME
   * {@link startAgentTurn} core the hooks/schedules paths use — the unification. Absent
   * ⇒ no trigger dispatch (existing hooks/schedules behaviour unchanged), so tests that
   * don't exercise triggers need not supply it.
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
}) {
  // ONE hub shared across every socket this handler serves: it tracks each
  // session's in-flight turn and fans its frames out to whichever socket(s) are
  // currently attached, so a turn survives the death of the socket that started
  // it (issue #54). See session-hub.ts.
  const hub = new SessionHub();

  // Per-session marker of the last queued message the server has already drained
  // (#245), keyed `agent \0 sessionId` and stamped with that message's client
  // timestamp. Lets an idle-drain skip a message it already sent — e.g. a stale
  // localStorage copy a reloaded client re-asserts — instead of double-sending.
  // In-memory (shared across this handler's sockets); a rare double-send only
  // survives a server restart, when the persisted store is already empty anyway.
  const lastFlushedTs = new Map<string, number>();

  // Every currently-connected socket, so a turn's start/stop transition can be
  // broadcast to all clients — powering the per-chat sidebar streaming dots that
  // must update even for chats whose pane isn't mounted (issue #53).
  const clients = new Set<WebSocket>();
  const activeFrame = (info: ActiveInfo): ChatActiveMessage => ({
    type: "chat:active",
    payload: {
      projectSlug: info.projectSlug,
      target: info.projectSlug,
      sessionId: info.sessionId,
      jobId: info.jobId,
      running: info.running,
    },
  });
  hub.onActive = (info) => {
    const data = JSON.stringify(activeFrame(info));
    for (const c of clients) {
      if (c.readyState === c.OPEN) {
        try {
          c.send(data);
        } catch {
          /* a socket that throws on send is effectively gone */
        }
      }
    }
  };

  // Drive scheduler-fired session wakes onto the hub (Paddock#111 gap 3). When a
  // keeper scheduled a `ScheduleWakeup` / `/loop`, herdctl reaps the idle session
  // and later resumes it at fire time, handing us the live (managed) session with
  // NO client watching. We stream it exactly like a human turn — same translator,
  // same hub — so the autonomous work lands in the transcript, drives the sidebar
  // streaming dot (via `hub.onActive`), and is replayable by a client that opens
  // the chat later. We do NOT close the session: it's managed, so the reaper tears
  // it down when it goes idle again (and re-captures any fresh wakeups).
  deps.herdctl.onSessionWake(async (session: RuntimeSession, entry: SessionWakeEntry) => {
    const slug = keeperSlugFromAgent(entry.agent) ?? SCRATCH_SLUG;
    let resolvedSession: string | null = entry.sessionId ?? null;
    const turn: TurnHandle = hub.startTurn(slug, null, entry.sessionId);
    // A1 (#261): a scheduler-fired session wake is a non-human ("scheduled")
    // turn. Stamp its provenance ONLY if the chat carries none yet — a wake
    // resumes an EXISTING chat (a human's, or a spawn's, that self-scheduled a
    // ScheduleWakeup/`/loop`), so `stampIfAbsent` preserves that creation
    // provenance instead of relabelling it. depth 0: a schedule is a root
    // trigger, like a human. (No cron scheduler is wired yet — Epic D — this
    // just makes the path carry the marker.)
    const stampScheduled = (id: string | null): void => {
      if (id) void deps.runProvenance?.stampIfAbsent(id, SCHEDULED_ROOT).catch(() => undefined);
    };
    stampScheduled(resolvedSession);
    const routing = (): Routing => ({
      projectSlug: slug,
      target: slug,
      sessionId: resolvedSession,
      jobId: turn.jobId,
    });
    const translate = createSDKMessageHandler({
      onText: (chunk) => {
        if (chunk) turn.emit({ type: "chat:response", payload: { ...routing(), chunk } });
      },
      onBoundary: () => {
        turn.emit({ type: "chat:message_boundary", payload: routing() });
      },
      onToolStart: (start) => {
        turn.emit({
          type: "chat:tool_start",
          payload: {
            ...routing(),
            toolName: start.toolName,
            inputSummary: start.inputSummary,
            toolUseId: start.toolUseId,
            parentToolUseId: start.parentToolUseId,
          },
        });
      },
      onToolCall: (call) => {
        turn.emit({
          type: "chat:tool_call",
          payload: {
            ...routing(),
            toolName: call.toolName,
            inputSummary: call.inputSummary,
            output: call.output,
            isError: call.isError,
            durationMs: call.durationMs,
            toolUseId: call.toolUseId,
          },
        });
      },
    });
    try {
      for await (const m of session.messages) {
        if (m.session_id) {
          resolvedSession = m.session_id;
          turn.setSession(m.session_id);
          stampScheduled(m.session_id);
        }
        await translate(m as unknown as ChatSDKMessage);
        if (m.type === "result") break;
      }
      turn.emit({
        type: "chat:complete",
        payload: { ...routing(), sessionId: resolvedSession, success: true },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      turn.emit({ type: "chat:complete", payload: { ...routing(), success: false, error } });
    } finally {
      turn.end();
    }
    // Post-wake curation sweep, same as a human turn (never for scratch). T5: routed
    // through the `afterTurn` event so the folded-in curator dispatches once.
    emitAfterTurn(slug, resolvedSession ?? null);
  });

  /** Resolve a project's effective keeper drive mode (override else instance default). */
  function resolveDriveMode(project: Awaited<ReturnType<typeof deps.projects.get>>): DriveMode {
    return project.driveMode && isKnownDriveMode(project.driveMode)
      ? project.driveMode
      : deps.cfg.keeperDriveMode;
  }

  /**
   * Resolve the prompt a scheduled fire should run (issue #265 / DD-2). A
   * schedule's `promptFile` (Paddock-only, `.paddock/schedules/*.md`, git-tracked +
   * keeper-editable) is read FRESH here at fire time — so a keeper's edit takes
   * effect on the very next fire with no agent re-register — and forwarded as a
   * plain prompt string. Falls back to the inline prompt (the caller's armed copy,
   * else the live project record's) when there is no file or it can't be read.
   * `armed.prompt` is what herdctl armed (no `promptFile`); the live project record
   * still carries `promptFile`, so we read it off `project.schedules`.
   */
  async function resolveSchedulePrompt(
    project: Awaited<ReturnType<typeof deps.projects.get>>,
    scheduleName: string,
    armed: { prompt?: string },
  ): Promise<string> {
    const rec = project.schedules?.[scheduleName];
    const inline =
      (typeof armed.prompt === "string" ? armed.prompt : rec?.prompt) ?? "";
    if (rec?.promptFile) {
      const abs = schedulePromptFileAbsPath(project.workingDir, rec.promptFile);
      if (abs) {
        const content = await fs.readFile(abs, "utf8").catch(() => null);
        if (content !== null) return content;
      }
    }
    return inline;
  }

  /**
   * Run one scheduled fire of `scheduleName` on `project` as a first-class chat on
   * the hub — shared (issue #266 / D4) by BOTH herdctl's cron-fired path (the
   * `onScheduleTrigger` handler below) and the UI's "trigger now" action (the
   * `POST …/schedules/:name/trigger` route calls the exposed {@link fireSchedule}).
   *
   * We run the turn via our OWN {@link startAgentTurn}/hub rather than herdctl's
   * internal `--resume` path, so the run is a first-class Paddock chat: it streams
   * live, drives the sidebar dot, is re-attachable, and is NEVER `isSidechain`-hidden.
   *
   * `resumeSession` drives new-vs-accrete (DD-2): `false` → a FRESH chat every fire
   * (`resume: null`); `true` → resume the schedule's ONE owned session (created on
   * the first fire, remembered in the ScheduleSessionStore, reused thereafter) so a
   * "manager" accretes a single transcript. `armedPrompt` is the inline prompt from
   * herdctl's armed copy when a cron fire supplies one (else the live project record
   * / a `promptFile` is read fresh). origin `scheduled`, depth 0 — a cron (or a
   * manual trigger) is a root trigger exactly like a human (A1/#261), so a NEW chat
   * is stamped `scheduled` (badgeable by #267) while a resumed accreting chat keeps
   * its marker. Resolves the created/resumed session id, or `null` if the turn never
   * produced one (its own failure frame is already emitted).
   */
  async function fireScheduleForProject(
    project: Awaited<ReturnType<typeof deps.projects.get>>,
    scheduleName: string,
    resumeSession: boolean,
    armedPrompt?: string,
  ): Promise<string | null> {
    const slug = project.slug;
    const agentName = keeperAgentName(slug);
    const prompt = await resolveSchedulePrompt(project, scheduleName, { prompt: armedPrompt });

    // resume_session: true accretes into an owned session; false starts fresh.
    let resume: string | null = null;
    if (resumeSession && deps.scheduleSessions) {
      const owned = await deps.scheduleSessions.get(slug, scheduleName).catch(() => undefined);
      if (owned && (await deps.herdctl.sessionExists(project, owned).catch(() => false))) {
        resume = owned;
      } else if (owned) {
        // A stale owned id whose transcript no longer exists (a human deleted the
        // chat): forget it so this fire re-creates one instead of failing to resume.
        await deps.scheduleSessions.clear(slug, scheduleName).catch(() => undefined);
      }
    }

    try {
      const sessionId = await startAgentTurn({
        projectSlug: slug,
        agentName,
        workingDir: project.workingDir,
        resume,
        prompt,
        driveMode: resolveDriveMode(project),
        fallbackModel: project.model,
        origin: "scheduled",
        depth: 0,
        maxSpawnDepth: resolveMaxSpawnDepth(project.maxSpawnDepth, deps.cfg.maxSpawnDepth),
        // #290: attribute the injected turn to the schedule that fired it.
        sender: { kind: "schedule", name: scheduleName, project: slug },
      });
      // First fire of an accreting schedule: remember the chat it created so the
      // next fire resumes THIS transcript (a resume already had an id).
      if (resumeSession && !resume && deps.scheduleSessions) {
        await deps.scheduleSessions.set(slug, scheduleName, sessionId).catch(() => undefined);
      }
      return sessionId;
    } catch {
      // startAgentTurn rejects only if the turn never produced a session id; its
      // own failure frame is already emitted. Swallow so the scheduler records the
      // fire complete and computes the next run — a transient failure shouldn't
      // wedge the schedule.
      return null;
    }
  }

  /**
   * Manually fire a project's schedule NOW (issue #266 / D4), reused by the
   * `POST …/schedules/:name/trigger` route. Resolves the live project + its schedule
   * record (so `resume_session` / `prompt` / `promptFile` come straight from
   * project.yaml, exactly as a cron fire would see them) and runs it via the shared
   * {@link fireScheduleForProject}. Returns the started chat's session id, or `null`
   * if the project/schedule is gone or the turn never produced a session.
   */
  async function fireSchedule(slug: string, scheduleName: string): Promise<string | null> {
    const project = await deps.projects.get(slug).catch(() => null);
    if (!project) return null;
    const rec = project.schedules?.[scheduleName];
    if (!rec) return null;
    return fireScheduleForProject(project, scheduleName, rec.resume_session === true, rec.prompt);
  }

  // Drive scheduler-fired chats onto the hub (issue #265 / DD-1, DD-2). herdctl's
  // cron engine fires a project keeper's declared schedule and routes it HERE
  // (setScheduleTriggerHandler) instead of running it headless.
  deps.herdctl.onScheduleTrigger(async (info: TriggerInfo) => {
    const slug = keeperSlugFromAgent(info.agent.name);
    // Only keeper agents carry Paddock schedules; a non-keeper trigger (there are
    // none today) has nowhere sensible to route, so ignore it rather than guess.
    if (!slug) return;
    const project = await deps.projects.get(slug).catch(() => null);
    if (!project) return;
    // Unified triggers (Epic T / T1): a fired keeper schedule may belong to a
    // SCHEDULE-type trigger (forwarded into the same keeper `schedules` block under
    // its trigger name). Resolve that FIRST — the unified model is authoritative — and
    // fire it via the single trigger fire path; otherwise fall back to the legacy
    // schedule path (which T3/T5 eventually retire).
    const trig = project.triggers?.[info.scheduleName];
    if (trig && trig.trigger.type === "schedule" && trig.enabled === true) {
      await fireTriggerForProject(project, {
        name: info.scheduleName,
        agentName: triggerAgentName(slug, info.scheduleName),
        ...trig,
      });
      return;
    }
    const armed =
      typeof info.schedule.prompt === "string" ? info.schedule.prompt : undefined;
    await fireScheduleForProject(
      project,
      info.scheduleName,
      info.schedule.resume_session === true,
      armed,
    );
  });

  // --- event hooks (Epic G / G1) -----------------------------------------

  /**
   * Resolve the prompt an event-hook fire should run. A hook's `promptFile`
   * (Paddock-only, `.paddock/hooks/*.md`, git-tracked + keeper-editable) is read
   * FRESH here at fire time — so a keeper's edit takes effect on the very next fire
   * with no agent re-register — and falls back to the inline `prompt` when there's no
   * file or it can't be read. `event` context (which chat was archived) is prepended
   * as a short machine preamble so the hook knows WHAT to act on (e.g. which pm server
   * / clone the archived chat spun up). Mirrors {@link resolveSchedulePrompt}.
   */
  async function resolveHookPrompt(
    project: Awaited<ReturnType<typeof deps.projects.get>>,
    hook: HookDto,
    ctx: HookEventContext,
  ): Promise<string> {
    let body = typeof hook.prompt === "string" ? hook.prompt : "";
    if (hook.promptFile) {
      const abs = hookPromptFileAbsPath(project.workingDir, hook.promptFile);
      if (abs) {
        const content = await fs.readFile(abs, "utf8").catch(() => null);
        if (content !== null) body = content;
      }
    }
    const preamble =
      `A \`${hook.event}\` event hook fired for project \`${project.slug}\`: ` +
      `chat \`${ctx.sessionId}\` was just archived.\n\n`;
    return preamble + body;
  }

  /**
   * Fire ONE event hook as a first-class chat on the hub — its OWN
   * `hook-<slug>-<name>` agent turn (GG-1), so the run streams live, is re-attachable,
   * and stamps `origin: hook` provenance (badgeable by G3). Always a FRESH chat
   * (`resume: null`): a hook fire is a root trigger, not a continuation. FIRE-AND-
   * FORGET and fully swallowed — a hook must NEVER fail or block the triggering
   * action (GG-2). The hook's granted tools (its agent config) do the work.
   */
  async function fireHookForProject(
    project: Awaited<ReturnType<typeof deps.projects.get>>,
    hook: HookDto,
    ctx: HookEventContext,
  ): Promise<void> {
    const prompt = await resolveHookPrompt(project, hook, ctx);
    try {
      await startAgentTurn({
        projectSlug: project.slug,
        agentName: hookAgentName(project.slug, hook.name),
        workingDir: project.workingDir,
        resume: null,
        prompt,
        driveMode: resolveDriveMode(project),
        fallbackModel: hook.capabilities?.model ?? project.model,
        origin: "hook",
        depth: 0,
        maxSpawnDepth: resolveMaxSpawnDepth(project.maxSpawnDepth, deps.cfg.maxSpawnDepth),
        // Attribute the injected kickoff turn to the hook that fired it (#290).
        sender: { kind: "hook", name: hook.name, project: project.slug },
      });
    } catch {
      // startAgentTurn rejects only if the turn never produced a session id; its own
      // failure frame is already emitted. Swallow — a hook is fire-and-forget and must
      // not surface into the lifecycle action that triggered it.
    }
  }

  /**
   * Resolve a project's ENABLED hooks for `event` and fire each (GG-2: after-commit,
   * non-blocking). Concurrent + independent — one hook's failure never affects
   * another (each `fireHookForProject` swallows). No-op when the hook system isn't
   * wired ({@link makeChatHandler} deps `hooks` absent) or the project has no matching
   * enabled hook — so nothing fires unless a hook was explicitly created AND enabled.
   */
  async function dispatchHooks(slug: string, event: HookEvent, ctx: HookEventContext): Promise<void> {
    if (!deps.hooks) return;
    const project = await deps.projects.get(slug).catch(() => null);
    if (!project) return;
    const matching = await deps.hooks.enabledForEvent(slug, event).catch(() => []);
    await Promise.all(matching.map((hook) => fireHookForProject(project, hook, ctx)));
  }

  // Subscribe the dispatcher to lifecycle events (Epic G / G1). The commit sites (the
  // archive route + the self-MCP archive tool) `emit` AFTER the archive persists, so a
  // hook only ever runs after the triggering action has committed. `emit` is
  // fire-and-forget (never blocks/throws into the archiver), so the whole hook system
  // is decoupled from the action that triggers it.
  deps.events?.on("onArchive", (payload) => {
    void dispatchHooks(payload.slug, "onArchive", { sessionId: payload.sessionId });
  });

  // --- unified triggers (Epic T / T1) ------------------------------------

  /**
   * Resolve the prompt a fired trigger should run. A trigger's `promptFile`
   * (Paddock-only, `.paddock/triggers/*.md`, git-tracked + keeper-editable) is read
   * FRESH here at fire time — so an edit takes effect on the very next fire with no
   * agent re-register — and falls back to the inline `run.prompt` when there's no file
   * or it can't be read. For an EVENT trigger, a short machine preamble naming the
   * event + archived chat is prepended (so the trigger knows WHAT to act on); a
   * schedule trigger gets no preamble. Mirrors {@link resolveSchedulePrompt} /
   * {@link resolveHookPrompt}.
   */
  async function resolveTriggerPrompt(
    project: Awaited<ReturnType<typeof deps.projects.get>>,
    trigger: TriggerDto,
    ctx?: TriggerEventContext,
  ): Promise<string> {
    let body = typeof trigger.run.prompt === "string" ? trigger.run.prompt : "";
    if (trigger.run.promptFile) {
      const abs = triggerPromptFileAbsPath(project.workingDir, trigger.run.promptFile);
      if (abs) {
        const content = await fs.readFile(abs, "utf8").catch(() => null);
        if (content !== null) body = content;
      }
    }
    if (trigger.trigger.type === "event" && ctx) {
      const preamble =
        `A \`${trigger.trigger.on}\` event trigger fired for project \`${project.slug}\`: ` +
        `chat \`${ctx.sessionId}\` was just archived.\n\n`;
      return preamble + body;
    }
    return body;
  }

  /**
   * Run one fire of a trigger as a first-class chat on the hub — the ONE fire path for
   * every trigger type (Epic T), replacing the separate schedule + hook fire paths with
   * a single `startAgentTurn` call. Whether the fired turn runs on the trigger's OWN
   * scoped `trigger-<slug>-<name>` agent (tool config = `run.tools`) or on the keeper is
   * decided by {@link triggerRunsOnOwnAgent}: an EVENT trigger always runs scoped; a
   * SCHEDULE trigger runs scoped ONLY when it declares a non-empty `run.tools` allow-list
   * (T2 — #307), otherwise it runs as the keeper with the project-agent default toolset
   * (pre-T2 behaviour, unchanged). `run.maxSpawnDepth` gates this fire's self-MCP spawn
   * capability regardless of which agent runs it.
   *
   * `run.session` drives new-vs-accrete: `"new"` → a FRESH chat every fire
   * (`resume: null`); `"resume"` → resume the trigger's ONE owned session (recorded on
   * first fire in the {@link TriggerSessionStore}, rebound after a restart) so a
   * "manager" accretes a single transcript. A stale owned id (its transcript deleted)
   * is forgotten so the next fire re-creates one. FIRE-AND-FORGET: a rejection (the
   * turn never produced a session id — its own failure frame already emitted) is
   * swallowed so a transient failure never wedges the trigger. Resolves the
   * created/resumed session id, or `null`.
   */
  async function fireTriggerForProject(
    project: Awaited<ReturnType<typeof deps.projects.get>>,
    trigger: TriggerDto,
    ctx?: TriggerEventContext,
  ): Promise<string | null> {
    const slug = project.slug;
    const isSchedule = trigger.trigger.type === "schedule";
    // T2: a scoped trigger (every event; a schedule with a `run.tools` allow-list) runs
    // on its OWN `trigger-<slug>-<name>` agent so herdctl enforces its capability; an
    // unscoped schedule runs as the keeper (project-agent default toolset, unchanged).
    const onOwnAgent = triggerRunsOnOwnAgent(trigger);
    const agentName = onOwnAgent ? triggerAgentName(slug, trigger.name) : keeperAgentName(slug);
    const prompt = await resolveTriggerPrompt(project, trigger, ctx);

    // run.session: "resume" accretes into an owned session; "new" starts fresh.
    let resume: string | null = null;
    if (trigger.run.session === "resume" && deps.triggerSessions) {
      const owned = await deps.triggerSessions.get(slug, trigger.name).catch(() => undefined);
      if (owned && (await deps.herdctl.sessionExists(project, owned).catch(() => false))) {
        resume = owned;
      } else if (owned) {
        await deps.triggerSessions.clear(slug, trigger.name).catch(() => undefined);
      }
    }

    try {
      const sessionId = await startAgentTurn({
        projectSlug: slug,
        agentName,
        workingDir: project.workingDir,
        resume,
        prompt,
        driveMode: resolveDriveMode(project),
        fallbackModel: trigger.run.model ?? project.model,
        // Provenance (A1/#261): a schedule fire is a root `scheduled` trigger; an event
        // trigger reuses the `hook` origin (its E1 badge surface) — both depth 0.
        origin: isSchedule ? "scheduled" : "hook",
        depth: 0,
        // A per-trigger `run.maxSpawnDepth` (design §2.3, T2) gates this fire's self-MCP
        // spawn capability; it wins over the project override, which wins over the
        // instance default (reuses B1's resolver).
        maxSpawnDepth: resolveMaxSpawnDepth(
          trigger.run.maxSpawnDepth ?? project.maxSpawnDepth,
          deps.cfg.maxSpawnDepth,
        ),
        // Attribute the injected kickoff turn to the trigger that fired it (#290).
        sender: {
          kind: isSchedule ? "schedule" : "hook",
          name: trigger.name,
          project: slug,
        },
      });
      // First fire of an accreting trigger: remember the chat it created so the next
      // fire resumes THIS transcript (a resume already had an id).
      if (trigger.run.session === "resume" && !resume && deps.triggerSessions) {
        await deps.triggerSessions.set(slug, trigger.name, sessionId).catch(() => undefined);
      }
      return sessionId;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a project's ENABLED event triggers for `event` and fire each (after-commit,
   * non-blocking — the trigger analogue of {@link dispatchHooks}). Concurrent +
   * independent; one trigger's failure never affects another. No-op when the trigger
   * system isn't wired ({@link makeChatHandler} dep `triggers` absent) or the project
   * has no matching enabled event trigger.
   */
  async function dispatchEventTriggers(
    slug: string,
    event: TriggerEvent,
    ctx: TriggerEventContext,
  ): Promise<void> {
    if (!deps.triggers) return;
    const project = await deps.projects.get(slug).catch(() => null);
    if (!project) return;
    const matching = await deps.triggers.enabledForEvent(slug, event).catch(() => []);
    await Promise.all(matching.map((trigger) => fireTriggerForProject(project, trigger, ctx)));
  }

  // Dispatch enabled EVENT triggers on the SAME lifecycle events hooks fire on — the
  // event-bus supports multiple listeners, so this rides alongside the hook dispatcher
  // (they read disjoint config blocks). onArchive is the wired event; afterTurn is
  // reserved for the sweeper fold-in (T5) and not emitted yet.
  deps.events?.on("onArchive", (payload) => {
    void dispatchEventTriggers(payload.slug, "onArchive", { sessionId: payload.sessionId });
  });

  /**
   * Signal a completed turn's post-turn CURATION (Epic T / T5) — the sweeper, folded in
   * as the default `curate-overview` (event/afterTurn) trigger. Emits the `afterTurn`
   * lifecycle event so the curator dispatches EXACTLY ONCE per turn (its enabled gate +
   * per-project prompt extension resolved inside SweepService). Scratch never curates.
   * Falls back to a direct `sweep.enqueue` when the event bus isn't wired (older
   * callers / tests), so behaviour is identical with or without the bus. Called from
   * every post-turn commit site (a human chat turn, a session-mode wake, and every
   * server-initiated `startAgentTurn`) — the ONE place the sweeper is now triggered.
   */
  function emitAfterTurn(slug: string, sessionId: string | null): void {
    if (slug === SCRATCH_SLUG) return;
    if (deps.events) deps.events.emit("afterTurn", { slug, sessionId });
    else deps.sweep?.enqueue(slug);
  }

  // The folded-in sweeper (T5): `afterTurn` drives the default post-turn curator. Unlike
  // `onArchive`, afterTurn is NOT fanned out to generic `trigger-<slug>-<name>` agents —
  // the curator is tool-less and executed by SweepService (returns marked text, Paddock
  // writes OVERVIEW.md/CHANGELOG.md). So this is the SOLE afterTurn consumer, which is
  // what guarantees the sweeper runs exactly once per turn (no double-curation).
  deps.events?.on("afterTurn", (payload) => {
    if (payload.slug === SCRATCH_SLUG) return;
    deps.sweep?.enqueue(payload.slug);
  });

  /**
   * Fire a schedule-type TRIGGER now (Epic T / T1), reused by the "trigger now" REST
   * route (T3/T4) and shared with the cron path below. Resolves the live project + its
   * trigger record and fires via {@link fireTriggerForProject}. Returns the started
   * chat's session id, or `null` if the project/trigger is gone or not a schedule
   * trigger, or the turn never produced a session.
   */
  async function fireTrigger(slug: string, triggerName: string): Promise<string | null> {
    const project = await deps.projects.get(slug).catch(() => null);
    if (!project) return null;
    const rec = project.triggers?.[triggerName];
    if (!rec || rec.trigger.type !== "schedule") return null;
    return fireTriggerForProject(project, { name: triggerName, agentName: triggerAgentName(slug, triggerName), ...rec });
  }

  /**
   * Compose the OVERVIEW.md + CHANGELOG.md preload block onto `baseMessage` for
   * a NEW chat (issues #1/#188), shared (C2 / #264) by the human New-Chat path
   * and the self-MCP `create_chat` spawn path so both inject the SAME context.
   * Injects only when the project has an OVERVIEW.md (the signal that a sweep
   * has curated real state); when it fires it prepends BOTH the overview
   * (current state) AND the CHANGELOG.md (cross-session history), matching the
   * UI checkbox. Returns `baseMessage` unchanged when there's no overview yet.
   */
  async function composePreloadedPrompt(projectSlug: string, baseMessage: string): Promise<string> {
    const overview = await deps.projects.readOverview(projectSlug).catch(() => "");
    if (overview.trim().length === 0) return baseMessage;
    const changelog = await deps.projects.readChangelog(projectSlug).catch(() => "");
    // Single-sourced wrapper (see preload.ts) so the chat-list can strip it back
    // off for display (issue #62).
    return wrapPreload(composePreloadContext(overview, changelog), baseMessage);
  }

  /**
   * Build the self-management MCP server def (issue #214) bound to one turn's
   * context, extracted (B1 / #262) so BOTH the human socket path AND the
   * server-initiated {@link startAgentTurn} spawn path share ONE builder.
   *
   * The READ tools (list_projects/list_chats/read_chat) close over turn-independent
   * services and are always present. When `includeWrite` is set, the four WRITE
   * tools (create/fork/message/fork_batch) are appended; each starts a real keeper
   * turn via {@link startAgentTurn}.
   *
   * `parentProvenance` is the provenance of the chat these tools run IN — so any
   * child they spawn is `childOf(parentProvenance)` (origin `spawned`, depth+1).
   * The human path passes {@link HUMAN_ROOT} (depth 0 → children depth 1); the
   * spawned path passes the current turn's own `{ origin, depth }` (so a depth-1
   * child's children are depth 2, and the `maxSpawnDepth` bound descends). The
   * child's `maxSpawnDepth` is resolved from ITS target project (override else
   * instance default), so the bound follows the project a child actually runs in.
   */
  function buildSelfMcpServerDef(params: {
    currentProjectSlug: string;
    currentSessionId: () => string | null;
    parentProvenance: RunProvenance;
    includeWrite: boolean;
    /**
     * Whether to additionally append the Epic T / T3 unified trigger-management
     * tools (list/set/remove_trigger). Resolved per-project by the caller from the
     * REUSED hooks-MCP gate (`hooksMcpEnabled` override else instance default). Only
     * meaningful when `includeWrite` is on — the trigger tools live in the write block.
     */
    includeTriggers: boolean;
  }): InjectedMcpServerDef {
    const { currentProjectSlug, currentSessionId, parentProvenance, includeWrite, includeTriggers } =
      params;

    const selfMcpContext: SelfMcpContext = {
      listProjects: async () => {
        const projects = await deps.projects.list();
        return projects.map((p) => ({
          slug: p.slug,
          name: p.name,
          area: p.group && p.group.length > 0 ? p.group : undefined,
          status: p.status,
        }));
      },
      listChats: async (projectSlug) => {
        const targets = projectSlug
          ? [await deps.projects.get(projectSlug)]
          : await deps.projects.list();
        const chats = [];
        for (const p of targets) {
          const sessions = await deps.herdctl.listSessions(p);
          for (const s of sessions) {
            chats.push({
              project: p.slug,
              sessionId: s.sessionId,
              name: s.customName ?? s.autoName ?? s.sessionId.slice(0, 8),
              updatedAt: s.mtime,
              running: hub.isRunning(s.sessionId),
            });
          }
        }
        return chats;
      },
      readChat: async (projectSlug, chatSessionId) => {
        const project = await deps.projects.get(projectSlug);
        const messages = await deps.herdctl.sessionMessages(
          keeperAgentName(project.slug),
          chatSessionId,
        );
        return messages.map((m) => ({
          role: m.role,
          text: m.content,
          timestamp: m.timestamp,
        }));
      },
    };

    // Write tools (issue #214 Phase 2) are gated by the caller (`includeWrite`).
    // Each callback resolves the target project (validating it exists), then starts
    // a real keeper turn via startAgentTurn — which streams through the shared hub,
    // so a spawned chat appears + streams live exactly like a human-started one.
    let writeCtx: SelfMcpWriteContext | undefined;
    if (includeWrite) {
      const driveModeFor = (p: Awaited<ReturnType<typeof deps.projects.get>>): DriveMode =>
        p.driveMode && isKnownDriveMode(p.driveMode) ? p.driveMode : deps.cfg.keeperDriveMode;
      // The child runs in its TARGET project, so its spawn bound comes from THAT
      // project's override (else the instance default), not the parent's (#262).
      const maxSpawnDepthFor = (p: Awaited<ReturnType<typeof deps.projects.get>>): number =>
        resolveMaxSpawnDepth(p.maxSpawnDepth, deps.cfg.maxSpawnDepth);
      // A child spawned from this chat is one hop deeper (origin spawned, depth+1);
      // see the method doc for why `parentProvenance` (not always HUMAN_ROOT).
      const spawnedChild: RunProvenance = childOf(parentProvenance);
      // #290: the SENDER of any message these tools inject is THIS chat (the one
      // calling the tool). Resolve its display name at injection time (best effort)
      // so the recipient's history can say "↩ sent by <name>" and deep-link back.
      const senderForCurrentChat = async (): Promise<MessageSender> => {
        const sid = currentSessionId();
        if (!sid) return { kind: "agent" };
        let name: string | undefined;
        try {
          const cur = await deps.projects.get(currentProjectSlug);
          const sessions = await deps.herdctl.listSessions(cur);
          const found = sessions.find((s) => s.sessionId === sid);
          name = found?.customName ?? found?.autoName ?? undefined;
        } catch {
          /* name is best-effort — the link still resolves without it */
        }
        return { kind: "chat", project: currentProjectSlug, sessionId: sid, name };
      };
      writeCtx = {
        currentProjectSlug,
        currentSessionId,
        createChat: async (projectSlug, kickoff, o) => {
          const p = await deps.projects.get(projectSlug);
          // Honor the same OVERVIEW+CHANGELOG preload the human New-Chat path
          // offers, when asked and available (issues #1/#188).
          const composed = o?.preloadContext
            ? await composePreloadedPrompt(projectSlug, kickoff)
            : kickoff;
          // Per-chat model override (#336): a valid requested model wins, else the
          // project default. Re-register the (shared) keeper at it BEFORE the turn —
          // the SAME mechanism (and single-user last-write-wins caveat) as the human
          // model picker (see ensureKeeperModel). The handler already validated it;
          // guard again defensively so an unknown id falls back, never reaches the fleet.
          const overrideModel = o?.model && isKnownModel(o.model) ? o.model : undefined;
          if (overrideModel) await deps.herdctl.ensureKeeperModel(p, overrideModel);
          const newId = await startAgentTurn({
            projectSlug,
            agentName: keeperAgentName(projectSlug),
            workingDir: p.workingDir,
            resume: null,
            prompt: composed,
            driveMode: driveModeFor(p),
            fallbackModel: overrideModel ?? p.model,
            origin: spawnedChild.origin,
            depth: spawnedChild.depth,
            maxSpawnDepth: maxSpawnDepthFor(p),
            sender: await senderForCurrentChat(),
          });
          // Apply the caller-supplied display name (C2 / #264). Without this the
          // `name` param was silently dropped and the title fell back to
          // Claude's ~15-word auto-summary. Mirrors forkSession's rename: best
          // effort, keyed by the target project's keeper agent.
          if (o?.name) {
            await deps.herdctl
              .renameSession(keeperAgentName(projectSlug), newId, o.name)
              .catch(() => undefined);
          }
          return { sessionId: newId };
        },
        forkChat: async ({ projectSlug, sourceSessionId, prompt: kickoff, name, model }) => {
          const p = await deps.projects.get(projectSlug);
          if (!(await deps.herdctl.sessionExists(p, sourceSessionId))) {
            throw new Error(`chat not found: ${sourceSessionId} in project ${projectSlug}`);
          }
          const newId = await deps.herdctl.forkSession(p, sourceSessionId, name);
          // Stamp the forked CHILD's provenance here (not via startAgentTurn,
          // which only stamps a brand-new `resume:null` chat): a fork with no
          // kickoff never calls startAgentTurn, so this covers both cases.
          await deps.runProvenance?.stamp(newId, spawnedChild).catch(() => undefined);
          if (kickoff && kickoff.trim().length > 0) {
            // Per-chat model override (#336): applies to the kickoff turn only (a
            // fork with no kickoff runs no turn). Same shared-keeper re-registration
            // + last-write-wins caveat as the human picker; handler pre-validated,
            // guard again so an unknown id falls back to the project default.
            const overrideModel = model && isKnownModel(model) ? model : undefined;
            if (overrideModel) await deps.herdctl.ensureKeeperModel(p, overrideModel);
            await startAgentTurn({
              projectSlug,
              agentName: keeperAgentName(projectSlug),
              workingDir: p.workingDir,
              resume: newId,
              // Frame the kickoff so the child treats the inherited transcript as
              // CONTEXT and runs its new directive. Without this, forking the
              // *live* chat snapshots it mid-turn, so the child inherits the
              // parent's "I'm mid-task" identity and may refuse the seed prompt
              // (QA #214). This is what makes the fan-out use case ("fork this
              // chat N times, one item each") actually work.
              prompt: forkKickoffPrompt(kickoff),
              driveMode: driveModeFor(p),
              fallbackModel: overrideModel ?? p.model,
              // Resume of the just-forked child: the child was already stamped
              // above, so startAgentTurn won't re-stamp; this just describes the
              // kickoff run honestly. Its self-MCP is gated on the child's own
              // recorded depth (the stamp above), resolved in startAgentTurn.
              origin: spawnedChild.origin,
              depth: spawnedChild.depth,
              maxSpawnDepth: maxSpawnDepthFor(p),
              sender: await senderForCurrentChat(),
            });
          }
          return { sessionId: newId };
        },
        sendMessage: async (projectSlug, targetSessionId, kickoff) => {
          const p = await deps.projects.get(projectSlug);
          if (!(await deps.herdctl.sessionExists(p, targetSessionId))) {
            throw new Error(`chat not found: ${targetSessionId} in project ${projectSlug}`);
          }
          await startAgentTurn({
            projectSlug,
            agentName: keeperAgentName(projectSlug),
            workingDir: p.workingDir,
            resume: targetSessionId,
            prompt: kickoff,
            driveMode: driveModeFor(p),
            fallbackModel: p.model,
            // Resume of an EXISTING chat: startAgentTurn won't stamp (only new
            // chats are stamped), so the target keeps its own creation provenance,
            // and its self-MCP is gated on THAT recorded depth (resolved in
            // startAgentTurn), not on these describe-the-run values.
            origin: spawnedChild.origin,
            depth: spawnedChild.depth,
            maxSpawnDepth: maxSpawnDepthFor(p),
            // #290: this injects into an EXISTING chat, so startAgentTurn also
            // emits a live `chat:injected` frame — the recipient (if open) sees
            // the "↩ sent by <this chat>" user bubble without a refresh (Part 2).
            sender: await senderForCurrentChat(),
          });
        },
        // C1 (#263). Archive/unarchive is presentational metadata only — no turn
        // is started — so it delegates straight to the ArchiveStore, keyed by the
        // target project's agent (mirrors the POST archive endpoints in
        // routes.ts). Enables the "work → archive myself on success" self-reporting
        // convention. `deps.projects.get` validates the slug (throws not_found),
        // matching the other write callbacks.
        setArchived: async (projectSlug, targetSessionId, archived) => {
          await deps.projects.get(projectSlug);
          const changed = await deps.archive.setArchived(
            keeperAgentName(projectSlug),
            targetSessionId,
            archived,
          );
          // Epic G / G1: after the archive COMMITS, emit the `onArchive` lifecycle
          // event (only on a real transition INTO archived) so the dispatcher fires
          // the project's enabled onArchive hooks. This is THE motivating path — a
          // keeper archiving ITSELF on success then triggers its cleanup hook. emit is
          // fire-and-forget, so it never blocks/fails the self-MCP archive tool.
          if (changed && archived) {
            deps.events?.emit("onArchive", { slug: projectSlug, sessionId: targetSessionId });
          }
        },
        // Unified trigger management (Epic T / T3). Delegates to the shared T1
        // TriggerService (persist to project.yaml's single `triggers` block, then
        // arm — an event trigger's own `trigger-<slug>-<name>` agent, a schedule
        // trigger's forwarded `schedules` entry) — the SAME two-step the REST routes
        // + Triggers tab (T4) use. The tools are only INJECTED when `includeTriggers`
        // (the project's REUSED hooks-MCP opt-in) is on, so this flag reflects that
        // resolved gate; the callbacks are wired unconditionally. Collapses the former
        // schedule (#289) + hook (G5) callbacks onto ONE service.
        triggersMcpEnabled: includeTriggers,
        listTriggers: async (projectSlug) => {
          if (!deps.triggers) return [];
          const dtos = await deps.triggers.list(projectSlug);
          // Merge best-effort live runtime state for SCHEDULE triggers (keyed by
          // trigger name — the same key the forwarded `schedules` block uses).
          const p = await deps.projects.get(projectSlug).catch(() => null);
          const runtime = p ? await deps.herdctl.listAgentSchedules(p).catch(() => []) : [];
          const byName = new Map(runtime.map((s) => [s.name, s]));
          return dtos.map((dto) => toSelfMcpTrigger(dto, byName.get(dto.name)));
        },
        setTrigger: async (projectSlug, name, incoming) => {
          if (!deps.triggers) throw new Error("trigger management is unavailable");
          // `set_trigger` is a PARTIAL update, but persistence full-REPLACES the named
          // record — so an edit that omits a field would silently wipe it (e.g. an
          // enable-only flip dropping the run). mergeTriggerUpdate overlays the caller-
          // supplied fields on the existing trigger (preserving omitted trigger/run/
          // enabled, clearing the prompt/promptFile counterpart) and safe-creates a new
          // trigger disabled — then TriggerService.set validates + arms.
          const existing = await deps.triggers.get(projectSlug, name).catch(() => null);
          const record = mergeTriggerUpdate(existing, incoming);
          const dto = await deps.triggers.set(projectSlug, name, record);
          // Best-effort runtime state for a schedule trigger it may have just armed.
          const p = await deps.projects.get(projectSlug).catch(() => null);
          const runtime = p ? await deps.herdctl.listAgentSchedules(p).catch(() => []) : [];
          const info = runtime.find((s) => s.name === name);
          return toSelfMcpTrigger(dto, info);
        },
        removeTrigger: async (projectSlug, name) => {
          if (!deps.triggers) return false;
          return deps.triggers.remove(projectSlug, name);
        },
      };
    }

    return selfMcpServerDef(selfMcpContext, writeCtx);
  }

  // ── Wake-time injected-MCP re-establishment (edspencer/herdctl#390) ──────────
  // The single injection-policy context, shared by the live `startAgentTurn` path
  // (below) AND the wake rebuild, so the two can never drift. See wake-injection.ts.
  const injectionBuildCtx: InjectedMcpBuildContext = {
    scratchSlug: SCRATCH_SLUG,
    cfg: deps.cfg,
    saveAttachment: (bytes, name) => deps.attachments.save(bytes, name),
    // Optional, mirroring the optional `runProvenance` dep: absent ⇒ the caller's
    // `depth` is used unchanged (identical to the pre-extraction inline behaviour).
    getProvenance: deps.runProvenance ? (id) => deps.runProvenance!.get(id) : undefined,
    getProjectHooksMcp: async (slug) => {
      const tp = await deps.projects.get(slug).catch(() => null);
      return tp?.hooksMcpEnabled;
    },
    buildSelfMcp: buildSelfMcpServerDef,
  };

  /** Build one turn's injected servers via the shared policy (see wake-injection.ts). */
  function buildInjection(
    args: InjectedMcpBuildArgs,
  ): Promise<Record<string, InjectedMcpServerDef>> {
    return buildInjectedMcpServers(args, injectionBuildCtx);
  }

  // Rebuild a woken session's injection from scratch (cold-cache warm after a server
  // restart, when the live-turn cache is empty). Resolves the project (scratch/unknown
  // ⇒ no injection) then delegates to the shared builder; the resume gates self-MCP on
  // the chat's OWN recorded depth. Never throws (the cache also catches defensively).
  const rebuildWakeInjection = async (
    entry: SessionWakeEntry,
  ): Promise<Record<string, InjectedMcpServerDef> | undefined> => {
    const slug = keeperSlugFromAgent(entry.agent);
    if (!slug || slug === SCRATCH_SLUG) return undefined;
    let project: Awaited<ReturnType<typeof deps.projects.get>>;
    try {
      project = await deps.projects.get(slug);
    } catch {
      return undefined; // unknown/deleted project — nothing to inject
    }
    return buildInjection({
      projectSlug: slug,
      workingDir: project.workingDir,
      resume: entry.sessionId,
      // `origin` only feeds child provenance via `childOf` (which forces "spawned"),
      // so its value is behaviourally irrelevant here; "scheduled" matches a wake root.
      origin: "scheduled",
      depth: 0,
      maxSpawnDepth: resolveMaxSpawnDepth(project.maxSpawnDepth, deps.cfg.maxSpawnDepth),
      currentSessionId: () => entry.sessionId,
    });
  };

  // The cache/resolver. `wakeInjection.remember` is called on every live turn (the
  // human socket path and `startAgentTurn`), so a session that self-schedules a wake
  // is warm when it fires. herdctl calls `wakeInjection.resolve` synchronously on each
  // wake fire — paired with `onSessionWake` above (which streams the woken turn), this
  // re-establishes the injected MCP servers the woken subprocess would otherwise spawn
  // WITHOUT, closing the "MCP flap". Registered here (rather than at the onSessionWake
  // call site) so it sits beside the builder + cache it depends on.
  const wakeInjection = createWakeInjectionCache({ rebuild: rebuildWakeInjection });
  deps.herdctl.setResolveInjectedMcpServers((entry) => wakeInjection.resolve(entry));

  /**
   * Kick off a keeper turn that is NOT driven by a socket — used by the
   * self-management MCP write tools (issue #214 Phase 2: create_chat / fork_chat /
   * send_message / fork_chat_batch fan-out). Routes the turn through the SAME
   * shared {@link hub} as socket-driven turns, so a spawned chat streams live to
   * any client viewing it, flips the sidebar running indicator (hub.onActive
   * broadcast), and is re-attachable — full parity with a human-started turn,
   * just with no originating socket (origin `null`).
   *
   * Returns a promise that resolves with the chat's sessionId AS SOON AS it is
   * known (immediately for a resumed/forked id; on the first streamed session_id
   * for a brand-new chat), while the turn itself runs to completion in the
   * BACKGROUND (detached). So a fan-out can fire N of these and collect N ids
   * without waiting for any child turn to finish; herdctl's own max-concurrency
   * throttles how many actually run at once. Rejects if the turn errors (or a
   * timeout elapses) before an id is known.
   *
   * The spawned turn always gets `send_file`, and — NEW in B1 (#262) — it ALSO
   * gets the self-management MCP (including the WRITE tools, so `send_message`
   * exists and a child can finally report back to its parent) when its depth is
   * within `maxSpawnDepth`. The fork-bomb bound is now EXPLICIT: a turn running in
   * a chat at depth `d` gets the tools iff `d <= maxSpawnDepth` (see
   * spawn-capability.ts). `maxSpawnDepth = 0` reproduces the old behaviour exactly
   * (send_file only). Every child spawned by a tool-equipped turn is stamped one
   * hop deeper, so the bound descends and the tree can't run away. A resume runs
   * in an EXISTING chat, so its capability is gated on THAT chat's own recorded
   * depth (from {@link RunProvenanceStore}), not on the caller's describe-the-run
   * `depth`. A human who later opens a spawned chat still gets the full tools via
   * the regular socket path (any keeper chat may use them) — unchanged.
   */
  async function startAgentTurn(opts: {
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
     * a turn with no attributable non-human sender. When set, the injected prompt is
     * recorded in the per-message provenance store (so the chat history can label
     * it) and — for an injection into an EXISTING chat (`resume`) — a `chat:injected`
     * frame is emitted so a client already viewing the recipient sees the user turn
     * live, not just the assistant reply (Part 2).
     */
    sender?: MessageSender;
  }): Promise<string> {
    const { projectSlug, agentName, workingDir, resume, prompt, driveMode, fallbackModel, origin, depth, maxSpawnDepth, sender } =
      opts;
    let resolvedSession: string | null = resume ?? null;
    let jobId: string | null = null;
    let attributed = false;
    const isNewChat = resume === null;
    const turn: TurnHandle = hub.startTurn(projectSlug, null, resume ?? null);
    const seen: { usage: TurnUsage | null; model: string | null } = { usage: null, model: null };

    const routing = (): Routing => ({
      projectSlug,
      target: projectSlug,
      sessionId: resolvedSession,
      jobId,
    });

    // Per-message provenance (issue #290). Once the TARGET session id is known,
    // record the injected prompt + its sender so a later transcript load can
    // attribute the machine-added user turn (see message-provenance.ts). For an
    // injection into an EXISTING chat we ALSO emit a `chat:injected` frame so a
    // client currently viewing the recipient renders the injected user bubble live
    // (Part 2) — a fresh/new chat has no established viewer, and opening it later
    // hydrates the labelled turn from history, so we skip the live emit there to
    // avoid a replay double-add. Fires at most once per turn.
    let injectionHandled = false;
    const handleInjection = (id: string): void => {
      if (injectionHandled || !sender) return;
      injectionHandled = true;
      void deps.messageProvenance?.record(id, sender, prompt).catch(() => undefined);
      if (resume !== null) {
        turn.emit({
          type: "chat:injected",
          payload: {
            projectSlug,
            target: projectSlug,
            sessionId: id,
            jobId,
            sender,
            content: prompt,
            timestamp: new Date().toISOString(),
          },
        });
      }
    };
    // A resume already knows its target session id — stamp/emit up front so the
    // injected bubble precedes the assistant's streamed reply.
    if (resume !== null) handleInjection(resume);
    const translate = createSDKMessageHandler({
      onText: (chunk) => {
        if (chunk) turn.emit({ type: "chat:response", payload: { ...routing(), chunk } });
      },
      onBoundary: () => {
        turn.emit({ type: "chat:message_boundary", payload: routing() });
      },
      onToolStart: (start) => {
        turn.emit({
          type: "chat:tool_start",
          payload: {
            ...routing(),
            toolName: start.toolName,
            inputSummary: start.inputSummary,
            toolUseId: start.toolUseId,
            parentToolUseId: start.parentToolUseId,
          },
        });
      },
      onToolCall: (call) => {
        turn.emit({
          type: "chat:tool_call",
          payload: {
            ...routing(),
            toolName: call.toolName,
            inputSummary: call.inputSummary,
            output: call.output,
            isError: call.isError,
            durationMs: call.durationMs,
            toolUseId: call.toolUseId,
          },
        });
      },
    });

    // Build this turn's injected MCP servers via the shared policy (send_file always;
    // depth-gated self-MCP, #262/DD-3). Extracted so the wake resolver (#390) rebuilds
    // the IDENTICAL set — see wake-injection.ts. A RESUME gates self-MCP on the chat's
    // OWN recorded depth (resolved inside the builder); `currentSessionId` is late-bound
    // to `resolvedSession` so the self-MCP write tools attribute against the live id.
    const injectedMcpServers = await buildInjection({
      projectSlug,
      workingDir,
      resume,
      origin,
      depth,
      maxSpawnDepth,
      currentSessionId: () => resolvedSession,
    });

    const drive =
      driveMode === "session"
        ? deps.herdctl.chatSession.bind(deps.herdctl)
        : deps.herdctl.chat.bind(deps.herdctl);

    // Resolve the sessionId early; the caller returns it while the turn continues.
    let resolveId!: (id: string) => void;
    let rejectId!: (err: Error) => void;
    const idKnown = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    if (resume) resolveId(resume);

    const drivePromise = drive(agentName, {
      prompt,
      // herdctl's TriggerTypeSchema is a strict enum (manual|schedule|webhook|
      // chat|discord|slack|web|fork); "agent" is NOT a member, so it fails job
      // validation and the whole spawn errors out — which is why a spawned child
      // could never be created against this core version. Use "manual" (the
      // documented API/CLI-initiated value) until herdctl adds a first-class
      // `spawned` trigger type (DD-6 / herdctl#377); provenance is carried by
      // RunProvenanceStore (origin/depth), not by this field.
      triggerType: "manual",
      resume,
      injectedMcpServers,
      onJobCreated: (id) => {
        jobId = id;
        turn.setJobId(id);
      },
      onMessage: async (m: SDKMessage) => {
        if (m.session_id) {
          resolvedSession = m.session_id;
          // #390: remember this turn's injected servers so a later wake of this
          // session replays them (closes the flap on the common self-schedule case).
          wakeInjection.remember(m.session_id, injectedMcpServers);
          if (isNewChat && !attributed) {
            attributed = true;
            await deps.herdctl.attributeRunningSession(m.session_id, agentName).catch(() => undefined);
            // A1 (#261): stamp the NEW chat's provenance (e.g. create_chat →
            // spawned, depth = parent+1) so #262 can depth-gate and #267 can
            // badge it. Only a new chat is stamped here; a resume/message target
            // (fork kickoff, send_message) keeps its own creation provenance.
            await deps.runProvenance
              ?.stamp(m.session_id, { origin, depth })
              .catch(() => undefined);
            // #290: record the kickoff's sender for the NEW chat now that its id
            // is known (no live emit — see handleInjection; the labelled turn
            // hydrates from history when the chat is opened).
            handleInjection(m.session_id);
          }
          turn.setSession(m.session_id);
          resolveId(m.session_id);
        }
        const ex = extractUsage(m);
        if (ex.usage) seen.usage = pickTurnUsage(seen.usage, ex.usage);
        if (ex.model) seen.model = ex.model;
        await translate(m as unknown as ChatSDKMessage);
      },
    });

    // Detached completion: emit the terminal frame + end the hub turn no matter
    // what. Never throws to the event loop (guards the fan-out from one bad turn).
    void drivePromise
      .then((result) => {
        const finalSession =
          (result.success ? (result.sessionId ?? resolvedSession) : resolvedSession) ?? null;
        if (finalSession) turn.setSession(finalSession);
        const completeModel = seen.model ?? fallbackModel;
        const u = seen.usage;
        const completeUsage: ChatCompleteUsage | undefined = u
          ? {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheCreationTokens: u.cacheCreationTokens,
              contextTokens: u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens,
              contextLimit: getContextLimit(completeModel),
            }
          : undefined;
        turn.emit({
          type: "chat:complete",
          payload: {
            ...routing(),
            sessionId: finalSession,
            jobId: result.jobId ?? jobId,
            success: result.success,
            error: result.error?.message,
            ...(completeUsage ? { model: completeModel, usage: completeUsage } : {}),
          },
        });
        turn.end();
        try {
          deps.herdctl.invalidateSessions(agentName);
        } catch {
          /* non-fatal */
        }
        // T5: post-turn curation via the `afterTurn` event (folded-in sweeper).
        if (result.success) emitAfterTurn(projectSlug, finalSession);
        // Layer 3 (issue #301): arm a post-turn recovery watch for a session-mode
        // keeper turn that stayed alive — including a recovery re-drive itself, so a
        // re-drive that hangs again is caught (bounded by the per-session retry cap).
        if (result.success && finalSession && driveMode === "session" && projectSlug !== SCRATCH_SLUG) {
          recoveryEngine.armWatch({ slug: projectSlug, sessionId: finalSession });
        }
        if (!resolvedSession) {
          rejectId(new Error(result.error?.message ?? "turn ended with no session id"));
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        turn.emit({
          type: "chat:complete",
          payload: { ...routing(), sessionId: resolvedSession, jobId, success: false, error },
        });
        turn.end();
        rejectId(err instanceof Error ? err : new Error(error));
      });

    // Never hang the calling tool forever if the child never streams an id.
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("timed out waiting for spawned chat to start")), 60_000),
    );
    return Promise.race([idKnown, timeout]);
  }

  /**
   * Sessions with a recovery nudge dispatch in flight (issue #352 double-dispatch
   * guard). A resume of a still-in-flight session-mode chat interrupts and swallows
   * the prior resume, so we never let two recovery/Continue dispatches for the same
   * session overlap. Set synchronously the moment a nudge is dispatched (before the
   * `sessionExists` await), cleared once the turn has started; `hub.isRunning` then
   * carries the guard for the turn's lifetime.
   */
  const injectingRecovery = new Set<string>();

  /**
   * Inject the keeper-chat recovery nudge into a still-alive session (issue #301) —
   * the ONE shared path behind both the manual Layer 2 "Continue" (`chat:continue`)
   * and the Layer 3 automatic re-drive ({@link RecoveryEngine}). Re-drives the
   * hung keeper via {@link startAgentTurn} with the {@link RECOVERY_NUDGE} and a
   * `recovery` sender, exactly the message a human sends by hand to unstick it.
   * No-op for scratch (no keeper) or a session that no longer exists. The gate on
   * WHICH layer may call this lives in each caller (surfaceKilledTask vs
   * autoReDrive); this helper is layer-agnostic.
   */
  const injectRecoveryNudge = async (project: Project, sessionId: string): Promise<void> => {
    const slug = project.slug;
    if (!slug || slug === SCRATCH_SLUG) return;
    // Single-flight double-dispatch guard (issue #352). Two dispatches resuming the
    // SAME session at once is fatal under session-mode `chatSession(resume)`: the
    // second resume interrupts the first, so one nudge is swallowed ("first message
    // swallowed", #350/#347). A turn already running for this session (a human send,
    // a queued-message drain, or a Continue click) means the keeper is not idle —
    // yield to it. And `injectingRecovery` closes the async gap below (the
    // `sessionExists` await) so two near-simultaneous recovery/Continue calls can't
    // both get past this check before either registers its turn as running.
    if (injectingRecovery.has(sessionId) || hub.isRunning(sessionId)) {
      return;
    }
    injectingRecovery.add(sessionId);
    try {
      // Only re-drive a real, existing session (a live kept-alive keeper chat).
      if (!(await deps.herdctl.sessionExists(project, sessionId).catch(() => false))) return;
      const driveMode =
        project.driveMode && isKnownDriveMode(project.driveMode)
          ? project.driveMode
          : deps.cfg.keeperDriveMode;
      await startAgentTurn({
        projectSlug: slug,
        agentName: keeperAgentName(slug),
        workingDir: project.workingDir,
        resume: sessionId,
        prompt: RECOVERY_NUDGE,
        driveMode,
        fallbackModel: project.model,
        // A resume never re-stamps provenance (only new chats are stamped), so these
        // describe-the-run values aren't persisted — the target keeps its own marker
        // and its self-MCP is gated on THAT recorded depth. Describe it as a
        // human-rooted run (matches the Layer 2 manual Continue path).
        origin: "human",
        depth: 0,
        maxSpawnDepth: resolveMaxSpawnDepth(project.maxSpawnDepth, deps.cfg.maxSpawnDepth),
        // #290 / #301: attribute the injected nudge to Paddock recovery so the history
        // renders "⚠ continued after a background task was terminated" and emits a live
        // chat:injected frame to any attached viewer.
        sender: { kind: "recovery" },
      });
    } finally {
      // Clear the single-flight mark once the turn has STARTED (startAgentTurn
      // resolves as soon as the session id is known — for a resume, immediately —
      // by which point `hub.isRunning(sessionId)` is true and takes over the guard).
      injectingRecovery.delete(sessionId);
    }
  };

  /**
   * Layer 3 automatic-recovery engine (issue #301). After each session-mode keeper
   * turn completes (armed at the completion sites below), it tails the transcript;
   * if a background task was killed at the turn boundary and the keeper doesn't wake
   * on its own, it auto-injects the recovery nudge — guarded by the resolved
   * `recovery.autoReDrive` flag (default OFF), a debounce window, and a per-session
   * retry cap. Re-drive reuses the exact {@link injectRecoveryNudge} path as the
   * manual Continue; a human message ({@link RecoveryEngine.onHumanMessage}) resets
   * a session's guard so a later genuine hang recovers fresh.
   */
  const recoveryEngine = new RecoveryEngine({
    cfg: { recovery: deps.cfg.recovery },
    getProject: (slug) => deps.projects.get(slug),
    reDrive: (project, sessionId) => injectRecoveryNudge(project, sessionId),
    // #352: a live turn on this session means the keeper isn't idle — the watch
    // stands down rather than surface a stale "idle" banner or fire a re-drive that
    // would interrupt (and be swallowed by) the in-flight turn. `injectRecoveryNudge`
    // holds the same guard for the recovery path's own dispatch window.
    isBusy: (sessionId) => hub.isRunning(sessionId),
    // #347: when a background task is killed at the turn boundary, its
    // notification is trapped in the SDK input queue — the client would never
    // render the "keeper is idle" affordance until a refresh flushed it. On
    // detection, broadcast a live frame to any attached socket so the banner +
    // Continue appear immediately. Out-of-band (no live turn), so hub.broadcast.
    surface: (project, sessionId, summary) => {
      hub.broadcast(sessionId, {
        type: "chat:killed_task",
        payload: {
          projectSlug: project.slug,
          target: project.slug,
          sessionId,
          summary: summary ?? "A background task was terminated at the turn boundary.",
          timestamp: new Date().toISOString(),
        },
      });
    },
  });

  const handle = async function handle(socket: WebSocket): Promise<void> {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

    // Register this socket for active-turn broadcasts, and immediately catch it
    // up on which sessions are currently running (so the sidebar dots and a
    // returning pane's Stop button reflect reality from the first paint).
    clients.add(socket);
    for (const info of hub.runningSessions()) send(activeFrame(info));

    // Heartbeat: browsers auto-answer protocol ping frames with a pong, so a
    // client whose TCP has silently died (idle drop, sleep) fails to pong and is
    // terminated on the next tick — freeing server resources and letting the
    // client's own reconnect take over. Cleared when the socket closes.
    let isAlive = true;
    socket.on("pong", () => {
      isAlive = true;
    });
    const heartbeat = setInterval(() => {
      if (!isAlive) {
        socket.terminate();
        return;
      }
      isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, SERVER_PING_INTERVAL_MS);
    socket.on("close", () => {
      clearInterval(heartbeat);
      // Drop this socket from every session fan-out set so the hub stops trying
      // to write to it (a running turn keeps going for other attached sockets).
      hub.unsubscribeSocket(socket);
      clients.delete(socket);
    });

    socket.on("message", (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: "chat:error", payload: { projectSlug: "?", target: "?", error: "Invalid JSON" } });
        return;
      }
      if (!isClientMessage(parsed)) {
        send({ type: "chat:error", payload: { projectSlug: "?", target: "?", error: "Unknown message" } });
        return;
      }
      if (parsed.type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (parsed.type === "chat:cancel") {
        void deps.herdctl.cancel(parsed.payload.jobId).catch(() => undefined);
        return;
      }
      if (parsed.type === "chat:subscribe") {
        onSubscribe(parsed);
        return;
      }
      if (parsed.type === "chat:set_queue") {
        void onSetQueue(parsed);
        return;
      }
      if (parsed.type === "chat:command") {
        void onChatCommand(parsed);
        return;
      }
      if (parsed.type === "chat:continue") {
        void onChatContinue(parsed);
        return;
      }
      void onChatSend(parsed);
    });

    /**
     * Manual keeper recovery (issue #301, Layer 2). Re-drive a hung keeper whose
     * background task was killed at the turn boundary by injecting the recovery
     * nudge into its still-alive session via {@link startAgentTurn} — the same
     * workhorse the self-MCP `send_message` / schedule fires use, so the injected
     * turn streams live, lists in the sidebar, and is attributable
     * (`sender: recovery`). Server-authoritative gate: no-op unless the resolved
     * `recovery.surfaceKilledTask` is on for this project, so a stale/rogue client
     * can't re-drive when the operator disabled Layer 2. Scratch chats have no
     * keeper session to recover, so they're ignored.
     */
    const onChatContinue = async (msg: ChatContinueMessage): Promise<void> => {
      const slug = msg.payload.projectSlug ?? msg.payload.target;
      if (!slug || slug === SCRATCH_SLUG) return;
      const sessionId = msg.payload.sessionId;
      if (!sessionId) return;
      let project: Awaited<ReturnType<typeof deps.projects.get>>;
      try {
        project = await deps.projects.get(slug);
      } catch {
        return; // unknown project — nothing to recover
      }
      // Gate on the resolved Layer 2 flag (per-project override else instance).
      const recovery = resolveRecoveryConfig(project.recovery, deps.cfg.recovery);
      if (!recovery.surfaceKilledTask) return;
      // Re-drive via the shared recovery path (also used by Layer 3 auto-recovery).
      await injectRecoveryNudge(project, sessionId).catch((err) => {
        send({
          type: "chat:error",
          payload: { projectSlug: slug, target: slug, error: `Recovery failed: ${String(err)}` },
        });
      });
    };

    const onSubscribe = (msg: ChatSubscribeMessage): void => {
      const { sessionId, wantReplay, lastSeq } = msg.payload;
      const result = hub.attach(sessionId, socket, {
        wantReplay: wantReplay === true,
        afterSeq: typeof lastSeq === "number" ? lastSeq : -1,
      });
      if (result.status === "resync") {
        send({
          type: "chat:resync",
          payload: { projectSlug: result.projectSlug, target: result.projectSlug, sessionId },
        });
      }
      // Tell a (re)attaching pane whether its session has a live turn, so a chat
      // the user navigated back to restores its Stop button + jobId and streaming
      // indicator immediately — not only once the next frame happens to arrive
      // (issues #52/#53).
      const active = hub.activeInfo(sessionId);
      if (active) send(activeFrame(active));
    };

    // Server-authoritative queue drain (#245): auto-send a persisted queued
    // message as the next turn, exactly once. Called (a) when a turn completes
    // successfully and (b) when a queue is set while the session is idle — a queue
    // that arrived (e.g. via the reconnect outbox) after the turn it was meant to
    // follow already ended. `take` makes the read+clear atomic so the two callers
    // can never both send it; the `lastFlushedTs` marker skips a message already
    // drained (a stale client re-assert on reload) so it isn't sent twice.
    const drainQueue = async (slug: string, sessionId: string): Promise<void> => {
      if (!deps.queuedMessage) return;
      const agent = slug === SCRATCH_SLUG ? SCRATCH_AGENT : keeperAgentName(slug);
      const queued = await deps.queuedMessage.take(agent, sessionId).catch(() => null);
      if (!queued?.text) return;
      const markerKey = `${agent} ${sessionId}`;
      const already = (lastFlushedTs.get(markerKey) ?? 0) >= queued.createdAtMs;
      // Tell every attached client (origin + reconnected sockets) to clear its copy
      // of this message. When we're really sending it, carry the text so the client
      // renders the sent bubble in-transcript; on a stale re-assert we only clear.
      hub.broadcast(sessionId, {
        type: "chat:queued_flushed",
        payload: {
          projectSlug: slug,
          target: slug,
          sessionId,
          ...(already ? {} : { text: queued.text }),
        },
      });
      if (already) return;
      lastFlushedTs.set(markerKey, queued.createdAtMs);
      // Broadcast the flush frame BEFORE kicking the turn so the user bubble renders
      // above the reply. Run it detached, like a human send. A leading-slash queued
      // message is a slash command (e.g. "/compact"): route it through the command
      // path so the CLI dispatches it — matching how the composer sends one live.
      if (queued.text.startsWith("/")) {
        void onChatCommand({
          type: "chat:command",
          payload: { projectSlug: slug, target: slug, command: queued.text, sessionId },
        });
      } else {
        void onChatSend({
          type: "chat:send",
          payload: { projectSlug: slug, target: slug, sessionId, message: queued.text },
        });
      }
    };

    const onSetQueue = async (msg: ChatSetQueueMessage): Promise<void> => {
      if (!deps.queuedMessage) return; // feature disabled
      const slug = (msg.payload.projectSlug ?? msg.payload.target) as string | undefined;
      if (!slug) return;
      const sessionId = msg.payload.sessionId ?? null;
      const text = msg.payload.text ?? null;
      // Determine the agent name for this chat (keeper for project, scratch for one-off)
      const agent = slug === SCRATCH_SLUG ? SCRATCH_AGENT : keeperAgentName(slug);
      if (!sessionId) {
        // New chat: queue isn't stored until the session id exists. The client
        // re-asserts it (with the same ts) once the id resolves, so it persists then.
        return;
      }
      // Store or clear the queued message.
      if (text && text.trim().length > 0) {
        await deps.queuedMessage
          .set(agent, sessionId, { text, createdAtMs: msg.payload.ts ?? Date.now() })
          .catch(() => undefined);
        // If no turn is running, this queue arrived after the turn it was meant to
        // follow already ended — drain it now rather than wait for a completion
        // that won't come (the reported stranding bug, #245).
        if (!hub.isRunning(sessionId)) await drainQueue(slug, sessionId);
      } else {
        await deps.queuedMessage.set(agent, sessionId, null).catch(() => undefined);
      }
    };

    const onChatSend = async (msg: ChatSendMessage): Promise<void> => {
      const slug = readSlug(msg.payload) as string;
      const { message, sessionId, preloadContext, attachments: sentAttachments } = msg.payload;
      const isNewChat = sessionId === undefined || sessionId === null;
      // A genuine human message resets this session's Layer 3 recovery guard (issue
      // #301) and cancels any in-flight watch, so the retry cap counts auto re-drives
      // BETWEEN human messages and a later real hang is recovered fresh.
      if (sessionId) recoveryEngine.onHumanMessage(sessionId);
      let jobId: string | null = null;
      let resolvedSession: string | null = sessionId ?? null;
      // One-shot guard: a brand-new chat is attributed to its agent the instant
      // its session id first streams back, so it lists in the sidebar mid-turn
      // instead of only after the turn completes (issue #100). Resumed chats are
      // already attributed, so this only runs for a new chat.
      let attributed = false;
      // Track this turn in the session hub so its frames fan out to whichever
      // socket(s) are attached — not just this one — and a reconnecting client
      // can re-attach + replay the missed gap (issue #54). A resumed chat's id is
      // known now (re-attachable from frame 0); a new chat registers once the id
      // arrives mid-stream (see turn.setSession below).
      const turn: TurnHandle = hub.startTurn(slug, socket, sessionId ?? null);
      // Per-turn usage + model captured off the SDK stream (last non-null wins).
      // Held on a mutable record (not bare `let`s) so the values assigned inside
      // the streaming callback are visible to control-flow analysis afterwards.
      const seen: { usage: TurnUsage | null; model: string | null } = {
        usage: null,
        model: null,
      };
      // The model the turn will run on; resolved below once we know the target.
      let effectiveModel: string = KEEPER_DEFAULT_MODEL;
      // How this turn is driven (Paddock#111): the global default unless the
      // project overrides it (resolved in the project branch below). Scratch
      // chats have no project, so they always take the global default.
      let driveMode: DriveMode = deps.cfg.keeperDriveMode;
      // The agent's working directory, so the send_file tool can resolve a real
      // `file_path` (and sandbox it). Resolved alongside the agent below.
      let sendFileWorkingDir: string | undefined;

      const routing = (): Routing => ({
        projectSlug: slug,
        target: slug,
        sessionId: resolvedSession,
        jobId,
      });

      // @herdctl/chat's shared translator turns the SDKMessage stream into the
      // three UI events we forward over the socket. Created fresh per turn (it
      // holds per-turn tool-pairing state).
      const translate = createSDKMessageHandler({
        onText: (chunk) => {
          if (chunk) turn.emit({ type: "chat:response", payload: { ...routing(), chunk } });
        },
        onBoundary: () => {
          turn.emit({ type: "chat:message_boundary", payload: routing() });
        },
        onToolStart: (start) => {
          turn.emit({
            type: "chat:tool_start",
            payload: {
              ...routing(),
              toolName: start.toolName,
              inputSummary: start.inputSummary,
              toolUseId: start.toolUseId,
              parentToolUseId: start.parentToolUseId,
            },
          });
        },
        onToolCall: (call) => {
          turn.emit({
            type: "chat:tool_call",
            payload: {
              ...routing(),
              toolName: call.toolName,
              inputSummary: call.inputSummary,
              output: call.output,
              isError: call.isError,
              durationMs: call.durationMs,
              toolUseId: call.toolUseId,
            },
          });
        },
      });

      try {
        // Resolve the agent: "scratch" -> scratch agent; otherwise keeper-<slug>.
        let agentName: string;
        // Effective prompt — may be augmented with the project overview below.
        let prompt = message;
        // Whether this project agent gets the T3 unified trigger-management tools
        // (resolved from the project's REUSED hooks-MCP `hooksMcpEnabled` override
        // else the instance default); stays false for scratch (no self-MCP).
        let includeTriggers = false;
        const requested = msg.payload.model;
        if (slug === SCRATCH_SLUG) {
          agentName = SCRATCH_AGENT;
          sendFileWorkingDir = deps.herdctl.scratchDir;
          // Scratch: honor a valid override, else the keeper default. Re-register
          // the scratch agent at the requested model (no-op if unchanged).
          effectiveModel =
            requested && isKnownModel(requested) ? requested : KEEPER_DEFAULT_MODEL;
          if (requested && isKnownModel(requested)) {
            await deps.herdctl.ensureScratchModel(requested);
          }
        } else {
          // Verifies the project exists (throws if not); we keep the object so
          // we can resolve its model + re-register the keeper for an override.
          const project = await deps.projects.get(slug);
          agentName = keeperAgentName(slug);
          sendFileWorkingDir = project.dir;

          // Project chat: a valid override wins, else the project's model. Then
          // ensure the (shared) keeper is registered at that model before the
          // trigger. NOTE single-user last-write-wins caveat (see herdctl.ts).
          effectiveModel =
            requested && isKnownModel(requested) ? requested : project.model;
          await deps.herdctl.ensureKeeperModel(project, effectiveModel);

          // Per-project driveMode override wins over the global default
          // (Paddock#111). An absent/invalid value inherits the global.
          driveMode =
            project.driveMode && isKnownDriveMode(project.driveMode)
              ? project.driveMode
              : deps.cfg.keeperDriveMode;

          // T3 trigger-management gate (REUSES the hooks-MCP gate): the per-project
          // override wins, else the instance default. Only takes effect when the
          // write tools are also on (the trigger tools live in the write block).
          includeTriggers =
            deps.cfg.selfMcpWriteEnabled &&
            resolveHooksMcpEnabled(project.hooksMcpEnabled, deps.cfg.hooksMcpEnabled);

          // Composer attachments (issue #328): validate the uploaded files against
          // this project's effective attachment config, then prepend a
          // `<paddock-attachments>` hint block pointing the keeper's Read tool at
          // the stored files' absolute paths. Wrapped BEFORE preload so the whole
          // thing nests inside the preload block. Invalid/missing/over-count
          // attachments are dropped (defensive — the endpoint already gated them).
          if (sentAttachments && sentAttachments.length > 0) {
            const acfg = resolveAttachmentsConfig(project.attachments, deps.cfg.attachments);
            if (acfg.enabled) {
              const promptAtts: PromptAttachment[] = [];
              for (const a of sentAttachments.slice(0, acfg.maxFilesPerMessage)) {
                const abs = deps.attachments.absolutePath(a.id);
                if (!abs || !(await deps.attachments.exists(a.id))) continue;
                promptAtts.push({
                  id: a.id,
                  filename: a.filename,
                  kind: inferAttachmentKind(a.filename),
                  path: abs,
                });
              }
              prompt = wrapAttachments(promptAtts, prompt);
            }
          }

          // Context preload (issues #1/#188): only for a NEW chat, only when
          // asked. Shared with the self-MCP create_chat path (C2 / #264):
          // injects BOTH OVERVIEW.md and CHANGELOG.md when the project has
          // curated state, else leaves the prompt untouched. Wraps the (possibly
          // attachment-wrapped) `prompt`, not the bare `message`.
          if (isNewChat && preloadContext) {
            prompt = await composePreloadedPrompt(slug, prompt);
          }
        }

        // Inject the Paddock send_file MCP tool for this turn. The tool returns a
        // JSON envelope as its result `output`; the web renders it off the tool
        // call itself (live + on reload), so no bespoke WS frame is needed. The
        // working dir resolves a relative `file_path`; a real file's bytes are
        // copied into the attachment store at send time (immutable snapshot).
        const sendFile = sendFileServerDef({
          workingDirectory: sendFileWorkingDir,
          saveAttachment: (bytes, name) => deps.attachments.save(bytes, name),
        });
        const injectedMcpServers: Record<string, InjectedMcpServerDef> = {
          [SEND_FILE_SERVER_KEY]: sendFile,
        };

        // Self-management MCP (issue #214): only on keeper turns (never scratch)
        // and only when the instance opts in via PADDOCK_SELF_MCP. A HUMAN turn is
        // the ROOT of any spawn tree (origin human, depth 0), so its children are
        // depth 1 — the same builder the spawned path uses, just seeded with
        // HUMAN_ROOT. Write tools follow the instance write opt-in (B1 #262: the
        // shared builder is extracted so both paths agree). Depth-0 human gating is
        // unchanged from before B1 — the depth bound governs the spawned path only.
        if (slug !== SCRATCH_SLUG && deps.cfg.selfMcpEnabled) {
          injectedMcpServers[SELF_MCP_SERVER_KEY] = buildSelfMcpServerDef({
            currentProjectSlug: slug,
            currentSessionId: () => resolvedSession ?? sessionId ?? null,
            parentProvenance: HUMAN_ROOT,
            includeWrite: deps.cfg.selfMcpWriteEnabled,
            includeTriggers,
          });
        }

        // Session mode drives a persistent, herdctl-managed openChatSession so
        // cross-turn autonomy (ScheduleWakeup / `/loop`) survives the turn
        // boundary; batch mode keeps the legacy one-shot trigger. Both stream
        // through the identical onMessage/onJobCreated contract (Paddock#111).
        const drive =
          driveMode === "session"
            ? deps.herdctl.chatSession.bind(deps.herdctl)
            : deps.herdctl.chat.bind(deps.herdctl);
        const result = await drive(agentName, {
          prompt,
          // omit -> agent-level fallback; explicit null -> new chat; id -> resume.
          resume: sessionId ?? null,
          triggerType: "web",
          injectedMcpServers,
          onJobCreated: (id) => {
            jobId = id;
            turn.setJobId(id);
          },
          onMessage: async (m: SDKMessage) => {
            // Capture the session id as it arrives mid-stream (the translator
            // only surfaces text/boundary/tool events, not routing metadata).
            // Registering it with the hub makes the turn re-attachable by session.
            if (m.session_id) {
              resolvedSession = m.session_id;
              // #390: remember this human turn's injected servers so a wake this
              // chat self-schedules can replay them (the common flap scenario).
              wakeInjection.remember(m.session_id, injectedMcpServers);
              // For a NEW chat, attribute the session to its agent BEFORE the
              // hub broadcasts `chat:active`, so any client refetching its chat
              // list in response is guaranteed to see the now-listed chat — it
              // no longer waits for the turn to complete (issue #100). Awaited
              // once (a quick local job-record write); never fatal to the turn.
              if (isNewChat && !attributed) {
                attributed = true;
                // Non-fatal: on failure the chat simply falls back to appearing
                // once its turn completes (the prior behavior), never breaking
                // the live stream.
                await deps.herdctl
                  .attributeRunningSession(m.session_id, agentName)
                  .catch(() => undefined);
                // A1 (#261): a human-started chat is the ROOT of any spawn tree —
                // origin human, depth 0. Stamped once at creation; later turns on
                // this chat never change its recorded provenance.
                await deps.runProvenance?.stamp(m.session_id, HUMAN_ROOT).catch(() => undefined);
              }
              turn.setSession(m.session_id);
            }
            // Capture per-turn usage + model defensively. Keep the usage block
            // with the largest context snapshot (issue #165): the terminal
            // result message zeroes the cache fields, so "keep last" would drop
            // the assistant block's cache tokens and under-report context.
            const ex = extractUsage(m);
            if (ex.usage) seen.usage = pickTurnUsage(seen.usage, ex.usage);
            if (ex.model) seen.model = ex.model;
            // @herdctl/core's SDKMessage types `message` as `unknown` (wider);
            // @herdctl/chat's translator declares a structurally narrower
            // SDKMessage. Same runtime object — cast across the package boundary.
            // (@herdctl/chat@0.4.1 pairs CLI tool results, so no shim needed.)
            await translate(m as unknown as ChatSDKMessage);
          },
        });

        // Post-turn sweep (issues #2/#6): on a successful USER turn in a real
        // project, enqueue a coalesced/debounced curation sweep. Out of band —
        // never blocks or breaks chat, and can't recurse (the sweep uses a
        // separate agent triggered off the user-chat path). Skipped for scratch.
        // T5: routed through the `afterTurn` event so the folded-in `curate-overview`
        // trigger is the single dispatch (no double-curation).
        if (result.success) emitAfterTurn(slug, result.sessionId ?? resolvedSession ?? null);

        // Force a session-list refresh so a brand-new chat surfaces immediately
        // (rather than waiting out the discovery cache). Non-fatal.
        try {
          deps.herdctl.invalidateSessions(agentName);
        } catch {
          /* non-fatal: stale-by-30s at worst */
        }

        // Surface the model + usage so the UI can render the context meter.
        // Omit both if no usage was observed this turn (§7).
        const completeModel = seen.model ?? effectiveModel;
        const seenUsage = seen.usage;
        const completeUsage: ChatCompleteUsage | undefined = seenUsage
          ? {
              inputTokens: seenUsage.inputTokens,
              outputTokens: seenUsage.outputTokens,
              cacheReadTokens: seenUsage.cacheReadTokens,
              cacheCreationTokens: seenUsage.cacheCreationTokens,
              contextTokens:
                seenUsage.inputTokens +
                seenUsage.cacheReadTokens +
                seenUsage.cacheCreationTokens,
              contextLimit: getContextLimit(completeModel),
            }
          : undefined;

        // Ensure the turn is keyed under its final session id before the terminal
        // frame, so a client re-attaching right at the end gets the completion.
        const finalSession = result.success ? (result.sessionId ?? resolvedSession) : resolvedSession;
        if (finalSession) turn.setSession(finalSession);
        turn.emit({
          type: "chat:complete",
          payload: {
            ...routing(),
            sessionId: finalSession,
            jobId: result.jobId ?? jobId,
            success: result.success,
            error: result.error?.message,
            ...(completeUsage ? { model: completeModel, usage: completeUsage } : {}),
          },
        });
        turn.end();

        // After a SUCCESSFUL turn, auto-send any queued follow-up (#197/#245). A
        // Stop/failed turn holds the queue for the user (no drain). drainQueue owns
        // the take + client notify + next-turn kickoff, shared with the idle path.
        if (result.success && finalSession) {
          await drainQueue(slug, finalSession);
        }

        // Layer 3 (issue #301): arm a post-turn recovery watch for a session-mode
        // keeper turn. If this turn launched a background task that the runtime kills
        // at the turn boundary (herdctl#374) and the keeper doesn't wake on its own,
        // the engine auto-injects the recovery nudge — gated on the resolved
        // `recovery.autoReDrive` (default OFF), a debounce window, and a retry cap.
        if (result.success && finalSession && driveMode === "session" && slug !== SCRATCH_SLUG) {
          recoveryEngine.armWatch({ slug, sessionId: finalSession });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // The origin socket always gets the plain chat:error (its shape predates
        // the hub and existing clients/tests rely on it). If the turn had already
        // resolved a session, ALSO emit a terminal chat:complete through the hub
        // so a client that re-attached after a mid-turn socket drop stops showing
        // "streaming" instead of hanging with no terminal frame.
        send({ type: "chat:error", payload: { projectSlug: slug, target: slug, error } });
        if (resolvedSession) {
          turn.emit({
            type: "chat:complete",
            payload: { ...routing(), success: false, error },
          });
        }
        turn.end();
      }
    };

    /**
     * Handle a slash command (`chat:command`) by driving herdctl's streaming
     * session. Output is streamed back over the same events as a normal turn;
     * a `compact_boundary` is surfaced as a synthetic assistant note so the UI
     * shows a visible confirmation, and post-command usage refreshes the meter.
     */
    const onChatCommand = async (msg: ChatCommandMessage): Promise<void> => {
      const slug = (msg.payload.projectSlug ?? msg.payload.target) as string;
      const { command, sessionId } = msg.payload;
      let resolvedSession: string | null = sessionId ?? null;
      const seen: { usage: TurnUsage | null; model: string | null } = { usage: null, model: null };
      // Same hub-tracked turn as onChatSend so a slash-command turn also survives
      // a mid-turn socket drop (issue #54). A command always targets an existing
      // session, so it's re-attachable from its first frame.
      const turn: TurnHandle = hub.startTurn(slug, socket, sessionId ?? null);

      const routing = (): Routing => ({
        projectSlug: slug,
        target: slug,
        sessionId: resolvedSession,
        jobId: null,
      });

      const translate = createSDKMessageHandler({
        onText: (chunk) => {
          if (chunk) turn.emit({ type: "chat:response", payload: { ...routing(), chunk } });
        },
        onBoundary: () => {
          turn.emit({ type: "chat:message_boundary", payload: routing() });
        },
        onToolStart: (start) => {
          turn.emit({
            type: "chat:tool_start",
            payload: {
              ...routing(),
              toolName: start.toolName,
              inputSummary: start.inputSummary,
              toolUseId: start.toolUseId,
              parentToolUseId: start.parentToolUseId,
            },
          });
        },
        onToolCall: (call) => {
          turn.emit({
            type: "chat:tool_call",
            payload: {
              ...routing(),
              toolName: call.toolName,
              inputSummary: call.inputSummary,
              output: call.output,
              isError: call.isError,
              durationMs: call.durationMs,
              toolUseId: call.toolUseId,
            },
          });
        },
      });

      try {
        // Commands need an existing chat to act on; scratch resolves to its
        // agent, a project to its keeper (verifying the project exists).
        let agentName: string;
        if (slug === SCRATCH_SLUG) {
          agentName = SCRATCH_AGENT;
        } else {
          await deps.projects.get(slug); // throws if the project is unknown
          agentName = keeperAgentName(slug);
        }

        const { sessionId: finalSession } = await deps.herdctl.runCommand(agentName, {
          command,
          resume: resolvedSession,
          onMessage: async (m: SDKMessage) => {
            if (m.session_id) {
              resolvedSession = m.session_id;
              turn.setSession(m.session_id);
            }
            // Keep the largest context snapshot (issue #165) — see the note on
            // pickTurnUsage; the cache-less result block must not clobber it.
            const ex = extractUsage(m);
            if (ex.usage) seen.usage = pickTurnUsage(seen.usage, ex.usage);
            if (ex.model) seen.model = ex.model;
            // Surface a compaction as a visible assistant note (the SDK reports
            // it as a system/compact_boundary, which the text translator skips).
            if (m.type === "system" && m.subtype === "compact_boundary") {
              const pre = (m.compact_metadata as { pre_tokens?: number } | undefined)?.pre_tokens;
              const detail = typeof pre === "number" ? ` (was ${pre.toLocaleString()} tokens)` : "";
              turn.emit({
                type: "chat:response",
                payload: { ...routing(), chunk: `🗜️ Context compacted${detail}.` },
              });
              turn.emit({ type: "chat:message_boundary", payload: routing() });
              return;
            }
            // Surface a client-local command's output (`/context`, `/usage`, …). CC
            // returns it as a `model:"<synthetic>"` assistant message the translator
            // drops as a placeholder (and, on disk, a `system`/`local_command` entry
            // the history parser drops), so re-emit its text as an assistant note
            // (issue #158) instead of the turn reading as a silent no-op. Trivial
            // placeholders (e.g. `/compact`'s "No response requested.") are filtered out.
            const localOut = extractLocalCommandOutput(m);
            if (localOut) {
              turn.emit({ type: "chat:response", payload: { ...routing(), chunk: localOut } });
              turn.emit({ type: "chat:message_boundary", payload: routing() });
              return;
            }
            await translate(m as unknown as ChatSDKMessage);
          },
        });
        if (finalSession) resolvedSession = finalSession;

        // Refresh the session list (a command can change history) — non-fatal.
        try {
          deps.herdctl.invalidateSessions(agentName);
        } catch {
          /* non-fatal */
        }

        const completeModel = seen.model ?? KEEPER_DEFAULT_MODEL;
        const seenUsage = seen.usage;
        const completeUsage: ChatCompleteUsage | undefined = seenUsage
          ? {
              inputTokens: seenUsage.inputTokens,
              outputTokens: seenUsage.outputTokens,
              cacheReadTokens: seenUsage.cacheReadTokens,
              cacheCreationTokens: seenUsage.cacheCreationTokens,
              contextTokens:
                seenUsage.inputTokens + seenUsage.cacheReadTokens + seenUsage.cacheCreationTokens,
              contextLimit: getContextLimit(completeModel),
            }
          : undefined;

        if (resolvedSession) turn.setSession(resolvedSession);
        turn.emit({
          type: "chat:complete",
          payload: {
            ...routing(),
            success: true,
            ...(completeUsage ? { model: completeModel, usage: completeUsage } : {}),
          },
        });
        turn.end();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        send({ type: "chat:error", payload: { projectSlug: slug, target: slug, error } });
        if (resolvedSession) {
          turn.emit({ type: "chat:complete", payload: { ...routing(), success: false, error } });
        }
        turn.end();
      }
    };
  };

  // The socket handler PLUS the manual schedule-fire entrypoint (issue #266 / D4):
  // the `POST …/schedules/:name/trigger` route calls `fireSchedule` to run a
  // schedule on demand through the exact same hub path a cron fire uses, so a
  // "trigger now" chat is indistinguishable from a scheduled one.
  return { handle, fireSchedule, fireTrigger };
}
