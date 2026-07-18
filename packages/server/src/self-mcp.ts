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
 * A durable project schedule as surfaced to the agent (issue #289). Merges the
 * `project.yaml` declaration (herdctl's `ScheduleSchema` shape) with herdctl's
 * live runtime state (`status`/`lastRunAt`/`nextRunAt`/`lastError`), which is
 * absent until the keeper has armed the schedule. Field names mirror the Settings
 * pane DTO so the two surfaces stay in step.
 */
export interface SelfMcpSchedule {
  /** The schedule's stable key. */
  name: string;
  /** `cron` (a 5-field expression) or `interval` (e.g. `"30m"`). */
  type: "cron" | "interval";
  /** The cron expression, or null for an interval schedule. */
  cron: string | null;
  /** The interval string, or null for a cron schedule. */
  interval: string | null;
  /** The inline prompt, or null when a `promptFile` drives it. */
  prompt: string | null;
  /** The `.paddock/schedules/` prompt-file name, or null. */
  promptFile: string | null;
  /** Whether the schedule accretes into its one owned session (else fresh each fire). */
  resumeSession: boolean;
  /** Whether the schedule is armed. */
  enabled: boolean;
  /** Live status when armed (`idle`/`running`/`disabled`), else null. */
  status?: string | null;
  /** ISO time of the last fire, or null. */
  lastRunAt?: string | null;
  /** ISO time of the next scheduled fire, or null. */
  nextRunAt?: string | null;
  /** The last fire's error message, or null. */
  lastError?: string | null;
}

/**
 * A project event hook as surfaced to the agent (Epic G / G5). Flattens the
 * persisted {@link import("./hook-config.js").HookDto} — a lifecycle `event` + a
 * capability set + a prompt (inline or `.paddock/hooks/*.md`) + `enabled` — plus the
 * `hook-<slug>-<name>` agent it registers as. Field names mirror the Hooks-tab DTO
 * (G4) so the two surfaces stay in step; nested capability fields are flattened +
 * null-normalised (like {@link SelfMcpSchedule}) so the agent reads a flat record.
 */
export interface SelfMcpHook {
  /** The hook's stable key (the `project.yaml` map key + the `<name>` in its agent). */
  name: string;
  /** The herdctl agent this hook registers as (`hook-<slug>-<name>`). */
  agentName: string;
  /** The lifecycle event this hook fires on (v1: `onArchive`). */
  event: string;
  /** Whether the hook is armed. New hooks default `false` (GG-3). */
  enabled: boolean;
  /** The inline prompt, or null when a `promptFile` drives it. */
  prompt: string | null;
  /** The `.paddock/hooks/` prompt-file name, or null. */
  promptFile: string | null;
  /** The tools the hook agent may use (its capability grant); `[]` = tool-less. */
  allowedTools: string[];
  /** Tools explicitly denied even if otherwise allowed. */
  deniedTools: string[];
  /** The permission mode the hook agent's turns run under, or null (fleet default). */
  permissionMode: string | null;
  /** Model override for the hook agent, or null (keeper default). */
  model: string | null;
  /** Max agent turns bounding a runaway hook, or null (hook default). */
  maxTurns: number | null;
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
   * Whether programmatic schedule mutation is enabled on this deployment (DD-7's
   * per-deployment gate, `PADDOCK_SCHEDULE_MUTATION`). `set_schedule` /
   * `remove_schedule` refuse with a clear error when this is false; `list_schedules`
   * is read-only and unaffected — mirrors the REST routes (PUT/DELETE 403, GET open).
   */
  scheduleMutationEnabled: boolean;
  /**
   * List a project's schedules — the `project.yaml` declaration merged with
   * herdctl's live runtime state. Read-only.
   */
  listSchedules: (projectSlug: string) => Promise<SelfMcpSchedule[]>;
  /**
   * Create or replace a schedule (keyed by `name`) — persists to `project.yaml`
   * and arms herdctl. `schedule` is the herdctl `ScheduleSchema` record (`type`,
   * `cron`/`interval`, `prompt`/`promptFile`, `resume_session`, `enabled`); the
   * caller validates + sanitises it (throwing on a malformed record). Returns the
   * saved schedule.
   */
  setSchedule: (projectSlug: string, name: string, schedule: Record<string, unknown>) => Promise<SelfMcpSchedule>;
  /**
   * Remove a schedule by `name` — persisted removal + unarming herdctl. Returns
   * `true` when a schedule existed, `false` when it was already absent.
   */
  removeSchedule: (projectSlug: string, name: string) => Promise<boolean>;
  /**
   * Whether the hook-management MCP is enabled for THIS turn's project (Epic G /
   * G5, GG-4) — the per-project `hooksMcpEnabled` opt-in resolved against the
   * instance default. When false the hook tools (`list_hooks`/`set_hook`/
   * `remove_hook`) are NOT injected at all (absent, not present-but-refusing) —
   * distinct from the schedule tools' runtime-refuse gate. The caller resolves this
   * per project (see {@link import("./hook-config.js").resolveHooksMcpEnabled}).
   */
  hooksMcpEnabled: boolean;
  /**
   * List a project's event hooks (Epic G / G5). Read-only; reads the live project
   * record. Present regardless of {@link hooksMcpEnabled} on the context, but the
   * tools are only injected when that flag is on.
   */
  listHooks: (projectSlug: string) => Promise<SelfMcpHook[]>;
  /**
   * Create or replace a hook (keyed by `name`) — persists to `project.yaml` and
   * registers its `hook-<slug>-<name>` agent. `hook` is the {@link import(
   * "./hook-config.js").PaddockHook} record (`event`, `capabilities`, `prompt`/
   * `promptFile`, `enabled`); the caller validates + sanitises it (throwing on a
   * malformed record) and defaults a brand-new hook to `enabled: false` (GG-3).
   * Returns the saved hook.
   */
  setHook: (projectSlug: string, name: string, hook: Record<string, unknown>) => Promise<SelfMcpHook>;
  /**
   * Remove a hook by `name` — persisted removal + unregistering its agent. Returns
   * `true` when a hook existed, `false` when it was already absent.
   */
  removeHook: (projectSlug: string, name: string) => Promise<boolean>;
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

const SET_SCHEDULE_DESC =
  "Create or update a durable PROJECT schedule — a chat that a cron/interval " +
  "triggers instead of a person, keyed by `name`. (Distinct from the ephemeral, " +
  "session-scoped `ScheduleWakeup`: this persists in the project config, fires even " +
  "when nobody is watching, and each fire appears as a new chat with a `scheduled` " +
  "badge.) Shape (herdctl `ScheduleSchema`): `type` is \"cron\" with a 5-field `cron` " +
  "expression (e.g. \"0 9 * * *\" = 9am daily, host-local time) OR \"interval\" with an " +
  "`interval` string (e.g. \"30m\", \"1h\"). Give the instruction as `prompt` (inline) " +
  "OR `prompt_file` — a git-tracked, keeper-editable `.md` under the project's " +
  "`.paddock/schedules/` dir (e.g. \"daily-triage.md\"), read at fire time (handy for " +
  "long multi-line prompts you want to version). `resume_session` (default false): " +
  "false → a FRESH chat each fire; true → resume the schedule's ONE owned session so " +
  "a 'manager' accretes a single transcript over time. `enabled` (default true). " +
  "Defaults to the current project; pass `project` (a slug) to target another. " +
  "Requires the deployment's schedule-mutation gate to be enabled.";

const REMOVE_SCHEDULE_DESC =
  "Delete a durable project schedule by `name` (removes it from `project.yaml` and " +
  "unarms the cron). Safe when absent — returns `removed: false` if no such schedule. " +
  "Defaults to the current project; pass `project` to target another. Requires the " +
  "deployment's schedule-mutation gate.";

const LIST_SCHEDULES_DESC =
  "List a project's durable schedules: each schedule's name, type, cron/interval, " +
  "prompt/promptFile, resumeSession, and enabled flag, plus live runtime state " +
  "(status, lastRunAt, nextRunAt, lastError) once the keeper has armed it. Read-only. " +
  "Defaults to the current project; pass `project` (a slug) to target another.";

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

// ── Schedule tools (issue #289) ─────────────────────────────────────────────
// Expose the existing D3/D4 schedule CRUD (ProjectStore + herdctl runtime
// mutation, behind the per-deployment mutation gate) so a keeper can define and
// manage durable project schedules itself — not just a human via the Settings UI.

/** Shared message when the deployment hasn't opted into schedule mutation. */
const SCHEDULE_MUTATION_DISABLED =
  "Schedule mutation is disabled on this deployment (the schedule-mutation gate is " +
  "off). You can `list_schedules` but not add or remove one.";

function setScheduleHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      if (!write.scheduleMutationEnabled) return fail(SCHEDULE_MUTATION_DISABLED);
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the schedule's key).");
      const type = typeof args.type === "string" ? args.type.trim() : "";
      if (type !== "cron" && type !== "interval") {
        return fail('Error: `type` must be "cron" or "interval".');
      }
      const schedule: Record<string, unknown> = { type };
      if (type === "cron") {
        const cron = typeof args.cron === "string" ? args.cron.trim() : "";
        if (!cron) {
          return fail('Error: `cron` is required when type is "cron" (a 5-field cron expression, e.g. "0 9 * * *").');
        }
        schedule.cron = cron;
      } else {
        const interval = typeof args.interval === "string" ? args.interval.trim() : "";
        if (!interval) {
          return fail('Error: `interval` is required when type is "interval" (e.g. "30m", "1h").');
        }
        schedule.interval = interval;
      }
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      const promptFile = typeof args.prompt_file === "string" ? args.prompt_file.trim() : "";
      if (!prompt && !promptFile) {
        return fail(
          "Error: provide `prompt` (an inline instruction) or `prompt_file` (a `.md` under " +
            "the project's `.paddock/schedules/` dir).",
        );
      }
      if (prompt) schedule.prompt = prompt;
      if (promptFile) schedule.promptFile = promptFile;
      if (typeof args.resume_session === "boolean") schedule.resume_session = args.resume_session;
      if (typeof args.enabled === "boolean") schedule.enabled = args.enabled;

      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const saved = await write.setSchedule(project, name, schedule);
      return ok({ set: true, project, schedule: saved });
    } catch (error) {
      return fail(`Error setting schedule: ${errText(error)}`);
    }
  };
}

function removeScheduleHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      if (!write.scheduleMutationEnabled) return fail(SCHEDULE_MUTATION_DISABLED);
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the schedule to remove).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const removed = await write.removeSchedule(project, name);
      return ok({ removed, project, name });
    } catch (error) {
      return fail(`Error removing schedule: ${errText(error)}`);
    }
  };
}

function listSchedulesHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const schedules = await write.listSchedules(project);
      return ok({ project, count: schedules.length, schedules });
    } catch (error) {
      return fail(`Error listing schedules: ${errText(error)}`);
    }
  };
}

// ── Hook-management tools (Epic G / G5, GG-4) ───────────────────────────────
// Expose the G1 hook-CRUD service (HookService: persist to project.yaml + register
// the `hook-<slug>-<name>` agent) so a project agent can declare/edit/delete its own
// event hooks — the MCP twin of the Hooks tab (G4). Injected ONLY when the project
// opted into `hooksMcpEnabled` (a coarse, binary gate — an agent that has these
// tools can create hooks at any capability; there is no per-capability gating).

const LIST_HOOKS_DESC =
  "List a project's event hooks: each hook's name, the agent it registers as, its " +
  "trigger `event`, `enabled` flag, prompt/promptFile, and granted capabilities " +
  "(allowedTools, deniedTools, permissionMode, model, maxTurns). Read-only. " +
  "Defaults to the current project; pass `project` (a slug) to target another.";

const SET_HOOK_DESC =
  "Create or update an event HOOK — an agent turn that fires when a project " +
  "lifecycle event happens, keyed by `name`. A hook registers as its OWN agent " +
  "`hook-<slug>-<name>` whose granted tools ARE its capability. `event` is the " +
  "lifecycle trigger (v1: \"onArchive\" — fired after a chat is archived, e.g. to " +
  "spin down servers / delete clones). Give the instruction as `prompt` (inline) " +
  "OR `prompt_file` — a git-tracked `.md` under the project's `.paddock/hooks/` " +
  "dir (e.g. \"cleanup.md\"), read at fire time. Capabilities (all optional; omit " +
  "for a tool-less hook that can only think + return text): `allowed_tools` (the " +
  "tools the hook may use — one per line or comma-separated, e.g. \"Bash, Read\"), " +
  "`denied_tools`, `permission_mode` (\"default\"/\"acceptEdits\"/\"bypassPermissions\"" +
  "/\"plan\"), `model`, `max_turns`. `enabled` (default FALSE on a NEW hook so " +
  "nothing fires the instant it's written — set it true to arm; on an existing hook " +
  "an omitted `enabled` is left unchanged). Defaults to the current project; pass " +
  "`project` (a slug) to target another.";

const REMOVE_HOOK_DESC =
  "Delete an event hook by `name` (removes it from `project.yaml` and unregisters " +
  "its `hook-<slug>-<name>` agent). Safe when absent — returns `removed: false` if " +
  "no such hook. Defaults to the current project; pass `project` to target another.";

function listHooksHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const hooks = await write.listHooks(project);
      return ok({ project, count: hooks.length, hooks });
    } catch (error) {
      return fail(`Error listing hooks: ${errText(error)}`);
    }
  };
}

function setHookHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the hook's key).");
      const event = typeof args.event === "string" ? args.event.trim() : "";
      if (!event) {
        return fail('Error: `event` is required (the lifecycle trigger, e.g. "onArchive").');
      }
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      const promptFile = typeof args.prompt_file === "string" ? args.prompt_file.trim() : "";
      if (!prompt && !promptFile) {
        return fail(
          "Error: provide `prompt` (an inline instruction) or `prompt_file` (a `.md` under " +
            "the project's `.paddock/hooks/` dir).",
        );
      }

      // Assemble the PaddockHook record (camelCase, as sanitizeHook expects). Only
      // set fields the caller supplied so an update doesn't clobber unspecified ones.
      const hook: Record<string, unknown> = { event };
      if (prompt) hook.prompt = prompt;
      if (promptFile) hook.promptFile = promptFile;
      if (typeof args.enabled === "boolean") hook.enabled = args.enabled;

      const capabilities: Record<string, unknown> = {};
      const allowed = coerceToolList(args.allowed_tools);
      if (allowed.length > 0) capabilities.allowedTools = allowed;
      const denied = coerceToolList(args.denied_tools);
      if (denied.length > 0) capabilities.deniedTools = denied;
      if (typeof args.permission_mode === "string" && args.permission_mode.trim() !== "") {
        capabilities.permissionMode = args.permission_mode.trim();
      }
      if (typeof args.model === "string" && args.model.trim() !== "") {
        capabilities.model = args.model.trim();
      }
      if (typeof args.max_turns === "number") capabilities.maxTurns = args.max_turns;
      if (Object.keys(capabilities).length > 0) hook.capabilities = capabilities;

      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const saved = await write.setHook(project, name, hook);
      return ok({ set: true, project, hook: saved });
    } catch (error) {
      return fail(`Error setting hook: ${errText(error)}`);
    }
  };
}

function removeHookHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the hook to remove).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const removed = await write.removeHook(project, name);
      return ok({ removed, project, name });
    } catch (error) {
      return fail(`Error removing hook: ${errText(error)}`);
    }
  };
}

/**
 * Build the injected MCP server definition for the self-management tools, bound to
 * a per-turn context. The READ tools (list_projects/list_chats/read_chat) are
 * ALWAYS included. When a {@link SelfMcpWriteContext} is provided (the stricter
 * write flag is on), the WRITE tools (create_chat/fork_chat/send_message/
 * archive_chat/unarchive_chat/fork_chat_batch + the schedule tools
 * set_schedule/remove_schedule/list_schedules) are appended too; omit it for
 * unchanged read-only behavior. When that write context additionally has
 * {@link SelfMcpWriteContext.hooksMcpEnabled} on (the per-project G5 opt-in), the
 * hook-management tools (list_hooks/set_hook/remove_hook) are appended as well.
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
      {
        name: "set_schedule",
        description: SET_SCHEDULE_DESC,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The schedule's stable key (create or update)." },
            type: {
              type: "string",
              enum: ["cron", "interval"],
              description: '"cron" (with a `cron` expression) or "interval" (with an `interval` string).',
            },
            cron: {
              type: "string",
              description: 'Required when type is "cron": a 5-field cron expression (e.g. "0 9 * * *"), host-local time.',
            },
            interval: {
              type: "string",
              description: 'Required when type is "interval": a duration string (e.g. "30m", "1h").',
            },
            prompt: {
              type: "string",
              description: "Inline instruction the scheduled turn runs. Provide this OR `prompt_file`.",
            },
            prompt_file: {
              type: "string",
              description:
                'A `.md` file under the project\'s `.paddock/schedules/` dir (e.g. "daily-triage.md"), ' +
                "read at fire time. Alternative to `prompt` for long, version-tracked prompts.",
            },
            resume_session: {
              type: "boolean",
              description:
                "false (default) → a fresh chat each fire; true → accrete into the schedule's one owned session.",
            },
            enabled: { type: "boolean", description: "Whether the schedule is armed (default true)." },
            project: {
              type: "string",
              description: "Project slug to target. Omit to use the current project.",
            },
          },
          required: ["name", "type"],
        },
        handler: setScheduleHandler(write),
      },
      {
        name: "remove_schedule",
        description: REMOVE_SCHEDULE_DESC,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The schedule to remove." },
            project: {
              type: "string",
              description: "Project slug that owns the schedule. Omit to use the current project.",
            },
          },
          required: ["name"],
        },
        handler: removeScheduleHandler(write),
      },
      {
        name: "list_schedules",
        description: LIST_SCHEDULES_DESC,
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "Project slug to list. Omit to use the current project.",
            },
          },
        },
        handler: listSchedulesHandler(write),
      },
    );

    // Hook-management tools (Epic G / G5, GG-4): a THIRD coarse capability, layered
    // on the write tools and gated by the project's own `hooksMcpEnabled` opt-in.
    // When off the tools are ABSENT (not present-but-refusing) — the design's binary
    // "does this project agent get the hook MCP at all" gate.
    if (write.hooksMcpEnabled) {
      tools.push(
        {
          name: "list_hooks",
          description: LIST_HOOKS_DESC,
          inputSchema: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "Project slug to list. Omit to use the current project.",
              },
            },
          },
          handler: listHooksHandler(write),
        },
        {
          name: "set_hook",
          description: SET_HOOK_DESC,
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "The hook's stable key (create or update)." },
              event: {
                type: "string",
                description: 'The lifecycle trigger (v1: "onArchive").',
              },
              prompt: {
                type: "string",
                description: "Inline instruction the hook turn runs. Provide this OR `prompt_file`.",
              },
              prompt_file: {
                type: "string",
                description:
                  'A `.md` file under the project\'s `.paddock/hooks/` dir (e.g. "cleanup.md"), ' +
                  "read at fire time. Alternative to `prompt`.",
              },
              allowed_tools: {
                type: "string",
                description:
                  "The tools the hook agent may use — one per line or comma-separated (e.g. " +
                  '"Bash, Read, Write"). Omit for a tool-less hook. A JSON array is also accepted.',
              },
              denied_tools: {
                type: "string",
                description: "Tools explicitly denied — same format as `allowed_tools`.",
              },
              permission_mode: {
                type: "string",
                enum: ["default", "acceptEdits", "bypassPermissions", "plan"],
                description: "Permission mode the hook agent's turns run under.",
              },
              model: { type: "string", description: "Model override for the hook agent." },
              max_turns: {
                type: "number",
                description: "Max agent turns bounding a runaway hook.",
              },
              enabled: {
                type: "boolean",
                description:
                  "Whether the hook is armed. Default FALSE on a NEW hook; omitted on an " +
                  "existing hook leaves it unchanged.",
              },
              project: {
                type: "string",
                description: "Project slug to target. Omit to use the current project.",
              },
            },
            required: ["name", "event"],
          },
          handler: setHookHandler(write),
        },
        {
          name: "remove_hook",
          description: REMOVE_HOOK_DESC,
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "The hook to remove." },
              project: {
                type: "string",
                description: "Project slug that owns the hook. Omit to use the current project.",
              },
            },
            required: ["name"],
          },
          handler: removeHookHandler(write),
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
  setSchedule: `mcp__${SERVER_NAME}__set_schedule`,
  removeSchedule: `mcp__${SERVER_NAME}__remove_schedule`,
  listSchedules: `mcp__${SERVER_NAME}__list_schedules`,
} as const;

/**
 * The fully-qualified names of the G5 hook-management tools (only present when a
 * write context has {@link SelfMcpWriteContext.hooksMcpEnabled} on).
 */
export const SELF_MCP_HOOK_TOOL_NAMES = {
  listHooks: `mcp__${SERVER_NAME}__list_hooks`,
  setHook: `mcp__${SERVER_NAME}__set_hook`,
  removeHook: `mcp__${SERVER_NAME}__remove_hook`,
} as const;
