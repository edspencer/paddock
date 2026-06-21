/**
 * WebSocket chat transport.
 *
 * Protocol modeled on @herdctl/web's ws/types.ts:
 *   client -> server: chat:send
 *   server -> client: chat:response (text chunk)
 *                     chat:tool_call (structured tool result)
 *                     chat:complete (final, carries sessionId)
 *                     chat:error
 *
 * Streaming IS wired for real here via HerdctlService.chat()'s onMessage
 * callback (the public trigger API supports it). The only TODO is richer
 * tool-call extraction parity with herdctl/web's web-chat-manager (which lives
 * in @herdctl/web, not @herdctl/core — see docs/INTEGRATION.md, question f).
 */
import type { WebSocket } from "@fastify/websocket";
import type { SDKMessage } from "@herdctl/core";
import type { HerdctlService } from "./herdctl.js";
import { keeperAgentName, SCRATCH_AGENT } from "./herdctl.js";
import type { ProjectStore } from "./projects.js";

/** Sentinel agentName for one-off chats (mirrors herdctl/web's "__adhoc__"). */
export const ADHOC_AGENT = "__adhoc__";

// --- client -> server --------------------------------------------------------

export interface ChatSendMessage {
  type: "chat:send";
  payload: {
    /** Project slug, or ADHOC_AGENT for one-off chats. */
    target: string;
    /** Session to resume; omit for a new chat. */
    sessionId?: string;
    message: string;
  };
}

export interface PingMessage {
  type: "ping";
}

export type ClientMessage = ChatSendMessage | PingMessage;

// --- server -> client --------------------------------------------------------

export interface ChatResponseMessage {
  type: "chat:response";
  payload: { target: string; sessionId: string | null; jobId: string | null; chunk: string };
}

export interface ChatToolCallMessage {
  type: "chat:tool_call";
  payload: {
    target: string;
    sessionId: string | null;
    jobId: string | null;
    toolName: string;
    inputSummary?: string;
    output: string;
    isError: boolean;
  };
}

export interface ChatCompleteMessage {
  type: "chat:complete";
  payload: {
    target: string;
    sessionId: string | null;
    jobId: string | null;
    success: boolean;
    error?: string;
  };
}

export interface ChatErrorMessage {
  type: "chat:error";
  payload: { target: string; error: string };
}

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | ChatResponseMessage
  | ChatToolCallMessage
  | ChatCompleteMessage
  | ChatErrorMessage
  | PongMessage;

export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.type === "ping") return true;
  if (m.type === "chat:send") {
    const p = m.payload as Record<string, unknown> | undefined;
    return (
      !!p &&
      typeof p.target === "string" &&
      typeof p.message === "string" &&
      (p.sessionId === undefined || typeof p.sessionId === "string")
    );
  }
  return false;
}

/** Extract plain assistant text from an SDK message, if any. */
function assistantText(msg: SDKMessage): string | null {
  if (msg.type === "assistant") {
    if (typeof msg.content === "string" && msg.content.length > 0) return msg.content;
    // SDK assistant messages nest the API message; pull text blocks.
    const inner = msg.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (inner?.content) {
      const text = inner.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      return text.length > 0 ? text : null;
    }
  }
  return null;
}

/** Extract a tool_call event from an SDK message, if present. */
function toolCall(
  msg: SDKMessage,
): { toolName: string; inputSummary?: string; output: string; isError: boolean } | null {
  if (msg.type === "tool_use" || msg.type === "tool_result") {
    return {
      toolName: msg.tool_name ?? msg.name ?? "tool",
      inputSummary: msg.input ? JSON.stringify(msg.input).slice(0, 200) : undefined,
      output: typeof msg.tool_use_result === "string" ? msg.tool_use_result : "",
      isError: msg.success === false,
    };
  }
  // TODO: parity with @herdctl/web web-chat-manager — extract tool_use blocks
  // nested inside assistant content + paired tool_result blocks from user
  // messages. @herdctl/core exposes extractToolUseBlocks/extractToolResults
  // in state/tool-parsing for this; wire them for richer inline rendering.
  return null;
}

/**
 * Register the /ws route handler. Pure transport: it validates messages,
 * resolves the target agent, and streams a real trigger back to the socket.
 */
export function makeChatHandler(deps: { herdctl: HerdctlService; projects: ProjectStore }) {
  return async function handle(socket: WebSocket): Promise<void> {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

    socket.on("message", (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: "chat:error", payload: { target: "?", error: "Invalid JSON" } });
        return;
      }
      if (!isClientMessage(parsed)) {
        send({ type: "chat:error", payload: { target: "?", error: "Unknown message" } });
        return;
      }
      if (parsed.type === "ping") {
        send({ type: "pong" });
        return;
      }
      void onChatSend(parsed);
    });

    const onChatSend = async (msg: ChatSendMessage): Promise<void> => {
      const { target, message, sessionId } = msg.payload;
      let jobId: string | null = null;
      let resolvedSession: string | null = sessionId ?? null;

      try {
        // Resolve the agent: a project slug -> keeper; ADHOC -> scratch.
        let agentName: string;
        if (target === ADHOC_AGENT) {
          agentName = SCRATCH_AGENT;
        } else {
          // Verifies the project exists (throws if not).
          await deps.projects.get(target);
          agentName = keeperAgentName(target);
        }

        const result = await deps.herdctl.chat(agentName, {
          prompt: message,
          // omit -> agent-level fallback for resume; explicit null -> new chat
          resume: sessionId ?? null,
          triggerType: "web",
          onJobCreated: (id) => {
            jobId = id;
          },
          onMessage: (m) => {
            if (m.session_id) resolvedSession = m.session_id;
            const text = assistantText(m);
            if (text) {
              send({
                type: "chat:response",
                payload: { target, sessionId: resolvedSession, jobId, chunk: text },
              });
              return;
            }
            const tc = toolCall(m);
            if (tc) {
              send({ type: "chat:tool_call", payload: { target, sessionId: resolvedSession, jobId, ...tc } });
            }
          },
        });

        send({
          type: "chat:complete",
          payload: {
            target,
            sessionId: result.sessionId ?? resolvedSession,
            jobId: result.jobId ?? jobId,
            success: result.success,
            error: result.error?.message,
          },
        });
      } catch (err) {
        send({
          type: "chat:error",
          payload: { target, error: err instanceof Error ? err.message : String(err) },
        });
      }
    };
  };
}
