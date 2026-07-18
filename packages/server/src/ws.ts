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
import type { WebSocket } from "@fastify/websocket";
import type {
  SDKMessage,
  RuntimeSession,
  SessionWakeEntry,
  InjectedMcpServerDef,
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import type { HerdctlService } from "./herdctl.js";
import {
  keeperAgentName,
  keeperSlugFromAgent,
  SCRATCH_AGENT,
  SCRATCH_SLUG,
} from "./herdctl.js";
import type { ProjectStore } from "./projects.js";
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
import { sendFileServerDef, SEND_FILE_SERVER_KEY } from "./send-file-mcp.js";
import {
  selfMcpServerDef,
  SELF_MCP_SERVER_KEY,
  type SelfMcpContext,
  type SelfMcpWriteContext,
} from "./self-mcp.js";
import type { AttachmentStore } from "./attachments.js";
import type { QueuedMessageStore } from "./queued-message.js";
import type { ArchiveStore } from "./archive.js";
import {
  type RunProvenanceStore,
  type RunProvenance,
  type TurnOrigin,
  HUMAN_ROOT,
  SCHEDULED_ROOT,
  childOf,
} from "./run-provenance.js";
import { resolveMaxSpawnDepth, spawnedSelfMcpDecision } from "./spawn-capability.js";

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

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | ChatSendMessage
  | ChatCommandMessage
  | ChatCancelMessage
  | ChatSubscribeMessage
  | ChatSetQueueMessage
  | PingMessage;

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
   * Per-chat archived-flag sidecar (#95). Used by the self-MCP archive_chat /
   * unarchive_chat write tools (#263) so a keeper can file a chat away — most
   * usefully ITSELF, powering the "work → archive myself on success" convention.
   */
  archive: ArchiveStore;
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
    // Post-wake curation sweep, same as a human turn (never for scratch).
    if (slug !== SCRATCH_SLUG && deps.sweep) deps.sweep.enqueue(slug);
  });

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
  }): InjectedMcpServerDef {
    const { currentProjectSlug, currentSessionId, parentProvenance, includeWrite } = params;

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
          const newId = await startAgentTurn({
            projectSlug,
            agentName: keeperAgentName(projectSlug),
            workingDir: p.workingDir,
            resume: null,
            prompt: composed,
            driveMode: driveModeFor(p),
            fallbackModel: p.model,
            origin: spawnedChild.origin,
            depth: spawnedChild.depth,
            maxSpawnDepth: maxSpawnDepthFor(p),
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
        forkChat: async ({ projectSlug, sourceSessionId, prompt: kickoff, name }) => {
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
              fallbackModel: p.model,
              // Resume of the just-forked child: the child was already stamped
              // above, so startAgentTurn won't re-stamp; this just describes the
              // kickoff run honestly. Its self-MCP is gated on the child's own
              // recorded depth (the stamp above), resolved in startAgentTurn.
              origin: spawnedChild.origin,
              depth: spawnedChild.depth,
              maxSpawnDepth: maxSpawnDepthFor(p),
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
          await deps.archive.setArchived(keeperAgentName(projectSlug), targetSessionId, archived);
        },
      };
    }

    return selfMcpServerDef(selfMcpContext, writeCtx);
  }

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
  }): Promise<string> {
    const { projectSlug, agentName, workingDir, resume, prompt, driveMode, fallbackModel, origin, depth, maxSpawnDepth } =
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

    // Spawned turns always get send_file (parity with the human path).
    const sendFile = sendFileServerDef({
      workingDirectory: workingDir,
      saveAttachment: (bytes, name) => deps.attachments.save(bytes, name),
    });
    const injectedMcpServers: Record<string, InjectedMcpServerDef> = {
      [SEND_FILE_SERVER_KEY]: sendFile,
    };

    // B1 (#262 / DD-3): depth-gated self-MCP. The capability follows the depth of
    // the CHAT this turn runs in: a NEW chat is at `depth` (the value we'll stamp);
    // a RESUME runs in an existing chat whose OWN recorded depth governs it (a
    // depth-1 child reporting back to its depth-0 root must gate the ROOT's turn on
    // depth 0, not on the child's describe-the-run value). Fall back to `depth`
    // when the target has no recorded marker. Still requires the instance opt-in
    // (`selfMcpEnabled`) and is never injected on scratch turns; write tools follow
    // the instance write opt-in — in practice always on when a spawn is reachable,
    // since a spawn only happens when a parent already had the write tools.
    let injectionDepth = depth;
    if (resume !== null && deps.runProvenance) {
      const rec = await deps.runProvenance.get(resume).catch(() => undefined);
      if (rec) injectionDepth = rec.depth;
    }
    const selfMcp = spawnedSelfMcpDecision({
      isScratch: projectSlug === SCRATCH_SLUG,
      selfMcpEnabled: deps.cfg.selfMcpEnabled,
      selfMcpWriteEnabled: deps.cfg.selfMcpWriteEnabled,
      depth: injectionDepth,
      maxSpawnDepth,
    });
    if (selfMcp.inject) {
      injectedMcpServers[SELF_MCP_SERVER_KEY] = buildSelfMcpServerDef({
        currentProjectSlug: projectSlug,
        currentSessionId: () => resolvedSession,
        // Children of THIS turn are one hop deeper than the chat it runs in.
        parentProvenance: { origin, depth: injectionDepth },
        includeWrite: selfMcp.includeWrite,
      });
    }

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
        if (result.success && deps.sweep) deps.sweep.enqueue(projectSlug);
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

  return async function handle(socket: WebSocket): Promise<void> {
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
      void onChatSend(parsed);
    });

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
      const { message, sessionId, preloadContext } = msg.payload;
      const isNewChat = sessionId === undefined || sessionId === null;
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

          // Context preload (issues #1/#188): only for a NEW chat, only when
          // asked. Shared with the self-MCP create_chat path (C2 / #264):
          // injects BOTH OVERVIEW.md and CHANGELOG.md when the project has
          // curated state, else leaves the prompt untouched.
          if (isNewChat && preloadContext) {
            prompt = await composePreloadedPrompt(slug, message);
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
        if (result.success && slug !== SCRATCH_SLUG && deps.sweep) {
          deps.sweep.enqueue(slug);
        }

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
}
