/**
 * Paddock self-management MCP — Phase 1 (read-only).
 *
 * Exposes a small set of READ-ONLY tools that let a keeper agent inspect Paddock
 * itself: enumerate projects, enumerate a project's (or all projects') chats, and
 * read a trimmed tail of any chat's transcript. This is the "inward" half of the
 * self-management surface designed in issue #214 — the same operations will later
 * be exposed "outward" over an authenticated endpoint for a laptop/peer bridge
 * (Phase 3). Phase 2 adds the write tools (create/fork/message).
 *
 * ── How it reaches the keeper ───────────────────────────────────────────────
 * Injected via herdctl's `injectedMcpServers` mechanism, exactly like the
 * send_file tool (see send-file-mcp.ts): the CLI-runtime keeper can't reach an
 * in-process SDK MCP server, so herdctl stands up a localhost HTTP MCP bridge for
 * each injected server and auto-allowlists its `mcp__<name>__*` tools. The tools
 * surface to the agent as `mcp__paddock_manage__{list_projects,list_chats,read_chat}`.
 *
 * ── Design (locked in #214) ─────────────────────────────────────────────────
 *  - READ-ONLY only in this phase — no create/fork/message.
 *  - CROSS-PROJECT — `list_chats`/`read_chat` can see every project, not just the
 *    keeper's own.
 *  - KEEPER-ONLY + ENV-GATED — the caller only injects this server on keeper turns
 *    when `PADDOCK_SELF_MCP` is set (never on scratch turns).
 *
 * The module is pure: it takes a narrow {@link SelfMcpContext} of async callbacks
 * (wired to ProjectStore/HerdctlService by the caller) so the trimming/validation
 * logic here is unit-testable without the fleet. Tool outputs are plain JSON text
 * for the AGENT to read (not a render envelope like send_file).
 */
import type { InjectedMcpServerDef, McpToolCallResult } from "@herdctl/core";

/** A project as surfaced to the agent. */
export interface SelfMcpProject {
  slug: string;
  name: string;
  /** The project's area ("Unsorted" when empty); omitted when blank. */
  area?: string;
  status: string;
}

/** A chat as surfaced to the agent. */
export interface SelfMcpChat {
  /** Owning project slug. */
  project: string;
  sessionId: string;
  /** Display name (custom name, else auto-name, else a short id). */
  name: string;
  /** ISO timestamp of the last transcript write (mtime). */
  updatedAt: string;
  /** Whether a turn is currently in flight for this chat. */
  running: boolean;
}

/** One transcript message as surfaced to the agent. */
export interface SelfMcpMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  timestamp: string;
}

/**
 * Per-turn context: narrow async callbacks the caller wires to the real stores.
 * `readChat` returns the FULL ordered message list; this module applies the
 * tail/limit + per-message truncation so that logic stays testable here.
 */
export interface SelfMcpContext {
  listProjects: () => Promise<SelfMcpProject[]>;
  listChats: (projectSlug?: string) => Promise<SelfMcpChat[]>;
  readChat: (projectSlug: string, sessionId: string) => Promise<SelfMcpMessage[]>;
}

const SERVER_NAME = "paddock_manage";

/** read_chat: default and hard-cap on how many trailing messages to return. */
export const READ_CHAT_DEFAULT_LIMIT = 30;
export const READ_CHAT_MAX_LIMIT = 200;
/** read_chat: per-message character cap so one huge message can't flood the result. */
export const READ_CHAT_MAX_TEXT = 2000;

function ok(payload: unknown): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Clamp a caller-supplied limit into [1, MAX], defaulting when absent/invalid. */
export function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return READ_CHAT_DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > READ_CHAT_MAX_LIMIT) return READ_CHAT_MAX_LIMIT;
  return n;
}

/** Truncate a single message's text with an explicit marker. */
export function truncateText(text: string): string {
  if (text.length <= READ_CHAT_MAX_TEXT) return text;
  const omitted = text.length - READ_CHAT_MAX_TEXT;
  return `${text.slice(0, READ_CHAT_MAX_TEXT)}… [truncated ${omitted} chars]`;
}

const LIST_PROJECTS_DESC =
  "List all Paddock projects (across every area). Returns each project's slug, " +
  "display name, area, and status. Use the slug to target `list_chats`/`read_chat`.";

const LIST_CHATS_DESC =
  "List chats. Pass `project` (a slug) to list only that project's chats, or omit " +
  "it to list chats across ALL projects. Returns each chat's owning project, " +
  "sessionId, display name, last-updated time, and whether a turn is currently " +
  "running. Cheap — does not read full transcripts; use `read_chat` for content.";

const READ_CHAT_DESC =
  "Read a trimmed tail of a chat's transcript. Pass `project` (slug) and " +
  "`session_id` (from `list_chats`). Returns the last `limit` messages (default " +
  `${READ_CHAT_DEFAULT_LIMIT}, max ${READ_CHAT_MAX_LIMIT}) as {role, text, timestamp}; each ` +
  `message's text is capped at ${READ_CHAT_MAX_TEXT} chars. Use this to see what ` +
  "another chat is about or what was decided there.";

function listProjectsHandler(context: SelfMcpContext) {
  return async (): Promise<McpToolCallResult> => {
    try {
      const projects = await context.listProjects();
      return ok({ count: projects.length, projects });
    } catch (error) {
      return fail(`Error listing projects: ${errText(error)}`);
    }
  };
}

function listChatsHandler(context: SelfMcpContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const project = typeof args.project === "string" ? args.project.trim() : undefined;
      const chats = await context.listChats(project && project.length > 0 ? project : undefined);
      return ok({ count: chats.length, project: project ?? null, chats });
    } catch (error) {
      return fail(`Error listing chats: ${errText(error)}`);
    }
  };
}

function readChatHandler(context: SelfMcpContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const project = typeof args.project === "string" ? args.project.trim() : "";
      const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
      if (!project) return fail("Error: `project` (a project slug) is required.");
      if (!sessionId) return fail("Error: `session_id` is required (get it from list_chats).");
      const limit = clampLimit(args.limit);

      const all = await context.readChat(project, sessionId);
      const tail = all.slice(-limit).map((m) => ({
        role: m.role,
        text: truncateText(m.text),
        timestamp: m.timestamp,
      }));
      return ok({
        project,
        sessionId,
        total: all.length,
        returned: tail.length,
        messages: tail,
      });
    } catch (error) {
      return fail(`Error reading chat: ${errText(error)}`);
    }
  };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the injected MCP server definition for the read-only self-management
 * tools, bound to a per-turn context. Inject under {@link SELF_MCP_SERVER_KEY}.
 */
export function selfMcpServerDef(context: SelfMcpContext): InjectedMcpServerDef {
  return {
    name: SERVER_NAME,
    version: "0.1.0",
    tools: [
      {
        name: "list_projects",
        description: LIST_PROJECTS_DESC,
        inputSchema: { type: "object", properties: {} },
        handler: listProjectsHandler(context),
      },
      {
        name: "list_chats",
        description: LIST_CHATS_DESC,
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "Project slug to filter by. Omit to list chats across all projects.",
            },
          },
        },
        handler: listChatsHandler(context),
      },
      {
        name: "read_chat",
        description: READ_CHAT_DESC,
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project slug that owns the chat." },
            session_id: { type: "string", description: "The chat's sessionId (from list_chats)." },
            limit: {
              type: "number",
              description: `How many trailing messages to return (default ${READ_CHAT_DEFAULT_LIMIT}, max ${READ_CHAT_MAX_LIMIT}).`,
            },
          },
          required: ["project", "session_id"],
        },
        handler: readChatHandler(context),
      },
    ],
  };
}

/** The record key + the fully-qualified tool names the agent sees. */
export const SELF_MCP_SERVER_KEY = SERVER_NAME;
export const SELF_MCP_TOOL_NAMES = {
  listProjects: `mcp__${SERVER_NAME}__list_projects`,
  listChats: `mcp__${SERVER_NAME}__list_chats`,
  readChat: `mcp__${SERVER_NAME}__read_chat`,
} as const;
