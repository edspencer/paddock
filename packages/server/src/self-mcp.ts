/**
 * Paddock self-management MCP — assembly root (issue #214).
 *
 * Exposes the `paddock_manage` tools that let a keeper agent inspect and drive
 * Paddock itself: enumerate projects/chats + read transcripts (READ, always on),
 * create/fork/message/archive chats (WRITE, Phase 2), and manage a project's
 * unified triggers (Epic T / T3). This module is the thin assembly layer — it
 * wires the extracted pieces into one {@link InjectedMcpServerDef}, conditionally
 * by capability tier, and owns the public name-map exports. The actual logic lives
 * in siblings, all re-exported here so existing importers keep one import path:
 *   - `self-mcp-types.ts`        — the DTOs + the two per-turn context bags
 *   - `self-mcp-util.ts`         — result envelopes, clamps, arg coercion + caps
 *   - `self-mcp-descriptions.ts` — the agent-facing `*_DESC` prose
 *   - `self-mcp-read.ts`         — list_projects / list_chats / read_chat handlers
 *   - `self-mcp-write.ts`        — create/fork/send/archive/fork-batch handlers
 *   - `self-mcp-triggers.ts`     — list/set/remove/run trigger handlers
 *
 * ── How it reaches the keeper ───────────────────────────────────────────────
 * Injected via herdctl's `injectedMcpServers` mechanism, exactly like the
 * send_file tool (see send-file-mcp.ts): the CLI-runtime keeper can't reach an
 * in-process SDK MCP server, so herdctl stands up a localhost HTTP MCP bridge for
 * each injected server and auto-allowlists its `mcp__<name>__*` tools. The tools
 * surface to the agent as `mcp__paddock_manage__{list_projects,list_chats,…}`.
 *
 * The module stays pure: it takes narrow bags of async callbacks (wired to
 * ProjectStore/HerdctlService by the caller) so the trimming/validation logic is
 * unit-testable without the fleet. Tool outputs are plain JSON text for the AGENT
 * to read (not a render envelope like send_file).
 */
import type { InjectedMcpServerDef } from "@herdctl/core";
import type { SelfMcpContext, SelfMcpWriteContext } from "./self-mcp-types.js";
import {
  FORK_BATCH_MAX,
  READ_CHAT_DEFAULT_LIMIT,
  READ_CHAT_MAX_LIMIT,
} from "./self-mcp-util.js";
import {
  MODEL_ARG_DESC,
  LIST_PROJECTS_DESC,
  LIST_CHATS_DESC,
  READ_CHAT_DESC,
  CREATE_CHAT_DESC,
  FORK_CHAT_DESC,
  SEND_MESSAGE_DESC,
  ARCHIVE_CHAT_DESC,
  UNARCHIVE_CHAT_DESC,
  FORK_CHAT_BATCH_DESC,
  SET_TRIGGER_DESC,
  REMOVE_TRIGGER_DESC,
  RUN_TRIGGER_DESC,
  LIST_TRIGGERS_DESC,
} from "./self-mcp-descriptions.js";
import { listProjectsHandler, listChatsHandler, readChatHandler } from "./self-mcp-read.js";
import {
  createChatHandler,
  forkChatHandler,
  sendMessageHandler,
  archiveChatHandler,
  forkChatBatchHandler,
} from "./self-mcp-write.js";
import {
  listTriggersHandler,
  setTriggerHandler,
  removeTriggerHandler,
  runTriggerHandler,
} from "./self-mcp-triggers.js";

// ── Public surface re-exports ───────────────────────────────────────────────
// Everything importers reached for lives in the siblings now; re-export it here so
// `./self-mcp.js` remains the one import path (ws.ts, wake-injection.ts, tests).
export type {
  SelfMcpProject,
  SelfMcpChat,
  SelfMcpMessage,
  SelfMcpTrigger,
  SelfMcpContext,
  SelfMcpWriteContext,
} from "./self-mcp-types.js";
export {
  FORK_BATCH_MAX,
  READ_CHAT_DEFAULT_LIMIT,
  READ_CHAT_MAX_LIMIT,
  READ_CHAT_MAX_TEXT,
  clampLimit,
  truncateText,
  resolveModelArg,
  coercePrompts,
  coerceToolList,
} from "./self-mcp-util.js";

const SERVER_NAME = "paddock_manage";

type ServerTools = InjectedMcpServerDef["tools"];

/** The always-on READ tools (list_projects / list_chats / read_chat). */
function readTools(context: SelfMcpContext): ServerTools {
  return [
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
}

/** The Phase-2 WRITE tools (create/fork/send/archive/unarchive/fork-batch). */
function writeTools(write: SelfMcpWriteContext): ServerTools {
  return [
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
          name: {
            type: "string",
            description:
              "Concise 3–5 word display name for the new chat (e.g. \"Fix login redirect bug\"). " +
              "Strongly recommended: without it the title falls back to a long auto-summary.",
          },
          preload_context: {
            type: "boolean",
            description: "Seed the new chat with the project's OVERVIEW.md + CHANGELOG.md.",
          },
          model: { type: "string", description: MODEL_ARG_DESC },
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
          model: {
            type: "string",
            description: `${MODEL_ARG_DESC} Applies to the kickoff turn only (a fork with no \`prompt\` runs no turn).`,
          },
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
      name: "archive_chat",
      description: ARCHIVE_CHAT_DESC,
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Chat's sessionId (from list_chats). Omit to archive the CURRENT chat (yourself).",
          },
          project: {
            type: "string",
            description: "Project slug that owns the chat. Omit to use the current project.",
          },
        },
      },
      handler: archiveChatHandler(write, true),
    },
    {
      name: "unarchive_chat",
      description: UNARCHIVE_CHAT_DESC,
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Chat's sessionId (from list_chats). Omit to unarchive the CURRENT chat (yourself).",
          },
          project: {
            type: "string",
            description: "Project slug that owns the chat. Omit to use the current project.",
          },
        },
      },
      handler: archiveChatHandler(write, false),
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
          model: {
            type: "string",
            description: `${MODEL_ARG_DESC} Applies to EVERY fork's kickoff turn in this fan-out.`,
          },
        },
        required: ["prompts"],
      },
      handler: forkChatBatchHandler(write),
    },
  ];
}

/**
 * The Epic T / T3 unified trigger-management tools (list/set/remove/run). Appended
 * only when {@link SelfMcpWriteContext.triggersMcpEnabled} is on — a coarse binary
 * gate: when off the tools are ABSENT (not present-but-refusing). These COLLAPSE
 * what were the separate schedule + hook verbs.
 */
function triggerTools(write: SelfMcpWriteContext): ServerTools {
  return [
    {
      name: "list_triggers",
      description: LIST_TRIGGERS_DESC,
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project slug to list. Omit to use the current project.",
          },
        },
      },
      handler: listTriggersHandler(write),
    },
    {
      name: "set_trigger",
      description: SET_TRIGGER_DESC,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The trigger's stable key (create or update)." },
          type: {
            type: "string",
            enum: ["schedule", "event", "webhook"],
            description:
              "WHEN the trigger fires. Omit on an edit to keep the existing WHEN; supply it " +
              "(with its fields) to (re)specify the trigger. \"schedule\" needs `cron` or " +
              "`interval`; \"event\" needs `event`; \"webhook\" needs `path` (reserved).",
          },
          cron: {
            type: "string",
            description: 'For a "schedule" trigger: a 5-field cron expression (e.g. "0 9 * * *"), host-local time. Exactly one of `cron`/`interval`.',
          },
          interval: {
            type: "string",
            description: 'For a "schedule" trigger: a duration string (e.g. "30m", "1h"). Exactly one of `cron`/`interval`.',
          },
          event: {
            type: "string",
            description: 'For an "event" trigger: the lifecycle trigger (v1: "onArchive").',
          },
          path: {
            type: "string",
            description: 'For a "webhook" trigger: the ingress path (reserved — not yet fired).',
          },
          prompt: {
            type: "string",
            description: "Inline instruction the fired turn runs. Provide this OR `prompt_file`.",
          },
          prompt_file: {
            type: "string",
            description:
              'A `.md` file under the project\'s `.paddock/triggers/` dir (e.g. "daily.md"), ' +
              "read at fire time. Alternative to `prompt` for long, version-tracked prompts.",
          },
          session: {
            type: "string",
            enum: ["new", "resume"],
            description:
              '"new" (default) → a fresh chat each fire; "resume" → accrete into the trigger\'s one owned session.',
          },
          tools: {
            type: "string",
            description:
              "The fired agent's capability = a deny-by-default allow-list — one per line or " +
              'comma-separated (e.g. "Bash, Read, Write"). Omit / empty = a tool-less curator. A JSON array is also accepted.',
          },
          model: { type: "string", description: "Model override for the fired agent." },
          permission_mode: {
            type: "string",
            enum: ["default", "acceptEdits", "bypassPermissions", "plan"],
            description: "Permission mode the fired agent's turns run under.",
          },
          max_spawn_depth: {
            type: "number",
            description: "Recursion bound for internal spawning (0 = may not spawn).",
          },
          max_turns: {
            type: "number",
            description: "Max agent turns bounding a runaway trigger.",
          },
          enabled: {
            type: "boolean",
            description:
              "Whether the trigger is armed. Default FALSE on a NEW trigger; omitted on an " +
              "existing trigger leaves it unchanged (so an `enabled`-only call just flips it).",
          },
          project: {
            type: "string",
            description: "Project slug to target. Omit to use the current project.",
          },
        },
        required: ["name"],
      },
      handler: setTriggerHandler(write),
    },
    {
      name: "remove_trigger",
      description: REMOVE_TRIGGER_DESC,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The trigger to remove." },
          project: {
            type: "string",
            description: "Project slug that owns the trigger. Omit to use the current project.",
          },
        },
        required: ["name"],
      },
      handler: removeTriggerHandler(write),
    },
    {
      name: "run_trigger",
      description: RUN_TRIGGER_DESC,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The trigger to fire now." },
          project: {
            type: "string",
            description: "Project slug that owns the trigger. Omit to use the current project.",
          },
        },
        required: ["name"],
      },
      handler: runTriggerHandler(write),
    },
  ];
}

/**
 * Build the injected MCP server definition for the self-management tools, bound to
 * a per-turn context. The READ tools (list_projects/list_chats/read_chat) are
 * ALWAYS included. When a {@link SelfMcpWriteContext} is provided (the stricter
 * write flag is on), the WRITE tools (create_chat/fork_chat/send_message/
 * archive_chat/unarchive_chat/fork_chat_batch) are appended too; omit it for
 * unchanged read-only behavior. When that write context additionally has
 * {@link SelfMcpWriteContext.triggersMcpEnabled} on (the per-project trigger-MCP
 * opt-in, Epic T / T3), the unified trigger-management tools (list_triggers/
 * set_trigger/remove_trigger/run_trigger) are appended as well. Inject under
 * {@link SELF_MCP_SERVER_KEY}.
 */
export function selfMcpServerDef(
  context: SelfMcpContext,
  write?: SelfMcpWriteContext,
): InjectedMcpServerDef {
  const tools: ServerTools = [...readTools(context)];

  if (write) {
    tools.push(...writeTools(write));
    if (write.triggersMcpEnabled) {
      tools.push(...triggerTools(write));
    }
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
  archiveChat: `mcp__${SERVER_NAME}__archive_chat`,
  unarchiveChat: `mcp__${SERVER_NAME}__unarchive_chat`,
  forkChatBatch: `mcp__${SERVER_NAME}__fork_chat_batch`,
} as const;

/**
 * The fully-qualified names of the Epic T / T3 unified trigger-management tools
 * (only present when a write context has {@link SelfMcpWriteContext.triggersMcpEnabled}
 * on). These collapse the former schedule (set/remove/list_schedule) + hook
 * (set/remove/list_hook) verbs.
 */
export const SELF_MCP_TRIGGER_TOOL_NAMES = {
  listTriggers: `mcp__${SERVER_NAME}__list_triggers`,
  setTrigger: `mcp__${SERVER_NAME}__set_trigger`,
  removeTrigger: `mcp__${SERVER_NAME}__remove_trigger`,
  runTrigger: `mcp__${SERVER_NAME}__run_trigger`,
} as const;
