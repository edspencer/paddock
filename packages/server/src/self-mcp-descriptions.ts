/**
 * Agent-facing tool descriptions for the Paddock self-management MCP (issue #214).
 *
 * The long `*_DESC` prose the injected tools surface to the keeper agent, plus the
 * shared `MODEL_ARG_DESC` for the per-chat `model` override. Pure strings, split
 * out of `self-mcp.ts` so the logic file isn't dominated by prose. Some interpolate
 * the numeric caps from `self-mcp-util.ts` (which stay the single source of truth).
 */
import { MODELS } from "./models.js";
import {
  FORK_BATCH_MAX,
  READ_CHAT_DEFAULT_LIMIT,
  READ_CHAT_MAX_LIMIT,
  READ_CHAT_MAX_TEXT,
} from "./self-mcp-util.js";

/**
 * Shared schema description for the optional per-chat `model` override on the spawn
 * tools (create_chat / fork_chat / fork_chat_batch, issue #336). Lists the valid
 * ids from the SAME allow-list the web picker uses so the model stays in sync.
 */
export const MODEL_ARG_DESC =
  "Optional model for the spawned chat ONLY (not the project default). One of: " +
  `${MODELS.map((m) => m.id).join(", ")}. Omit to inherit the project/box default.`;

// ── Read tools ──────────────────────────────────────────────────────────────

export const LIST_PROJECTS_DESC =
  "List all Paddock projects (across every area). Returns each project's slug, " +
  "display name, area, and status. Use the slug to target `list_chats`/`read_chat`.";

export const LIST_CHATS_DESC =
  "List chats. Pass `project` (a slug) to list only that project's chats, or omit " +
  "it to list chats across ALL projects. Returns each chat's owning project, " +
  "sessionId, display name, last-updated time, and whether a turn is currently " +
  "running. Cheap — does not read full transcripts; use `read_chat` for content.";

export const READ_CHAT_DESC =
  "Read a trimmed tail of a chat's transcript. Pass `project` (slug) and " +
  "`session_id` (from `list_chats`). Returns the last `limit` messages (default " +
  `${READ_CHAT_DEFAULT_LIMIT}, max ${READ_CHAT_MAX_LIMIT}) as {role, text, timestamp}; each ` +
  `message's text is capped at ${READ_CHAT_MAX_TEXT} chars. Use this to see what ` +
  "another chat is about or what was decided there.";

// ── Write tools (Phase 2) ───────────────────────────────────────────────────

export const CREATE_CHAT_DESC =
  "Start a BRAND-NEW chat and kick it off with `prompt` (a full first turn to the " +
  "new keeper). Defaults to the current project; pass `project` (a slug) to create " +
  "it elsewhere. Set `name` to a concise 3–5 word title for the chat (STRONGLY " +
  "recommended — without it the title falls back to a long auto-summary of the " +
  "first turn). Optionally set `preload_context` to seed the new chat with the " +
  "project's OVERVIEW.md + CHANGELOG.md. Optionally set `model` to run the spawned " +
  "chat on a specific model (e.g. a cheaper/faster one) without changing the " +
  "project default. Returns the new chat's sessionId.";

export const FORK_CHAT_DESC =
  "Fork an existing chat into a NEW child chat that inherits its history, then " +
  "optionally kick the child off with `prompt`. Defaults to forking the CURRENT " +
  "chat (the one you're in) — omit `session_id` to fork yourself, or pass a " +
  "`session_id` (from list_chats) to fork another. Defaults to the current project; " +
  "pass `project` to fork one elsewhere. Optionally set `name`, and `model` to run " +
  "the child's kickoff turn on a specific model. Returns the new " +
  "chat's sessionId. For fanning one source out into many children, use " +
  "`fork_chat_batch` instead.";

export const SEND_MESSAGE_DESC =
  "Send `prompt` as a NEW turn to an existing chat (identified by `session_id` from " +
  "list_chats). Defaults to the current project; pass `project` to target a chat in " +
  "another project. Use this to hand work or context to a chat that already exists.";

export const ARCHIVE_CHAT_DESC =
  "Archive a chat — file it away into the collapsible \"Archived\" section without " +
  "touching its transcript (it stays fully openable/resumable/forkable). " +
  "Defaults to the CURRENT chat (the one you're in) — omit `session_id` to archive " +
  "YOURSELF, or pass a `session_id` (from list_chats) to archive another. Defaults " +
  "to the current project; pass `project` to target a chat elsewhere. This powers " +
  "the self-reporting convention: do the work, then archive yourself on success so " +
  "an un-archived chat is the signal that something needs a human's attention.";

export const UNARCHIVE_CHAT_DESC =
  "Unarchive a chat — bring it back out of the \"Archived\" section into the active " +
  "list. Defaults to the CURRENT chat — omit `session_id` to unarchive yourself, or " +
  "pass a `session_id` (from list_chats) to unarchive another. Defaults to the " +
  "current project; pass `project` to target a chat elsewhere.";

export const FORK_CHAT_BATCH_DESC =
  "FAN-OUT primitive: fork ONE source chat into many child chats at once — one child " +
  "per entry in `prompts`, each kicked off with its own prompt. Classic use: you " +
  "found N items (e.g. 10 changes) and want to fork this chat N times, one worker per " +
  "item. Pass `prompts` as one directive PER LINE. " +
  "Defaults the source to the CURRENT chat; pass `session_id` to fork a different " +
  "one, and `project` to target another project. With `name_prefix`, each fork is named " +
  `"<name_prefix> <i>" (1-based). With \`model\`, every fork's kickoff turn runs on ` +
  `that model. Up to ${FORK_BATCH_MAX} forks per call; they run ` +
  "concurrently. Returns the source and every new child's sessionId.";

// ── Unified trigger tools (Epic T / T3) ─────────────────────────────────────

export const SET_TRIGGER_DESC =
  "Create or update a unified project TRIGGER — a standing rule that runs an agent " +
  "turn when something happens, keyed by `name`. Enable/disable is just this call " +
  "with `enabled` flipped (no separate verb); a NEW trigger defaults disabled. " +
  "WHEN (`type`): \"schedule\" — a cron/interval fires it (give a 5-field `cron`, e.g. " +
  "\"0 9 * * *\" = 9am daily host-local, OR an `interval` like \"30m\"/\"1h\"); \"event\" — a " +
  "lifecycle `event` fires it (v1: \"onArchive\" — after a chat is archived; \"afterTurn\" " +
  "reserved); \"webhook\" — reserved (give a `path`), not yet fired. WHAT (the run): the " +
  "instruction as `prompt` (inline) OR `prompt_file` — a git-tracked `.md` under the " +
  "project's `.paddock/triggers/` dir (e.g. \"daily.md\"), read at fire time; `session` " +
  "\"new\" (a FRESH chat each fire, default) or \"resume\" (accrete the trigger's ONE owned " +
  "session); `tools` = the deny-by-default capability allow-list (one per line or " +
  "comma-separated, e.g. \"Bash, Read\"; omit / empty = a tool-less curator that only " +
  "returns text; a JSON array is also accepted); `model`, `permission_mode` " +
  "(\"default\"/\"acceptEdits\"/\"bypassPermissions\"/\"plan\"), `max_spawn_depth` (0 = may not " +
  "spawn), `max_turns`. Editing preserves omitted fields (so an `enabled`-only call " +
  "just flips the toggle); supplying `prompt` clears an inherited `prompt_file` and " +
  "vice versa; supplying `type` re-specifies the whole trigger. Defaults to the " +
  "current project; pass `project` (a slug) to target another.";

export const REMOVE_TRIGGER_DESC =
  "Delete a unified project trigger by `name` (removes it from `project.yaml` and " +
  "disarms its agent/schedule). Safe when absent — returns `removed: false` if no " +
  "such trigger. Defaults to the current project; pass `project` to target another.";

export const RUN_TRIGGER_DESC =
  "Fire a trigger NOW, on demand, by `name` — runs it through the SAME path a cron / " +
  "event fire uses, so the resulting chat is a first-class, badged run. Works for any " +
  "trigger type and regardless of its `enabled` flag (a manual run is deliberate). Use " +
  "this to test a trigger you just wrote or to kick one off out of band. Returns the " +
  "started chat's `sessionId`. Defaults to the current project; pass `project` to " +
  "target another.";

export const LIST_TRIGGERS_DESC =
  "List a project's unified triggers: each trigger's name, agent, `type` " +
  "(schedule/event/webhook), its WHEN fields (cron/interval, event, path), its run " +
  "(prompt/promptFile, session, tools, model, permissionMode, maxSpawnDepth, " +
  "maxTurns), and `enabled` — plus live runtime state (status, lastRunAt, nextRunAt, " +
  "lastError) for an armed schedule trigger. Read-only. Defaults to the current " +
  "project; pass `project` (a slug) to target another.";
