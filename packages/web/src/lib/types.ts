// Shared DTO types mirroring the paddock-server API + WS protocol.
// Kept in sync by hand with packages/server/src/{routes,ws}.ts and the
// @herdctl/core ChatMessage / DiscoveredSession shapes.

export type ProjectStatus =
  | "idea"
  | "active"
  | "paused"
  | "blocked"
  | "done"
  | "abandoned";

export interface ProjectLink {
  label: string;
  url: string;
}

export interface Project {
  name: string;
  slug: string;
  status: ProjectStatus;
  domain: string[];
  /** The project's area / home (e.g. "homelab", "house", "side-projects").
   *  Always present; "" means Unsorted. Drives the sectioned landing page. */
  group: string;
  visibility: "public" | "private";
  started: string;
  updated: string;
  created: string;
  summary: string;
  links?: ProjectLink[];
  dir: string;
  /**
   * The keeper's working directory (cwd). Equals `dir` for a notebook project;
   * for a repo-backed project it's the nested checkout under `dir` (issue #187).
   */
  workingDir: string;
  /** Whether this project is backed by an external git repo (issue #187). */
  repoBacked: boolean;
  /** The external git repo URL, when repo-backed (issue #187). */
  repo?: string;
  /** True once a sweep has written OVERVIEW.md (drives the preload checkbox + Overview hint). */
  hasOverview: boolean;
  /** Pinned file names rendered as sibling tabs (order-preserving). Default []. */
  pinned: string[];
  /** The keeper model this project runs on. Always concrete (server resolves the default). */
  model: string;
  /** Keeper permission mode. Always concrete (server resolves the default). Issue #12. */
  permissionMode: string;
  /** Keeper max_turns. Always concrete (server resolves the default). Issue #12. */
  maxTurns: number;
  /** Whether the keeper runs in a Docker sandbox. Always concrete. Issue #12. */
  docker: boolean;
  /**
   * How the keeper's chat turns are driven (Paddock#111). `undefined` = inherit
   * the box-wide global default; `session` enables cross-turn autonomy
   * (ScheduleWakeup / `/loop`), `batch` is the legacy one-shot path.
   */
  driveMode?: "batch" | "session";
  /**
   * How deep a spawn tree may grow before spawned children stop getting the
   * self-management MCP (issue #262). `undefined` = inherit the instance default
   * (`PADDOCK_MAX_SPAWN_DEPTH`); a number is a per-project override. A depth-`d`
   * spawned child gets the write tools (report-back + spawn) iff `d <= maxSpawnDepth`.
   */
  maxSpawnDepth?: number;
  /**
   * Compact per-chat "last completed turn" timestamps for the sidebar UNREAD
   * badge (#161): one entry per project chat that has a completed keeper turn,
   * `lastTurnCompletedAt` being its most recent (from job records, not a
   * transcript parse). The sidebar counts entries whose time is newer than the
   * server-backed `lastSeen` read-state (#160/#189). Absent/[] means no completed
   * chats. `lastSeen` is the per-user (or shared) last-viewed epoch-ms, absent
   * when the chat has never been seen on this instance.
   */
  chatTurns?: { sessionId: string; lastTurnCompletedAt: string; lastSeen?: number }[];
  /**
   * Count of uncommitted files in this project's subtree (#258) — drives the
   * projects-grid "N uncommitted" chip so pending work is visible before you
   * open the project. 0 / absent when clean or the store isn't a git repo.
   */
  dirty?: number;
}

/** A selectable model (GET /api/models). `contextLimit` drives the context meter. */
export interface ModelInfo {
  id: string;
  label: string;
  contextLimit: number;
}

/**
 * A slash command available to an agent, for the composer's autocomplete menu
 * (issue #103). Mirrors herdctl's re-exported `SlashCommand`
 * (`{ name, description, argumentHint }` from the Claude Agent SDK).
 */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** Render-kind hint for a project file, derived server-side from its extension. */
export type FileKind = "markdown" | "html" | "text" | "image";

/**
 * A single project file's content + how it should be rendered (GET /files/:name).
 * For an `image` kind `content` is empty — the bytes are loaded from the raw
 * endpoint (`?raw=1`) via an <img>; see `api.projectFileRawUrl` (issue #61).
 */
export interface ProjectFile {
  name: string;
  kind: FileKind;
  content: string;
}

/**
 * One entry in a project directory listing (issue #259): a name plus whether
 * it's a file or a subdirectory. Drives the Files tab's folder navigation.
 */
export interface FileEntry {
  name: string;
  kind: "file" | "dir";
}

/**
 * The result of resolving a Files-tab path (issue #259) via
 * `GET /api/projects/:slug/files[?path=<subpath>]`. A discriminated union on
 * `kind`: for a directory (`kind: "dir"`) `entries` are its immediate children
 * (dotfiles hidden, directories sorted first); for a file (`kind: "file"`)
 * `entries` is empty and the caller renders the single-file viewer. `path` is
 * the project-relative subpath ("" = the project root).
 */
export interface DirListing {
  path: string;
  kind: "dir" | "file";
  entries: FileEntry[];
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  status?: ProjectStatus;
  domain?: string[];
  group?: string;
  summary?: string;
  /**
   * External git repo URL to back this project (issue #187). When set the
   * project is created repo-backed (Paddock clones it and the keeper's cwd is the
   * checkout). Absent ⇒ a notebook project.
   */
  repo?: string;
}

/** Editable project metadata (slug + dates are immutable server-side). */
export interface UpdateProjectInput {
  name?: string;
  status?: ProjectStatus;
  domain?: string[];
  group?: string;
  summary?: string;
  visibility?: "public" | "private";
  /** The keeper model id; server re-registers the keeper on change (must be a known model). */
  model?: string;
  /** Keeper permission mode; server validates + re-registers the keeper (issue #12). */
  permissionMode?: string;
  /** Keeper max_turns (1–1000); server validates + re-registers the keeper (issue #12). */
  maxTurns?: number;
  /** Whether the keeper runs in a Docker sandbox; server re-registers on change (issue #12). */
  docker?: boolean;
  /**
   * Keeper drive mode (Paddock#111); server validates + re-registers on change.
   * `null` clears the per-project override so it inherits the box-wide global
   * default again (issue #122's reset-to-inherit).
   */
  driveMode?: "batch" | "session" | null;
  /**
   * Max spawn depth (issue #262); server validates + re-registers on change.
   * `null` clears the per-project override so it inherits the instance default
   * again (same reset-to-inherit as `driveMode`).
   */
  maxSpawnDepth?: number | null;
}

/** A chat = one Claude Code session, surfaced by the server's session discovery. */
export interface Chat {
  sessionId: string;
  workingDirectory: string;
  name: string;
  updatedAt: string;
  resumable: boolean;
  preview?: string;
  /**
   * Whether the chat is filed away in the Archived section (issue #95). A
   * non-destructive per-chat flag; archived chats stay fully functional.
   */
  archived?: boolean;
  /**
   * ISO timestamp of the last turn the agent FINISHED (from server job records,
   * NOT mtime — so it doesn't tick on the user's own sends). Drives the unread
   * affordance (#160): a chat is unread when this is newer than the locally
   * stored last-seen time (`lib/lastSeen.ts`). Absent when no completed turn
   * has been recorded yet.
   */
  lastTurnCompletedAt?: string;
  /**
   * Server-side read-state (#189): the epoch-ms the user last viewed this chat,
   * keyed by user when a real identity is present, else a shared bucket. The
   * cross-device source of truth for the unread affordance — folded into the
   * client cache (`lib/lastSeen.ts`) on load. Absent when never seen.
   */
  lastSeen?: number;
  /**
   * Context-window fill as of the chat's last completed turn (for the usage
   * ring, issue #77) plus the chat's cumulative lifetime token totals and cost
   * estimate (issue #152). All present together, or all absent when the
   * transcript has no usage data yet.
   */
  contextTokens?: number;
  contextLimit?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  /**
   * How this chat was created (issue #267): A1's provenance marker (#261). Drives
   * the chat-list badge that makes unattended runs legible — `scheduled` (a cron
   * fired it) and `spawned` (another chat created it) stand out; `human` (the
   * default) shows no badge. Absent for chats created before A1 recorded a marker.
   */
  provenance?: ChatProvenance;
  /**
   * For a HOOK chat (Epic G / G3, GG-6): the truthful-from-config capability
   * descriptor of the event hook that owns it — its trigger event + granted tools,
   * read from the same hook agent config herdctl enforces. Drives the floating
   * capability banner atop the chat (see {@link ChatHookInfo}). Absent for every
   * non-hook chat, so only hook chats carry a banner.
   */
  hook?: ChatHookInfo;
}

/** How a chat came to exist (issue #261) — the dimension the list badges (#267). */
export type ChatOrigin = "human" | "scheduled" | "spawned" | "hook";

/**
 * The capability descriptor of the event hook that owns a hook chat (Epic G / G3,
 * GG-6) — mirrors the server's `ChatHookInfo` (packages/server/src/hook-config.ts).
 * Everything here is read from the registered `hook-<slug>-<name>` agent config, so
 * the banner it drives is truthful by construction: it states exactly the tools the
 * hook's turns are allowed to use.
 */
export interface ChatHookInfo {
  /** The hook's name (`project.yaml` map key + the `<name>` in its agent name). */
  name: string;
  /** The lifecycle event that fires this hook (v1: `onArchive`). */
  event: string;
  /** The herdctl agent enforcing the capability (`hook-<slug>-<name>`). */
  agentName: string;
  /** Whether the hook is currently armed (a disabled hook's past chats still show). */
  enabled: boolean;
  /** The exact tool grant (herdctl `allowed_tools`); `[]` = a tool-less hook. */
  allowedTools: string[];
  /** Tools explicitly denied even if otherwise allowed, when the hook sets any. */
  deniedTools?: string[];
  /** The permission mode the hook's turns run under, when the hook sets one. */
  permissionMode?: string;
  /** The hook agent's model override, when set (else the keeper default applies). */
  model?: string;
  /** The hook's max agent turns (its runaway bound). */
  maxTurns: number;
}

/** A chat's provenance marker (issue #261): origin + spawn depth. */
export interface ChatProvenance {
  origin: ChatOrigin;
  /** Spawn hops from the human/scheduled root (0 = root itself). */
  depth: number;
}

/**
 * WHO injected a machine-added message into a chat (issue #290) — the per-MESSAGE
 * analog of {@link ChatProvenance}. A human-typed message carries NO sender
 * (absence = human, the quiet default), so this only enumerates machine sources.
 * Mirrors the server's `MessageSender` (packages/server/src/message-provenance.ts).
 *
 *  - `chat`     — another chat send_message'd / forked / created this turn; carries
 *                 the sending chat's project + sessionId (a deep link) + its display
 *                 name at injection time.
 *  - `schedule` — a schedule fire injected it; carries the schedule's name.
 *  - `hook`     — an event hook fired it (Epic G); carries the hook's name.
 *  - `agent`    — a machine turn with no more specific identity (fallback).
 */
export type MessageSender =
  | { kind: "chat"; project: string; sessionId: string; name?: string }
  | { kind: "schedule"; name: string; project?: string }
  | { kind: "hook"; name: string; project?: string }
  | { kind: "recovery" }
  | { kind: "agent" };

/** A scheduled chat's timer kind (issue #266 / D4). */
export type ScheduleType = "cron" | "interval";

/**
 * A project's scheduled chat (issue #266 / D4) — the project.yaml declaration
 * (herdctl's `ScheduleSchema` shape + Paddock's `promptFile`) MERGED with
 * herdctl's live runtime state. Drives the Schedules section of the Settings
 * pane. `status` / `lastRunAt` / `nextRunAt` / `lastError` reflect the running
 * keeper (a just-declared schedule not yet armed reports `idle`/nulls).
 */
export interface Schedule {
  name: string;
  type: ScheduleType;
  /** Cron expression (5-field / `@daily`) — present for `type: "cron"`. */
  cron: string | null;
  /** Interval string (e.g. `"30m"`, `"1h"`) — present for `type: "interval"`. */
  interval: string | null;
  /** The inline prompt the fire runs (null when a `promptFile` supplies it). */
  prompt: string | null;
  /** A `.paddock/schedules/*.md` prompt file, read fresh at fire time (Paddock sugar). */
  promptFile: string | null;
  /** `true` → one accreting owned session; `false` → a fresh chat each fire (DD-2). */
  resumeSession: boolean;
  /** Whether the schedule is armed. */
  enabled: boolean;
  /** Live runtime status from herdctl (or derived from `enabled` when unarmed). */
  status: "idle" | "running" | "disabled";
  /** ISO timestamp of the last fire, or null if it hasn't run. */
  lastRunAt: string | null;
  /** ISO timestamp of the next scheduled fire, or null (e.g. disabled). */
  nextRunAt: string | null;
  /** Last error message from a fire, if any. */
  lastError: string | null;
}

/**
 * The write shape for creating/replacing a schedule (issue #266 / D4). Mirrors
 * herdctl's `ScheduleSchema` field names (`resume_session`, `prompt`) plus the
 * Paddock-only `promptFile`; the server sanitises it before persisting.
 */
export interface ScheduleInput {
  type: ScheduleType;
  cron?: string;
  interval?: string;
  prompt?: string;
  promptFile?: string;
  resume_session?: boolean;
  enabled?: boolean;
}

// --- Event hooks (Epic G / G4) ---------------------------------------------

/** The lifecycle event a hook fires on. v1 wires `onArchive` (mirrors the server). */
export type HookEvent = "onArchive";

/** The Claude Code permission mode a hook agent's turns run under. */
export type HookPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/**
 * A hook's capability set (GG-1) — projected verbatim onto the hook's own herdctl
 * agent tool config, so the registered agent enforces exactly these tools. Absent /
 * empty `allowedTools` = a tool-less hook (it can only think + return text).
 */
export interface HookCapabilities {
  /** The tools the hook agent may use. Omit / `[]` = tool-less. */
  allowedTools?: string[];
  /** Tools explicitly denied even if otherwise allowed. */
  deniedTools?: string[];
  /** The permission mode the hook agent's turns run under. */
  permissionMode?: HookPermissionMode;
  /** Model override for the hook agent (defaults to the keeper default when absent). */
  model?: string;
  /** Max agent turns — bounds a runaway hook (server default 30). */
  maxTurns?: number;
}

/**
 * A project's event hook (Epic G / G4) — the project.yaml declaration (event +
 * capability set + prompt) plus the herdctl agent it registers as. Drives the
 * Hooks tab. Enabling/disabling is just editing `enabled` (GG-3); new hooks default
 * `enabled: false` so nothing fires the instant one is created.
 */
export interface Hook {
  /** The hook's name — the project.yaml map key + the `<name>` in its agent name. */
  name: string;
  /** The herdctl agent this hook registers as (`hook-<slug>-<name>`). */
  agentName: string;
  /** The lifecycle event this hook fires on. */
  event: HookEvent;
  /** The capability set granted to the hook's agent. Absent = tool-less. */
  capabilities?: HookCapabilities;
  /** The inline prompt the hook turn runs (a `promptFile` wins over this). */
  prompt?: string;
  /** A `.paddock/hooks/*.md` prompt file, read fresh at fire time. */
  promptFile?: string;
  /** Whether the hook is armed. */
  enabled?: boolean;
}

/** The write shape for creating/replacing a hook (the server sanitises it). */
export interface HookInput {
  event: HookEvent;
  capabilities?: HookCapabilities;
  prompt?: string;
  promptFile?: string;
  enabled?: boolean;
}

/** One tool a hook may be granted, for the capability picker (server catalog). */
export interface GrantableTool {
  name: string;
  group: "read" | "write" | "web" | "orchestration" | "browser";
  description: string;
}

/** The Hooks tab's list payload: the hooks + the picker's catalog (tools + events). */
export interface HooksResponse {
  hooks: Hook[];
  grantableTools: GrantableTool[];
  events: HookEvent[];
}

/**
 * Per-run cost (P3 seam, DD-4 / X1#378 + X2#271): always `null` today — herdctl
 * doesn't yet persist per-run token accounting. Shape reserved so the cost column
 * slots in without a wire change.
 */
export interface RunCost {
  usd: number;
  estimated: boolean;
}

/**
 * One run in the "while you were away" history view (#268 / E3): a herdctl job
 * record joined with its provenance marker so scheduled + spawned runs report
 * their true origin (paddock persists `trigger_type:"manual"`, so origin lives in
 * the provenance store, not the enum).
 */
export interface RunSummary {
  jobId: string;
  sessionId: string | null;
  origin: ChatOrigin;
  depth: number;
  /** herdctl's persisted trigger type — a secondary signal. */
  triggerType: string;
  /** Schedule name that fired the run, when scheduled. */
  schedule: string | null;
  /** Parent job id, when forked. */
  forkedFrom: string | null;
  status: "completed" | "failed" | "cancelled" | "running" | "pending" | string;
  exitReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  prompt: string | null;
  summary: string | null;
  /** True when the run completed after the viewer's last visit (since-last-visit). */
  isNew: boolean;
  /** P3 seam — always null today. */
  cost: RunCost | null;
}

/** The run-history payload: recent runs + the viewer's since-last-visit state. */
export interface ProjectRuns {
  runs: RunSummary[];
  /** Epoch-ms the viewer last visited the run-history view (0 = never). */
  lastSeen: number;
  /** Count of unattended (scheduled + spawned) runs newer than `lastSeen`. */
  newUnattended: number;
}

/**
 * A chat's usage as computed server-side from its transcript (issue #152): the
 * last-turn context fill (`contextTokens` / `contextLimit`, issue #77) plus the
 * chat's cumulative lifetime token totals and a ballpark dollar estimate at
 * first-party API rates. `costUsd` is null for a model with no known pricing.
 * On the Max/CLI runtime this cost is informational (no per-token quota) — the
 * token counts are the honest figure.
 */
export interface ChatUsage {
  contextTokens: number;
  contextLimit: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

/** A persisted message hydrated from a session's transcript (core ChatMessage). */
export interface ChatToolCall {
  toolName: string;
  inputSummary?: string;
  output: string;
  isError: boolean;
  durationMs?: number;
  // Sub-agent (Task/Agent tool) enrichment, added server-side (issue #37). Only
  // present on Task/Agent tool calls read from history; undefined otherwise.
  /** The parent tool_use id — the key to fetch this sub-agent's nested steps. */
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
  /** True when a sub-agent transcript exists on disk (i.e. it's expandable). */
  hasSubagent?: boolean;
  /** The sub-agent's actual run time (first→last transcript timestamp), in ms. */
  subagentDurationMs?: number;
  /**
   * The sub-agent's estimated API-rate cost (USD), priced per-model from its own
   * transcript (issue #166). `null` when its model has no known pricing.
   */
  subagentCostUsd?: number | null;

  // Background-job / Monitor enrichment, added server-side (issue #230). Only
  // present on background-class tool calls read from history; undefined otherwise.
  /** True when this tool ran detached (a `run_in_background` launch, `Monitor`,
   *  or a background-task op like `BashOutput`/`TaskOutput`/`TaskStop`). */
  background?: boolean;
  /** The background task id, parsed from the launch output. */
  taskId?: string;
  /** Terminal state of the linked task: "completed" | "killed" | "timed out" |
   *  "persistent" | "running". */
  taskStatus?: string;
  /** Completion `<summary>` folded in from the matching task-notification. */
  taskResultSummary?: string;
  /** For `Monitor`: the streamed `<event>` lines, in order. */
  monitorEvents?: string[];

  // Per-tool detail enrichment (issue #237), added server-side from the raw
  // transcript's `{input, toolUseResult}` sidecar. History-hydrated only;
  // undefined on the live path before reload (renderer degrades to generic).
  /** Inline diff for an `Edit`/`MultiEdit`/`Write`, sourced from
   *  `toolUseResult.structuredPatch` (real file line numbers; issue #232 → #237). */
  editDiff?: EditDiff;
  /** File + line-range for a `Read` — drives the `basename · lines a–b of N` header. */
  readInfo?: ReadInfo;
  /** Split stdout/stderr + status affordances for a `Bash`. */
  bashDetails?: BashDetails;
  /** Match/file counts for a `Grep`/`Glob`. */
  searchInfo?: SearchInfo;
  /** Status transition for a `TaskUpdate`. */
  taskUpdate?: TaskUpdateInfo;
  /** Subject/description for a `TaskCreate`. */
  taskCreate?: TaskCreateInfo;
}

/**
 * One line of a rendered diff: added (`+`), removed (`-`), or unchanged context,
 * with the real source line numbers recovered from the transcript's git hunks
 * (issue #237). `oldLine` on context + deletions, `newLine` on context + additions.
 */
export interface DiffLine {
  t: "+" | "-" | " ";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** One git-style hunk with real file offsets (`@@ -oldStart,oldLines +newStart,newLines @@`). */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** A structured diff for an edit tool call (issue #232 → #237). */
export interface EditDiff {
  filePath?: string;
  kind: "edit" | "multiedit" | "write";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True when a hunk was truncated for size; the stats still reflect the full edit. */
  truncated?: boolean;
  /** True when the file changed between the read and the edit. */
  userModified?: boolean;
}

/** File + line-range recovered for a `Read` (issue #237). */
export interface ReadInfo {
  filePath?: string;
  basename?: string;
  startLine?: number;
  numLines?: number;
  totalLines?: number;
  /** True when the read target is an image file (issue #239). */
  isImage?: boolean;
  /** Project-relative path of an image read inside the project dir, for the inline
   *  `<img>` via the raw file endpoint (issue #239). Absent when not servable. */
  projectRelPath?: string;
}

/** Split output + status affordances recovered for a `Bash` (issue #237). */
export interface BashDetails {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  returnCodeInterpretation?: string;
  gitHint?: string;
}

/** Match/file counts recovered for a `Grep`/`Glob` (issue #237). */
export interface SearchInfo {
  kind: "grep" | "glob";
  numFiles?: number;
  numLines?: number;
  totalMatches?: number;
  truncated?: boolean;
}

/** Status transition recovered for a `TaskUpdate` (issue #237). */
export interface TaskUpdateInfo {
  taskId?: string;
  updatedFields?: string[];
  from?: string;
  to?: string;
}

/** Subject/description recovered for a `TaskCreate` (issue #237). */
export interface TaskCreateInfo {
  taskId?: string;
  subject?: string;
  description?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  toolCall?: ChatToolCall;
  /** True when this `<task-notification>` was folded into a background tool block
   *  (issue #230) — the web suppresses the standalone status pill. */
  bgConsumed?: boolean;
  /**
   * Stable id from the source transcript entry — the Claude Code JSONL `uuid`,
   * surfaced by `@herdctl/core`'s `ChatMessage` (herdctl#312) and passed through
   * verbatim by the server (issue #135). Optional: absent on older transcripts or
   * a pre-uuid core. Used to give a reloaded turn a reload-stable id (see
   * `historyToTurns` in ChatPane), so per-message UI state can persist (#136).
   */
  uuid?: string;
  /**
   * WHO injected this turn, when a machine did (issue #290). Absent for a
   * human-typed message (the default — no attribution rendered). Populated by the
   * server's per-message provenance join for `send_message` / schedule / spawn
   * kickoff turns, so the history can show "↩ sent by …" / "⏰ scheduled by …".
   */
  sender?: MessageSender;
}

/** Enriched single-project response from GET /api/projects/:slug. */
export interface ProjectDetail {
  project: Project;
  changelog: string;
  chats: Chat[];
}

// --- Git backing store (GET /api/git, .../git/status, GitHub device flow) ---

/** GitHub connection status, nested in GitInfo. */
export interface GithubStatus {
  /** Whether a GitHub OAuth client id is configured on the server. */
  configured: boolean;
  /** Whether a token is stored (the device flow completed). */
  connected: boolean;
  /** The authenticated GitHub login, when connected. */
  login?: string;
}

/**
 * Fleet-wide git state (GET /api/git). When `repo` is false the projects dir
 * isn't a git repo and the ENTIRE git UI is hidden.
 */
export interface GitInfo {
  /** True when the projects dir is a git repo. False ⇒ hide all git UI. */
  repo: boolean;
  /** True when a remote (origin) is configured (push is possible). */
  configured: boolean;
  /** The remote URL, when configured. */
  url?: string;
  /** The current branch. */
  branch?: string;
  /** Commits ahead of the remote (drives "↑N to push"). */
  ahead?: number;
  /** Commits behind the remote. */
  behind?: number;
  github: GithubStatus;
}

/** One changed file in a project's working tree (.../git/status). */
export interface GitFileChange {
  /** Repo-relative path. */
  path: string;
  /** Porcelain status code (M, A, D, ??, R…, etc.). */
  status: string;
  /** Whether the change is staged. */
  staged: boolean;
  /** Whether the file is untracked (won't appear in the diff). */
  untracked: boolean;
  /** Lines added (undefined for a binary change). Untracked text files count as all-added. */
  added?: number;
  /** Lines removed (undefined for a binary change / an untracked file). */
  removed?: number;
  /** True when the change is binary (no line-level stat). */
  binary?: boolean;
}

/** Per-project git status (GET /api/projects/:slug/git/status). */
export interface GitProjectStatus {
  /** True when the projects dir is a git repo. False ⇒ no Changes tab. */
  repo: boolean;
  /** The current branch. */
  branch?: string;
  /** The changed files in this project's subtree. */
  files: GitFileChange[];
  /** True when there are no changes. */
  clean: boolean;
}

/** Result of POST /api/projects/:slug/git/commit. */
export interface GitCommitResult {
  /** False ⇒ nothing to commit. */
  committed: boolean;
  /** The new commit hash, when committed. */
  hash?: string;
  error?: string;
}

/** Result of POST /api/git/push. */
export interface GitPushResult {
  pushed: boolean;
  error?: string;
}

/** POST /api/git/github/connect — starts the OAuth device flow. */
export interface DeviceFlowStart {
  /** The code the user enters at `verificationUri`. */
  userCode: string;
  /** Where the user goes to enter the code (github.com/login/device). */
  verificationUri: string;
  /** Opaque handle passed back to poll/. */
  deviceCode: string;
  /** Seconds to wait between polls. */
  interval: number;
  /** Seconds until the device code expires. */
  expiresIn: number;
}

/** POST /api/git/github/poll — one poll of the device flow. */
export interface PollResult {
  status: "authorized" | "pending" | "slow_down" | "error";
  error?: string;
}

// --- WS protocol (mirrors server/src/ws.ts) ---

/** The slug used to address one-off chats. The server routes it to the scratch agent. */
export const SCRATCH_SLUG = "scratch";

/** Routing fields present on every server->client chat event. */
interface Routing {
  projectSlug: string;
  /** Legacy alias for `projectSlug`; the server emits both. */
  target?: string;
  sessionId: string | null;
  jobId: string | null;
  /**
   * Per-turn, monotonic sequence number stamped by the server's SessionHub
   * (issue #54). Used to re-attach a reconnected socket to a live turn and
   * replay exactly the missed gap. Absent on frames not routed through the hub.
   */
  seq?: number;
}

/** Per-turn token usage surfaced on chat:complete (camelCase; drives the context meter). */
export interface ChatCompleteUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + cacheRead + cacheCreation (what the context window holds). */
  contextTokens: number;
  /** The model's context window size (getContextLimit(model) server-side). */
  contextLimit: number;
}

/** Which renderer the chat should use for an agent-sent file (issue #112). */
export type SentFileKind =
  | "markdown"
  | "mermaid"
  | "code"
  | "text"
  | "html"
  | "image"
  | "video"
  | "pdf";

/**
 * The JSON envelope the `mcp__paddock__send_file` tool returns as its result
 * `output`. The client parses this off the tool call (live + on reload) — see
 * `sentFileFromToolCall` in ChatPane. `paddockSendFile` discriminates our
 * envelope from any other tool's output.
 */
export interface SentFileEnvelope {
  paddockSendFile: 1;
  filename: string;
  kind: SentFileKind;
  language?: string;
  /** "inline" carries `content`; "file" carries `attachmentId` (bytes in the store). */
  source: "inline" | "file";
  content?: string;
  attachmentId?: string;
  message?: string;
}

/** A rendered agent-sent file, resolved from the tool-call envelope. */
export interface SentFile {
  filename: string;
  kind: SentFileKind;
  /** Language hint for the `code` kind (drives the filename-chrome label). */
  language?: string;
  /** Optional note the agent attached. */
  message?: string;
  source: "inline" | "file";
  /** inline: the verbatim content. file: undefined (fetch via `rawUrl`). */
  content?: string;
  /** file: URL to load the bytes from Paddock. inline: undefined. */
  rawUrl?: string;
}

export type ServerWsMessage =
  | { type: "chat:response"; payload: Routing & { chunk: string } }
  | {
      type: "chat:tool_call";
      payload: Routing & {
        toolName: string;
        inputSummary?: string;
        output: string;
        isError: boolean;
        durationMs?: number;
        /** Reconcile key for the pending row created on `chat:tool_start` (#175). */
        toolUseId?: string;
      };
    }
  | {
      /** In-flight tool_use, surfaced before the tool completes (#175). */
      type: "chat:tool_start";
      payload: Routing & {
        toolName: string;
        inputSummary?: string;
        toolUseId?: string;
        parentToolUseId: string | null;
      };
    }
  | { type: "chat:message_boundary"; payload: Routing }
  | {
      type: "chat:complete";
      payload: Routing & {
        success: boolean;
        error?: string;
        /** The model this turn ran on (server: lastModel ?? effectiveModel). Omitted if unknown. */
        model?: string;
        /** Last per-turn usage observed; omitted (with model) if none was seen. */
        usage?: ChatCompleteUsage;
      };
    }
  | { type: "chat:error"; payload: { projectSlug: string; target?: string; error: string } }
  | {
      /** Re-attach fallback: the live turn's buffer aged out; re-hydrate from transcript (issue #54). */
      type: "chat:resync";
      payload: { projectSlug: string; target?: string; sessionId: string };
    }
  | {
      /** A session's live-turn status changed — drives Stop restore + indicators (issues #52/#53). */
      type: "chat:active";
      payload: {
        projectSlug: string;
        target?: string;
        sessionId: string;
        jobId: string | null;
        running: boolean;
      };
    }
  | {
      /** The server auto-sent the queued message, so clear localStorage (#197). */
      type: "chat:queued_flushed";
      payload: { projectSlug: string; target?: string; sessionId: string };
    }
  | {
      /**
       * A machine-injected user turn landed in this session (issue #290 Part 2):
       * another chat `send_message`d / a schedule fired into it. Emitted so a
       * client already viewing the recipient renders the injected user bubble live
       * (with its sender attribution) instead of only seeing the assistant reply.
       */
      type: "chat:injected";
      payload: Routing & { sender: MessageSender; content: string; timestamp: string };
    }
  | { type: "pong" };
