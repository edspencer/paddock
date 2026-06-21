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
 *     { type: "chat:complete",         payload: { projectSlug, sessionId, jobId, success, error? } }
 *     { type: "chat:error",            payload: { projectSlug, error } }
 *     { type: "pong" }
 *
 * Streaming is wired for real via HerdctlService.chat()'s onMessage callback
 * (the public trigger API supports it). The SDKMessage -> chat-event translation
 * (assistant text deltas, message boundaries, and paired tool_use -> tool_result
 * calls enriched with input summaries + wall-clock durations) is now done by
 * @herdctl/chat's `createSDKMessageHandler` — the shared, transport-agnostic
 * translator every herdctl chat surface uses — so paddock no longer reimplements
 * it. We compose it with a tiny wrapper that also captures the session id from
 * each SDK message (the translator only exposes text/boundary/tool events).
 *
 * Field-name note: legacy clients may send `target` instead of `projectSlug`;
 * we accept both. Server events always carry both `projectSlug` and the legacy
 * `target` alias so existing/early frontends keep working.
 */
import type { WebSocket } from "@fastify/websocket";
import type { SDKMessage } from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import type { HerdctlService } from "./herdctl.js";
import { keeperAgentName, SCRATCH_AGENT, SCRATCH_SLUG } from "./herdctl.js";
import type { ProjectStore } from "./projects.js";
import type { SweepService } from "./sweep.js";

/**
 * Normalize a user SDKMessage so the shared translator can pair tool results.
 *
 * The CLI runtime surfaces tool results twice: as a top-level `tool_use_result`
 * field AND as nested `tool_result` blocks inside `message.content[]`. Core's
 * `extractToolResults` (used by `@herdctl/chat`'s translator) short-circuits on
 * the top-level field, but that shape carries no usable `tool_use_id` — so the
 * translator can't pair the result with its `tool_use` and falls back to a
 * generic `toolName: "Tool"` with no input summary / duration.
 *
 * When a message has BOTH the id-less top-level field AND a nested
 * `tool_result` block that DOES carry a `tool_use_id`, we drop the top-level
 * field (on a shallow clone — never mutating the SDK's object) so extraction
 * falls through to the nested branch and the pairing (name/summary/duration) is
 * restored. No-op for every other message.
 */
function normalizeForTranslator(m: SDKMessage): SDKMessage {
  const msg = m as unknown as {
    type?: string;
    tool_use_result?: unknown;
    message?: { content?: unknown };
  };
  if (msg.type !== "user" || msg.tool_use_result === undefined) return m;

  // Does the top-level result already carry an id? If so, leave it alone.
  const topLevel = msg.tool_use_result;
  const topLevelHasId =
    typeof topLevel === "object" &&
    topLevel !== null &&
    typeof (topLevel as { tool_use_id?: unknown }).tool_use_id === "string";
  if (topLevelHasId) return m;

  // Is there a nested tool_result block carrying a real tool_use_id?
  const content = msg.message?.content;
  const nestedHasId =
    Array.isArray(content) &&
    content.some(
      (b) =>
        b !== null &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "tool_result" &&
        typeof (b as { tool_use_id?: unknown }).tool_use_id === "string",
    );
  if (!nestedHasId) return m;

  // Shallow clone and drop the id-less top-level field so extraction uses the
  // nested (id-bearing) blocks. The SDK's original object is untouched.
  const clone = { ...msg };
  delete clone.tool_use_result;
  return clone as unknown as SDKMessage;
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
  };
}

export interface ChatCancelMessage {
  type: "chat:cancel";
  payload: { jobId: string };
}

export interface PingMessage {
  type: "ping";
}

export type ClientMessage = ChatSendMessage | ChatCancelMessage | PingMessage;

// --- server -> client --------------------------------------------------------

interface Routing {
  projectSlug: string;
  /** Alias for early frontends. */
  target: string;
  sessionId: string | null;
  jobId: string | null;
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

export interface ChatCompleteMessage {
  type: "chat:complete";
  payload: Routing & { success: boolean; error?: string };
}

export interface ChatErrorMessage {
  type: "chat:error";
  payload: { projectSlug: string; target: string; error: string };
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
    return p.sessionId === undefined || p.sessionId === null || typeof p.sessionId === "string";
  }
  return false;
}

/**
 * Register the /ws route handler. Pure transport: it validates messages,
 * resolves the target agent, and streams a real trigger back to the socket.
 */
export function makeChatHandler(deps: {
  herdctl: HerdctlService;
  projects: ProjectStore;
  /** Optional: post-turn overview/changelog curation engine (issues #2/#6). */
  sweep?: SweepService;
}) {
  return async function handle(socket: WebSocket): Promise<void> {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

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
      void onChatSend(parsed);
    });

    const onChatSend = async (msg: ChatSendMessage): Promise<void> => {
      const slug = readSlug(msg.payload) as string;
      const { message, sessionId, preloadContext } = msg.payload;
      const isNewChat = sessionId === undefined || sessionId === null;
      let jobId: string | null = null;
      let resolvedSession: string | null = sessionId ?? null;

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
          if (chunk) send({ type: "chat:response", payload: { ...routing(), chunk } });
        },
        onBoundary: () => {
          send({ type: "chat:message_boundary", payload: routing() });
        },
        onToolCall: (call) => {
          send({
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
        if (slug === SCRATCH_SLUG) {
          agentName = SCRATCH_AGENT;
        } else {
          // Verifies the project exists (throws if not).
          await deps.projects.get(slug);
          agentName = keeperAgentName(slug);

          // Context preload (issue #1): only for a NEW chat, only when asked,
          // and only when the project actually has an OVERVIEW.md. Prepend it
          // as a clearly delimited block so the keeper starts primed.
          if (isNewChat && preloadContext) {
            const overview = await deps.projects.readOverview(slug).catch(() => "");
            if (overview.trim().length > 0) {
              prompt =
                "<project-context>\n" +
                overview.trim() +
                "\n</project-context>\n\nMy request:\n" +
                message;
            }
          }
        }

        const result = await deps.herdctl.chat(agentName, {
          prompt,
          // omit -> agent-level fallback; explicit null -> new chat; id -> resume.
          resume: sessionId ?? null,
          triggerType: "web",
          onJobCreated: (id) => {
            jobId = id;
          },
          onMessage: async (m: SDKMessage) => {
            // Capture the session id as it arrives mid-stream (the translator
            // only surfaces text/boundary/tool events, not routing metadata).
            if (m.session_id) resolvedSession = m.session_id;
            // Restore tool-call pairing for the CLI runtime (drops an id-less
            // top-level tool_use_result so the translator uses the nested,
            // id-bearing tool_result blocks). No-op for other messages.
            const normalized = normalizeForTranslator(m);
            // @herdctl/core's SDKMessage types `message` as `unknown` (wider);
            // @herdctl/chat's translator declares a structurally narrower
            // SDKMessage. Same runtime object — cast across the package boundary.
            await translate(normalized as unknown as ChatSDKMessage);
          },
        });

        // Post-turn sweep (issues #2/#6): on a successful USER turn in a real
        // project, enqueue a coalesced/debounced curation sweep. Out of band —
        // never blocks or breaks chat, and can't recurse (the sweep uses a
        // separate agent triggered off the user-chat path). Skipped for scratch.
        if (result.success && slug !== SCRATCH_SLUG && deps.sweep) {
          deps.sweep.enqueue(slug);
        }

        send({
          type: "chat:complete",
          payload: {
            ...routing(),
            sessionId: result.success ? (result.sessionId ?? resolvedSession) : resolvedSession,
            jobId: result.jobId ?? jobId,
            success: result.success,
            error: result.error?.message,
          },
        });
      } catch (err) {
        send({
          type: "chat:error",
          payload: {
            projectSlug: slug,
            target: slug,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    };
  };
}
