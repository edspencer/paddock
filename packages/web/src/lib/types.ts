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
   * Compact per-chat "last completed turn" timestamps for the sidebar UNREAD
   * badge (#161): one entry per project chat that has a completed keeper turn,
   * `lastTurnCompletedAt` being its most recent (from job records, not a
   * transcript parse). The sidebar counts entries whose time is newer than the
   * server-backed `lastSeen` read-state (#160/#189). Absent/[] means no completed
   * chats. `lastSeen` is the per-user (or shared) last-viewed epoch-ms, absent
   * when the chat has never been seen on this instance.
   */
  chatTurns?: { sessionId: string; lastTurnCompletedAt: string; lastSeen?: number }[];
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
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  toolCall?: ChatToolCall;
  /**
   * Stable id from the source transcript entry — the Claude Code JSONL `uuid`,
   * surfaced by `@herdctl/core`'s `ChatMessage` (herdctl#312) and passed through
   * verbatim by the server (issue #135). Optional: absent on older transcripts or
   * a pre-uuid core. Used to give a reloaded turn a reload-stable id (see
   * `historyToTurns` in ChatPane), so per-message UI state can persist (#136).
   */
  uuid?: string;
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
  | { type: "pong" };
