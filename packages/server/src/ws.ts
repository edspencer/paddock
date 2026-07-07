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
import type { SDKMessage } from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import type { HerdctlService } from "./herdctl.js";
import {
  keeperAgentName,
  SCRATCH_AGENT,
  SCRATCH_SLUG,
} from "./herdctl.js";
import type { ProjectStore } from "./projects.js";
import type { SweepService } from "./sweep.js";
import { isKnownModel, getContextLimit, KEEPER_DEFAULT_MODEL } from "./models.js";
import { SessionHub, type TurnHandle, type ActiveInfo } from "./session-hub.js";
import { wrapPreload } from "./preload.js";

/**
 * Per-turn token usage as observed on the SDK stream, normalized to camelCase.
 * Read defensively from either an assistant message (`m.message.usage`) or the
 * final result message (`m.usage`) — fields are loosely typed in core.
 */
interface TurnUsage {
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
function extractUsage(m: SDKMessage): ExtractedUsage {
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

// --- client -> server --------------------------------------------------------

export interface ChatSendMessage {
  type: "chat:send";
  payload: {
    /** Project slug, or "scratch" for one-off chats. (`target` accepted as alias.) */
    projectSlug?: string;
    target?: string;
    /** Session to resume; null/omitted starts a new chat. */
    sessionId?: string | null;
    /**
     * When set (and `sessionId` is null/omitted), this is the FIRST turn of a
     * forked chat: resume `forkFrom`'s transcript as context but write to a
     * brand-new session id (Claude Code `--fork-session`), leaving the source
     * chat untouched. Ignored once the forked chat has its own `sessionId`
     * (subsequent turns are ordinary resumes). See the "Fork chat" feature.
     */
    forkFrom?: string;
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

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | ChatSendMessage
  | ChatCommandMessage
  | ChatCancelMessage
  | ChatSubscribeMessage
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

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | ChatResponseMessage
  | ChatToolCallMessage
  | ChatMessageBoundaryMessage
  | ChatCompleteMessage
  | ChatErrorMessage
  | ChatResyncMessage
  | ChatActiveMessage
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

export function makeChatHandler(deps: {
  herdctl: HerdctlService;
  projects: ProjectStore;
  /** Optional: post-turn overview/changelog curation engine (issues #2/#6). */
  sweep?: SweepService;
}) {
  // ONE hub shared across every socket this handler serves: it tracks each
  // session's in-flight turn and fans its frames out to whichever socket(s) are
  // currently attached, so a turn survives the death of the socket that started
  // it (issue #54). See session-hub.ts.
  const hub = new SessionHub();

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

    const onChatSend = async (msg: ChatSendMessage): Promise<void> => {
      const slug = readSlug(msg.payload) as string;
      const { message, sessionId, preloadContext } = msg.payload;
      const isNewChat = sessionId === undefined || sessionId === null;
      // A fork applies only on the FIRST turn of the child (no session id yet):
      // resume the source's context but write to a new id. Once the child has
      // its own session id, later turns are ordinary resumes.
      const forkFrom = isNewChat ? msg.payload.forkFrom : undefined;
      let jobId: string | null = null;
      let resolvedSession: string | null = sessionId ?? null;
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

          // Project chat: a valid override wins, else the project's model. Then
          // ensure the (shared) keeper is registered at that model before the
          // trigger. NOTE single-user last-write-wins caveat (see herdctl.ts).
          effectiveModel =
            requested && isKnownModel(requested) ? requested : project.model;
          await deps.herdctl.ensureKeeperModel(project, effectiveModel);

          // Context preload (issue #1): only for a NEW chat, only when asked,
          // and only when the project actually has an OVERVIEW.md. Prepend it
          // as a clearly delimited block so the keeper starts primed. Skipped
          // for a fork — the forked context already carries the full history.
          if (isNewChat && preloadContext && !forkFrom) {
            const overview = await deps.projects.readOverview(slug).catch(() => "");
            if (overview.trim().length > 0) {
              // Single-sourced wrapper (see preload.ts) so the chat-list can strip
              // it back off for display (issue #62).
              prompt = wrapPreload(overview, message);
            }
          }
        }

        const result = await deps.herdctl.chat(agentName, {
          prompt,
          // omit -> agent-level fallback; explicit null -> new chat; id -> resume.
          resume: sessionId ?? null,
          // Fork the source session on the child's first turn (writes a new id).
          fork: forkFrom,
          triggerType: "web",
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
              turn.setSession(m.session_id);
            }
            // Capture per-turn usage + model defensively; keep the last non-null
            // usage / model seen (the final result message usually carries the
            // authoritative usage).
            const ex = extractUsage(m);
            if (ex.usage) seen.usage = ex.usage;
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
            const ex = extractUsage(m);
            if (ex.usage) seen.usage = ex.usage;
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
