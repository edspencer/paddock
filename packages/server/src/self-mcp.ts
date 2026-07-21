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
 * A unified project TRIGGER as surfaced to the agent (Epic T "Unify Triggers" / T3
 * — the successor that collapses `SelfMcpSchedule` + `SelfMcpHook`). Flattens the
 * persisted {@link import("./trigger-config.js").TriggerDto} — the discriminated
 * `trigger` (WHEN: `schedule|event|webhook`) + the shared `run` (WHAT) + `enabled`
 * — plus the `trigger-<slug>-<name>` agent an event/webhook trigger registers as.
 * Nested `trigger`/`run` fields are flattened + null-normalised so the agent reads
 * ONE flat record regardless of type. For a `schedule` trigger, best-effort live
 * runtime state (`status`/`lastRunAt`/`nextRunAt`/`lastError`) is merged in when the
 * keeper has armed it (absent otherwise — and always absent for event/webhook).
 */
export interface SelfMcpTrigger {
  /** The trigger's stable key (the `project.yaml` map key + `<name>` in its agent). */
  name: string;
  /** The herdctl agent an event/webhook trigger registers as (`trigger-<slug>-<name>`). */
  agentName: string;
  /** WHEN: the discriminant — `schedule` (cron/interval), `event` (on), or `webhook` (path). */
  type: "schedule" | "event" | "webhook";
  /** The cron expression (schedule), else null. */
  cron: string | null;
  /** The interval string (schedule), else null. */
  interval: string | null;
  /** The lifecycle event this fires on (event trigger, e.g. `onArchive`), else null. */
  event: string | null;
  /** The ingress path (webhook trigger — reserved, unbuilt), else null. */
  path: string | null;
  /** WHAT: the inline prompt, or null when a `promptFile` drives it. */
  prompt: string | null;
  /** The `.paddock/triggers/` prompt-file name, or null. */
  promptFile: string | null;
  /** `new` = a fresh chat each fire; `resume` = one owned accreting session. */
  session: "new" | "resume";
  /** The tools the fired agent may use (its capability grant); `[]` = tool-less. */
  tools: string[];
  /** Recursion bound for internal spawning (0 = may not spawn), or null (default). */
  maxSpawnDepth: number | null;
  /** The permission mode the fired agent's turns run under, or null (fleet default). */
  permissionMode: string | null;
  /** Model override for the fired agent, or null (keeper default). */
  model: string | null;
  /** Max agent turns bounding a runaway trigger, or null (trigger default). */
  maxTurns: number | null;
  /** Whether the trigger is armed. New triggers default `false` (GG-3). */
  enabled: boolean;
  /** Live status for an armed schedule trigger (`idle`/`running`/`disabled`), else null. */
  status?: string | null;
  /** ISO time of the last fire (schedule trigger), or null. */
  lastRunAt?: string | null;
  /** ISO time of the next scheduled fire (schedule trigger), or null. */
  nextRunAt?: string | null;
  /** The last fire's error message (schedule trigger), or null. */
  lastError?: string | null;
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
  /** Set (or clear) a chat's archived flag (presentational metadata only). */
  setArchived: (projectSlug: string, sessionId: string, archived: boolean) => Promise<void>;
  /**
   * Whether the unified trigger-management MCP is enabled for THIS turn's project
   * (Epic T / T3 — the successor to the G5 hook-MCP gate, resolved from the SAME
   * per-project `hooksMcpEnabled` opt-in against the instance default; the gate is
   * REUSED, not reinvented). When false the trigger tools (`list_triggers`/
   * `set_trigger`/`remove_trigger`) are NOT injected at all (absent, not present-
   * but-refusing) — the design's binary "does this project agent get the trigger
   * MCP at all" gate. The caller resolves this per project (see
   * {@link import("./hook-config.js").resolveHooksMcpEnabled}).
   */
  triggersMcpEnabled: boolean;
  /**
   * List a project's unified triggers (Epic T / T3). Read-only; reads the live
   * project record (merging best-effort schedule runtime state). Present regardless
   * of {@link triggersMcpEnabled} on the context, but the tools are only injected
   * when that flag is on.
   */
  listTriggers: (projectSlug: string) => Promise<SelfMcpTrigger[]>;
  /**
   * Create or update a trigger (keyed by `name`) — persists to `project.yaml`'s
   * single `triggers` block and arms it. `trigger` is a PARTIAL structured record
   * (`{ trigger?, run?, enabled? }`, camelCase) the caller merges over the existing
   * trigger (via `mergeTriggerUpdate`) then validates + sanitises (throwing on a
   * malformed record), defaulting a brand-new trigger to `enabled: false` (GG-3).
   * Enable/disable is just this call with `enabled` flipped (GG-3) — no separate
   * verb. Returns the saved trigger.
   */
  setTrigger: (projectSlug: string, name: string, trigger: Record<string, unknown>) => Promise<SelfMcpTrigger>;
  /**
   * Remove a trigger by `name` — persisted removal + disarming its agent/schedule.
   * Returns `true` when a trigger existed, `false` when it was already absent.
   */
  removeTrigger: (projectSlug: string, name: string) => Promise<boolean>;
  /**
   * Fire a trigger by `name` NOW (Epic T follow-up / #327) — through the same hub
   * path a cron / event fire uses. Returns the started chat's sessionId, or `null` if
   * the project/trigger is gone or the turn never produced a session.
   */
  runTrigger: (projectSlug: string, name: string) => Promise<string | null>;
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
  "it elsewhere. Set `name` to a concise 3–5 word title for the chat (STRONGLY " +
  "recommended — without it the title falls back to a long auto-summary of the " +
  "first turn). Optionally set `preload_context` to seed the new chat with the " +
  "project's OVERVIEW.md + CHANGELOG.md. Returns the new chat's sessionId.";

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

const ARCHIVE_CHAT_DESC =
  "Archive a chat — file it away into the collapsible \"Archived\" section without " +
  "touching its transcript (it stays fully openable/resumable/forkable). " +
  "Defaults to the CURRENT chat (the one you're in) — omit `session_id` to archive " +
  "YOURSELF, or pass a `session_id` (from list_chats) to archive another. Defaults " +
  "to the current project; pass `project` to target a chat elsewhere. This powers " +
  "the self-reporting convention: do the work, then archive yourself on success so " +
  "an un-archived chat is the signal that something needs a human's attention.";

const UNARCHIVE_CHAT_DESC =
  "Unarchive a chat — bring it back out of the \"Archived\" section into the active " +
  "list. Defaults to the CURRENT chat — omit `session_id` to unarchive yourself, or " +
  "pass a `session_id` (from list_chats) to unarchive another. Defaults to the " +
  "current project; pass `project` to target a chat elsewhere.";

const SET_TRIGGER_DESC =
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

const REMOVE_TRIGGER_DESC =
  "Delete a unified project trigger by `name` (removes it from `project.yaml` and " +
  "disarms its agent/schedule). Safe when absent — returns `removed: false` if no " +
  "such trigger. Defaults to the current project; pass `project` to target another.";

const RUN_TRIGGER_DESC =
  "Fire a trigger NOW, on demand, by `name` — runs it through the SAME path a cron / " +
  "event fire uses, so the resulting chat is a first-class, badged run. Works for any " +
  "trigger type and regardless of its `enabled` flag (a manual run is deliberate). Use " +
  "this to test a trigger you just wrote or to kick one off out of band. Returns the " +
  "started chat's `sessionId`. Defaults to the current project; pass `project` to " +
  "target another.";

const LIST_TRIGGERS_DESC =
  "List a project's unified triggers: each trigger's name, agent, `type` " +
  "(schedule/event/webhook), its WHEN fields (cron/interval, event, path), its run " +
  "(prompt/promptFile, session, tools, model, permissionMode, maxSpawnDepth, " +
  "maxTurns), and `enabled` — plus live runtime state (status, lastRunAt, nextRunAt, " +
  "lastError) for an armed schedule trigger. Read-only. Defaults to the current " +
  "project; pass `project` (a slug) to target another.";

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
      // Echo the human-readable name + kickoff prompt so the chat renders with its
      // real title (not just a link) both live and on reload (#253). When no name
      // was given the web derives a title from the prompt (matching the sidebar's
      // auto-name). Prompt is capped to bound the tool-result payload.
      return ok({ created: true, project, sessionId, name, prompt: truncateText(prompt) });
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
      return ok({
        forked: true,
        project,
        sessionId,
        from: sourceSessionId,
        name,
        prompt: prompt ? truncateText(prompt) : undefined,
      });
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
      // Echo the sent message so the tool renders the actual message text (#253).
      return ok({ sent: true, project, sessionId, prompt: truncateText(prompt) });
    } catch (error) {
      return fail(`Error sending message: ${errText(error)}`);
    }
  };
}

/**
 * Handler factory for archive_chat / unarchive_chat. Both resolve the target the
 * same way — `session_id` OPTIONAL, defaulting to the CURRENT chat so an agent can
 * archive ITSELF without knowing its own id (mirrors fork_chat's self-default) —
 * and differ only in the boolean they set. `archived` selects which tool this is.
 */
function archiveChatHandler(write: SelfMcpWriteContext, archived: boolean) {
  const verb = archived ? "archiving" : "unarchiving";
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const sessionId = explicit.length > 0 ? explicit : write.currentSessionId();
      if (!sessionId) {
        return fail("no chat to archive (current chat id not yet known — pass session_id)");
      }
      await write.setArchived(project, sessionId, archived);
      return ok({ archived, project, sessionId });
    } catch (error) {
      return fail(`Error ${verb} chat: ${errText(error)}`);
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

/**
 * Normalize a tool-list argument (a hook's `allowed_tools`/`denied_tools`) to a
 * string array. Like {@link coercePrompts}, tolerant of the CLI-runtime MCP
 * transport dropping ARRAY-typed args: accepts a real array, a JSON array string,
 * or a comma/newline-separated string (tool names never contain commas). Blanks
 * are dropped; returns [] when nothing usable is present (a tool-less hook).
 */
export function coerceToolList(raw: unknown): string[] {
  const clean = (arr: unknown[]): string[] =>
    arr.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0);
  if (Array.isArray(raw)) return clean(raw);
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.length === 0) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return clean(parsed);
      } catch {
        /* fall through to delimiter split */
      }
    }
    return clean(s.split(/[\n,]/));
  }
  return [];
}

function forkChatBatchHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const prompts = coercePrompts(args.prompts);
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

// ── Unified trigger tools (Epic T "Unify Triggers" / T3) ────────────────────
// Collapse the paired schedule (issue #289) + hook (Epic G / G5) verbs onto ONE
// TriggerService over `project.yaml`'s single `triggers` block. A trigger is WHEN
// (`type` schedule|event|webhook) + WHAT (the shared run) + `enabled`. Injected
// ONLY when the project opted into the trigger-management MCP (`triggersMcpEnabled`,
// resolved from the REUSED per-project hooks-MCP gate) — a coarse binary gate, no
// per-capability gating. Enable/disable is `set_trigger` with `enabled` flipped
// (GG-3), not a separate verb.

/**
 * Assemble the PARTIAL structured `{ trigger?, run?, enabled? }` record the
 * `set_trigger` handler passes to `write.setTrigger` (which merges it over the
 * existing trigger via `mergeTriggerUpdate`, then validates). Only fields the
 * caller actually supplied are set, so an edit that omits a field preserves it
 * (create-or-update patch semantics) — the classic being an `enabled`-only flip.
 * Flat MCP args are the robust transport (the CLI runtime drops nested/array args,
 * so the discriminant is rebuilt here from scalar args). Returns a string error
 * message instead of a partial when a supplied `type`'s required WHEN field is
 * missing; `null` on none.
 */
function buildTriggerUpdate(args: Record<string, unknown>): Record<string, unknown> | string {
  const incoming: Record<string, unknown> = {};

  // WHEN: only when `type` is supplied does the caller (re)specify the discriminant;
  // an omitted `type` inherits the existing trigger's WHEN unchanged (partial edit).
  const type = typeof args.type === "string" ? args.type.trim() : "";
  if (type) {
    if (type === "schedule") {
      const cron = typeof args.cron === "string" ? args.cron.trim() : "";
      const interval = typeof args.interval === "string" ? args.interval.trim() : "";
      if (!cron && !interval) {
        return 'Error: a "schedule" trigger needs `cron` (a 5-field expression, e.g. "0 9 * * *") or `interval` (e.g. "30m").';
      }
      if (cron && interval) {
        return 'Error: a "schedule" trigger takes exactly ONE of `cron` or `interval`, not both.';
      }
      incoming.trigger = cron ? { type, cron } : { type, interval };
    } else if (type === "event") {
      const event = typeof args.event === "string" ? args.event.trim() : "";
      if (!event) return 'Error: an "event" trigger needs `event` (the lifecycle trigger, e.g. "onArchive").';
      incoming.trigger = { type, on: event };
    } else if (type === "webhook") {
      const p = typeof args.path === "string" ? args.path.trim() : "";
      if (!p) return 'Error: a "webhook" trigger needs `path` (the ingress path; reserved — not yet fired).';
      incoming.trigger = { type, path: p };
    } else {
      return 'Error: `type` must be "schedule", "event", or "webhook".';
    }
  }

  // WHAT: assemble only the run fields the caller supplied.
  const run: Record<string, unknown> = {};
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const promptFile = typeof args.prompt_file === "string" ? args.prompt_file.trim() : "";
  if (prompt) run.prompt = prompt;
  if (promptFile) run.promptFile = promptFile;
  if (typeof args.session === "string" && (args.session === "new" || args.session === "resume")) {
    run.session = args.session;
  }
  if (typeof args.model === "string" && args.model.trim() !== "") run.model = args.model.trim();
  // `tools` is present (even as "") → set it (an empty list = a tool-less curator);
  // absent → leave the existing grant untouched on an edit.
  if (args.tools !== undefined) run.tools = coerceToolList(args.tools);
  if (typeof args.max_spawn_depth === "number") run.maxSpawnDepth = args.max_spawn_depth;
  if (typeof args.permission_mode === "string" && args.permission_mode.trim() !== "") {
    run.permissionMode = args.permission_mode.trim();
  }
  if (typeof args.max_turns === "number") run.maxTurns = args.max_turns;
  if (Object.keys(run).length > 0) incoming.run = run;

  if (typeof args.enabled === "boolean") incoming.enabled = args.enabled;
  return incoming;
}

function setTriggerHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the trigger's key).");
      const incoming = buildTriggerUpdate(args);
      if (typeof incoming === "string") return fail(incoming);

      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const saved = await write.setTrigger(project, name, incoming);
      return ok({ set: true, project, trigger: saved });
    } catch (error) {
      return fail(`Error setting trigger: ${errText(error)}`);
    }
  };
}

function removeTriggerHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the trigger to remove).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const removed = await write.removeTrigger(project, name);
      return ok({ removed, project, name });
    } catch (error) {
      return fail(`Error removing trigger: ${errText(error)}`);
    }
  };
}

function listTriggersHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const triggers = await write.listTriggers(project);
      return ok({ project, count: triggers.length, triggers });
    } catch (error) {
      return fail(`Error listing triggers: ${errText(error)}`);
    }
  };
}

function runTriggerHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the trigger to run).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const sessionId = await write.runTrigger(project, name);
      if (!sessionId) {
        return fail(
          `Error running trigger “${name}”: no such trigger, or it did not start a chat.`,
        );
      }
      return ok({ ran: true, project, name, sessionId });
    } catch (error) {
      return fail(`Error running trigger: ${errText(error)}`);
    }
  };
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
 * set_trigger/remove_trigger) are appended as well. Inject under
 * {@link SELF_MCP_SERVER_KEY}.
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
          },
          required: ["prompts"],
        },
        handler: forkChatBatchHandler(write),
      },
    );

    // Unified trigger-management tools (Epic T / T3): a coarse capability layered on
    // the write tools and gated by the project's own trigger-MCP opt-in
    // (`triggersMcpEnabled`, resolved from the REUSED hooks-MCP gate). When off the
    // tools are ABSENT (not present-but-refusing) — the design's binary "does this
    // project agent get the trigger MCP at all" gate. These COLLAPSE what were the
    // separate schedule (set/remove/list_schedule) + hook (set/remove/list_hook) verbs.
    if (write.triggersMcpEnabled) {
      tools.push(
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
      );
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
