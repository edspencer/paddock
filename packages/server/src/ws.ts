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
 * (the public trigger API supports it). Tool-call extraction reuses
 * @herdctl/core's tool-parsing helpers (extractToolUseBlocks / extractToolResults
 * / getToolInputSummary) so tool_use blocks nested in assistant content and the
 * paired tool_result blocks in user messages are rendered correctly.
 *
 * Field-name note: legacy clients may send `target` instead of `projectSlug`;
 * we accept both. Server events always carry both `projectSlug` and the legacy
 * `target` alias so existing/early frontends keep working.
 */
import type { WebSocket } from "@fastify/websocket";
import {
  type SDKMessage,
  extractToolUseBlocks,
  extractToolResults,
  getToolInputSummary,
  type ToolUseBlock,
} from "@herdctl/core";
import type { HerdctlService } from "./herdctl.js";
import { keeperAgentName, SCRATCH_AGENT, SCRATCH_SLUG } from "./herdctl.js";
import type { ProjectStore } from "./projects.js";
import type { SweepService } from "./sweep.js";

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
 * Extract plain assistant text from an SDK message, if any.
 *
 * Assistant text lives either in `message.message.content[]` text blocks (the
 * normal SDK shape) or in a top-level `content` string (legacy/back-compat).
 */
function assistantText(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const inner = msg.message as { content?: unknown } | undefined;
  if (Array.isArray(inner?.content)) {
    const text = inner.content
      .filter(
        (b): b is { type: "text"; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("");
    if (text.length > 0) return text;
  }
  if (typeof msg.content === "string" && msg.content.length > 0) return msg.content;
  return null;
}

/**
 * The core tool-parsing helpers accept a looser structural shape than the
 * (deliberately wide) SDKMessage. SDKMessage carries the same fields with
 * `message`/`tool_use_result` typed as `unknown`, so this cast is sound.
 */
type ParsableMessage = {
  type: string;
  message?: { content?: unknown };
  tool_use_result?: unknown;
};
function parsable(m: SDKMessage): ParsableMessage {
  return m as unknown as ParsableMessage;
}

/**
 * Extract tool results from a user message, PRESERVING the `tool_use_id`.
 *
 * Why not just `extractToolResults`? In the live SDK stream a user message
 * carries the result BOTH as a top-level `tool_use_result` (a string/object
 * with NO id) AND as a nested `message.content[]` `tool_result` block (which
 * DOES have `tool_use_id` + `is_error`). The core helper short-circuits on the
 * id-less top-level value, so pairing by id is lost. We read the nested blocks
 * directly to keep the id (for correct tool-name pairing + durationMs), and
 * fall back to the core helper only when there are no nested blocks.
 */
function extractResultsWithIds(
  m: SDKMessage,
): Array<{ output: string; isError: boolean; toolUseId?: string }> {
  const inner = (m.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(inner)) {
    const out: Array<{ output: string; isError: boolean; toolUseId?: string }> = [];
    for (const block of inner) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
      const isError = b.is_error === true;
      let output = "";
      if (typeof b.content === "string") {
        output = b.content;
      } else if (Array.isArray(b.content)) {
        output = b.content
          .filter(
            (p): p is { type: "text"; text: string } =>
              !!p &&
              typeof p === "object" &&
              (p as { type?: unknown }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => p.text)
          .join("\n");
      }
      // If the nested block had no inline content, use the top-level result.
      if (!output && typeof m.tool_use_result === "string") output = m.tool_use_result;
      out.push({ output, isError, toolUseId });
    }
    if (out.length > 0) return out;
  }
  // No nested blocks — fall back to the core helper (id-less).
  return extractToolResults(parsable(m));
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

      // Pairing state: tool_use id -> { name, inputSummary, startedAt }.
      const pending = new Map<
        string,
        { name: string; inputSummary?: string; startedAt: number }
      >();
      // tool_use blocks with no id (rare) — keep a FIFO fallback.
      const anonymous: Array<{ name: string; inputSummary?: string; startedAt: number }> = [];

      const recordToolUse = (b: ToolUseBlock) => {
        const entry = {
          name: b.name,
          inputSummary: getToolInputSummary(b.name, b.input),
          startedAt: Date.now(),
        };
        if (b.id) pending.set(b.id, entry);
        else anonymous.push(entry);
      };

      try {
        // Resolve the agent: "scratch" -> scratch agent; otherwise keeper-<slug>.
        let agentName: string;
        let workingDir: string;
        // Effective prompt — may be augmented with the project overview below.
        let prompt = message;
        if (slug === SCRATCH_SLUG) {
          agentName = SCRATCH_AGENT;
          workingDir = deps.herdctl.scratchDir;
        } else {
          // Verifies the project exists (throws if not).
          const project = await deps.projects.get(slug);
          agentName = keeperAgentName(slug);
          workingDir = project.dir;

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
          onMessage: (m) => {
            if (m.session_id) resolvedSession = m.session_id;

            if (m.type === "assistant") {
              // 1) record any tool_use blocks for later pairing.
              for (const b of extractToolUseBlocks(parsable(m))) recordToolUse(b);
              // 2) stream assistant text deltas.
              const text = assistantText(m);
              if (text) {
                send({ type: "chat:response", payload: { ...routing(), chunk: text } });
              }
              // 3) mark an assistant message boundary (one logical turn rendered).
              send({ type: "chat:message_boundary", payload: routing() });
              return;
            }

            if (m.type === "user" || m.type === "tool_result") {
              // tool_result blocks (paired with the earlier tool_use by id).
              for (const r of extractResultsWithIds(m)) {
                let matched:
                  | { name: string; inputSummary?: string; startedAt: number }
                  | undefined;
                if (r.toolUseId && pending.has(r.toolUseId)) {
                  matched = pending.get(r.toolUseId);
                  pending.delete(r.toolUseId);
                } else {
                  matched = anonymous.shift();
                }
                // If the tool produced no textual content, fall back to a
                // compact serialization of the raw result (e.g. Write returns
                // a structured object, not text).
                let output = r.output;
                if (!output && m.tool_use_result !== undefined) {
                  output =
                    typeof m.tool_use_result === "string"
                      ? m.tool_use_result
                      : JSON.stringify(m.tool_use_result);
                }
                send({
                  type: "chat:tool_call",
                  payload: {
                    ...routing(),
                    toolName: matched?.name ?? "tool",
                    inputSummary: matched?.inputSummary,
                    output,
                    isError: r.isError,
                    durationMs: matched ? Date.now() - matched.startedAt : undefined,
                  },
                });
              }
              return;
            }

            // Legacy/standalone tool_use message (no nested assistant block).
            if (m.type === "tool_use") {
              const name = m.tool_name ?? m.name ?? "tool";
              recordToolUse({ id: m.tool_use_id, name, input: m.input });
            }
          },
        });

        // A successful turn may have created a new session; drop the discovery
        // cache for this working dir so the chat list reflects it immediately
        // (rather than after the ~30s cache TTL).
        if (result.success) deps.herdctl.invalidateSessions(workingDir);

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
