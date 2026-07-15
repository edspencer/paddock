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

/**
 * Write-side per-turn context. Present only when the write flag is on. These
 * callbacks START real keeper turns; this module only validates/normalizes args
 * and delegates. The caller wires them to HerdctlService/ProjectStore.
 *
 * NOTE (guard-ready): these write tools deliberately have NO recursion/depth
 * guard in this phase (per the product owner) — a keeper can create/fork chats
 * that themselves have the self-MCP injected. The injection path is intentionally
 * left guard-ready: a later phase can thread a depth/origin marker through the
 * caller-supplied callbacks below without changing this module's shape.
 */
export interface SelfMcpWriteContext {
  /** Slug of the project the calling keeper is in (fork/create default target). */
  currentProjectSlug: string;
  /** Resolved sessionId of the CURRENT chat, or null if not yet known this turn. */
  currentSessionId: () => string | null;
  /** Start a brand-new chat in `projectSlug` kicked off with `prompt`. Returns its new sessionId. */
  createChat: (projectSlug: string, prompt: string, opts?: { name?: string; preloadContext?: boolean }) => Promise<{ sessionId: string }>;
  /** Eager-fork `sourceSessionId` (in `projectSlug`) into a new chat, optionally kicked off with `prompt`. Returns the new sessionId. */
  forkChat: (args: { projectSlug: string; sourceSessionId: string; prompt?: string; name?: string }) => Promise<{ sessionId: string }>;
  /** Send `prompt` as a new turn to an existing chat. */
  sendMessage: (projectSlug: string, sessionId: string, prompt: string) => Promise<void>;
}

const SERVER_NAME = "paddock_manage";

/** fork_chat_batch: hard cap on how many forks a single fan-out call may spawn. */
export const FORK_BATCH_MAX = 20;

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

// ── Write tools (Phase 2) ──────────────────────────────────────────────────

const CREATE_CHAT_DESC =
  "Start a BRAND-NEW chat and kick it off with `prompt` (a full first turn to the " +
  "new keeper). Defaults to the current project; pass `project` (a slug) to create " +
  "it elsewhere. Optionally set `name` (the chat's display name) and " +
  "`preload_context` (seed the new chat with the project's OVERVIEW/context). " +
  "Returns the new chat's sessionId.";

const FORK_CHAT_DESC =
  "Fork an existing chat into a NEW child chat that inherits its history, then " +
  "optionally kick the child off with `prompt`. Defaults to forking the CURRENT " +
  "chat (the one you're in) — omit `session_id` to fork yourself, or pass a " +
  "`session_id` (from list_chats) to fork another. Defaults to the current project; " +
  "pass `project` to fork one elsewhere. Optionally set `name`. Returns the new " +
  "chat's sessionId. For fanning one source out into many children, use " +
  "`fork_chat_batch` instead.";

const SEND_MESSAGE_DESC =
  "Send `prompt` as a NEW turn to an existing chat (identified by `session_id` from " +
  "list_chats). Defaults to the current project; pass `project` to target a chat in " +
  "another project. Use this to hand work or context to a chat that already exists.";

const FORK_CHAT_BATCH_DESC =
  "FAN-OUT primitive: fork ONE source chat into many child chats at once — one child " +
  "per entry in `prompts`, each kicked off with its own prompt. Classic use: you " +
  "found N items (e.g. 10 changes) and want to fork this chat N times, one worker per " +
  "item. Pass `prompts` as one directive PER LINE. " +
  "Defaults the source to the CURRENT chat; pass `session_id` to fork a different " +
  "one, and `project` to target another project. With `name_prefix`, each fork is named " +
  `"<name_prefix> <i>" (1-based). Up to ${FORK_BATCH_MAX} forks per call; they run ` +
  "concurrently. Returns the source and every new child's sessionId.";

function createChatHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return fail("Error: `prompt` is required (the first turn for the new chat).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const name = typeof args.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined;
      const preloadContext = typeof args.preload_context === "boolean" ? args.preload_context : undefined;

      const { sessionId } = await write.createChat(project, prompt, { name, preloadContext });
      return ok({ created: true, project, sessionId });
    } catch (error) {
      return fail(`Error creating chat: ${errText(error)}`);
    }
  };
}

function forkChatHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const sourceSessionId = explicit.length > 0 ? explicit : write.currentSessionId();
      if (!sourceSessionId) {
        return fail("no chat to fork (current chat id not yet known — pass session_id)");
      }
      const prompt = typeof args.prompt === "string" && args.prompt.trim().length > 0 ? args.prompt.trim() : undefined;
      const name = typeof args.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined;

      const { sessionId } = await write.forkChat({ projectSlug: project, sourceSessionId, prompt, name });
      return ok({ forked: true, project, sessionId, from: sourceSessionId });
    } catch (error) {
      return fail(`Error forking chat: ${errText(error)}`);
    }
  };
}

function sendMessageHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!sessionId) return fail("Error: `session_id` is required (get it from list_chats).");
      if (!prompt) return fail("Error: `prompt` is required (the message to send).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      await write.sendMessage(project, sessionId, prompt);
      return ok({ sent: true, project, sessionId });
    } catch (error) {
      return fail(`Error sending message: ${errText(error)}`);
    }
  };
}

/**
 * Normalize the `prompts` argument to a string array. The CLI-runtime MCP path
 * has proven unreliable at carrying an ARRAY-typed argument to the tool handler
 * (string args work; the array arrives dropped) — so we ALSO accept the list as a
 * string: a JSON array (`["a","b"]`) or newline-separated directives. Returns []
 * when nothing usable is present (handler then reports the required-arg error).
 */
export function coercePrompts(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((p) => (typeof p === "string" ? p : "")).map((p) => p.trim());
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.length === 0) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          return parsed.map((p) => (typeof p === "string" ? p : "")).map((p) => p.trim());
        }
      } catch {
        /* fall through to newline split */
      }
    }
    return s
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return [];
}

function forkChatBatchHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      // Diagnostic (issue #214): confirm what the CLI-runtime MCP transport
      // actually delivers for the list arg (array vs string vs dropped).
      const rawPrompts = args.prompts;
      console.error(
        `[self-mcp] fork_chat_batch prompts arg: type=${Array.isArray(rawPrompts) ? "array" : typeof rawPrompts} preview=${JSON.stringify(rawPrompts)?.slice(0, 200)}`,
      );
      const prompts = coercePrompts(rawPrompts);
      if (prompts.length === 0) {
        return fail(
          "Error: `prompts` is required — a non-empty list of directive strings " +
            "(a JSON array, or one directive per line).",
        );
      }
      if (prompts.length > FORK_BATCH_MAX) {
        return fail(`Error: too many prompts (${prompts.length}); max ${FORK_BATCH_MAX} forks per call.`);
      }
      if (prompts.some((p) => p.length === 0)) {
        return fail("Error: every entry in `prompts` must be a non-empty string.");
      }
      const clean = prompts;
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const sourceSessionId = explicit.length > 0 ? explicit : write.currentSessionId();
      if (!sourceSessionId) {
        return fail("no chat to fork (current chat id not yet known — pass session_id)");
      }
      const namePrefix =
        typeof args.name_prefix === "string" && args.name_prefix.trim().length > 0 ? args.name_prefix.trim() : undefined;

      // Concurrent fan-out; herdctl enforces the real concurrency cap downstream.
      const forks = await Promise.all(
        clean.map(async (prompt, i) => {
          const name = namePrefix ? `${namePrefix} ${i + 1}` : undefined;
          const { sessionId } = await write.forkChat({ projectSlug: project, sourceSessionId, prompt, name });
          return { sessionId, prompt };
        }),
      );
      return ok({ count: forks.length, source: sourceSessionId, forks });
    } catch (error) {
      return fail(`Error forking chat batch: ${errText(error)}`);
    }
  };
}

/**
 * Build the injected MCP server definition for the self-management tools, bound to
 * a per-turn context. The READ tools (list_projects/list_chats/read_chat) are
 * ALWAYS included. When a {@link SelfMcpWriteContext} is provided (the stricter
 * write flag is on), the four WRITE tools (create_chat/fork_chat/send_message/
 * fork_chat_batch) are appended too; omit it for unchanged read-only behavior.
 * Inject under {@link SELF_MCP_SERVER_KEY}.
 */
export function selfMcpServerDef(
  context: SelfMcpContext,
  write?: SelfMcpWriteContext,
): InjectedMcpServerDef {
  const tools: InjectedMcpServerDef["tools"] = [
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
  ];

  if (write) {
    tools.push(
      {
        name: "create_chat",
        description: CREATE_CHAT_DESC,
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The first turn to send to the new chat." },
            project: {
              type: "string",
              description: "Project slug to create the chat in. Omit to use the current project.",
            },
            name: { type: "string", description: "Optional display name for the new chat." },
            preload_context: {
              type: "boolean",
              description: "Seed the new chat with the project's OVERVIEW/context.",
            },
          },
          required: ["prompt"],
        },
        handler: createChatHandler(write),
      },
      {
        name: "fork_chat",
        description: FORK_CHAT_DESC,
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "Project slug that owns the source chat. Omit to use the current project.",
            },
            session_id: {
              type: "string",
              description: "Source chat's sessionId (from list_chats). Omit to fork the CURRENT chat.",
            },
            prompt: { type: "string", description: "Optional first turn to kick off the fork." },
            name: { type: "string", description: "Optional display name for the forked chat." },
          },
        },
        handler: forkChatHandler(write),
      },
      {
        name: "send_message",
        description: SEND_MESSAGE_DESC,
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Target chat's sessionId (from list_chats)." },
            prompt: { type: "string", description: "The message to send as a new turn." },
            project: {
              type: "string",
              description: "Project slug that owns the chat. Omit to use the current project.",
            },
          },
          required: ["session_id", "prompt"],
        },
        handler: sendMessageHandler(write),
      },
      {
        name: "fork_chat_batch",
        description: FORK_CHAT_BATCH_DESC,
        inputSchema: {
          type: "object",
          properties: {
            // Declared as a STRING (not array): the CLI-runtime MCP transport
            // reliably carries string args but has dropped array-typed args in
            // practice. The handler accepts a JSON array too (coercePrompts), but
            // telling the model to emit one directive per line is what works.
            prompts: {
              type: "string",
              description: `The fork directives — ONE per line (1..${FORK_BATCH_MAX} lines), each a non-empty instruction for that fork. A JSON array of strings is also accepted.`,
            },
            project: {
              type: "string",
              description: "Project slug that owns the source chat. Omit to use the current project.",
            },
            session_id: {
              type: "string",
              description: "Shared fork source's sessionId. Omit to fork the CURRENT chat.",
            },
            name_prefix: {
              type: "string",
              description: 'Optional; each fork is named "<name_prefix> <i>" (1-based).',
            },
          },
          required: ["prompts"],
        },
        handler: forkChatBatchHandler(write),
      },
    );
  }

  return { name: SERVER_NAME, version: "0.1.0", tools };
}

/** The record key + the fully-qualified tool names the agent sees. */
export const SELF_MCP_SERVER_KEY = SERVER_NAME;
export const SELF_MCP_TOOL_NAMES = {
  listProjects: `mcp__${SERVER_NAME}__list_projects`,
  listChats: `mcp__${SERVER_NAME}__list_chats`,
  readChat: `mcp__${SERVER_NAME}__read_chat`,
} as const;

/** The fully-qualified names of the Phase-2 WRITE tools (only present when the write flag is on). */
export const SELF_MCP_WRITE_TOOL_NAMES = {
  createChat: `mcp__${SERVER_NAME}__create_chat`,
  forkChat: `mcp__${SERVER_NAME}__fork_chat`,
  sendMessage: `mcp__${SERVER_NAME}__send_message`,
  forkChatBatch: `mcp__${SERVER_NAME}__fork_chat_batch`,
} as const;
