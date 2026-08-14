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

/**
 * Resolved keeper-chat recovery config (issue #301) — mirrors the server's
 * `RecoveryConfig` (packages/server/src/recovery-config.ts). Instance defaults
 * are served by GET /api/models (`recoveryDefault`); a per-project partial
 * override lives on {@link Project.recovery}.
 */
export interface RecoveryConfig {
  /** Layer 2 — surface a killed background task + a one-click Continue (default ON). */
  surfaceKilledTask: boolean;
  /** Layer 3 — auto re-drive a hung keeper (default OFF; engine is a follow-up). */
  autoReDrive: boolean;
  /** Layer 3 — quiet-ms debounce before auto re-drive fires. */
  debounceMs: number;
  /** Layer 3 — per-session auto re-drive retry cap. */
  maxRetries: number;
}

/** A per-project recovery override — every field optional (absent ⇒ inherit). */
export type RecoveryOverride = Partial<RecoveryConfig>;

/** Inbound composer-attachment config (issue #328). Resolved effective values. */
export interface AttachmentsConfig {
  /** Whether users can upload files/images into the composer (default ON). */
  enabled: boolean;
  /** Per-file size cap in MB (default 25). */
  maxFileSizeMb: number;
  /** How many files a single message may carry (default 10). */
  maxFilesPerMessage: number;
  /** Allow-list of MIME patterns (`image/*`) / extensions (`.pdf`); `["*"]` = all. */
  allowedTypes: string[];
}

/** A per-project attachment override — every field optional (absent ⇒ inherit). */
export type AttachmentsOverride = Partial<AttachmentsConfig>;

/**
 * Sweeper-curation per-file token budgets (mirrors `CurationConfig`,
 * packages/server/src/curation-config.ts). Instance defaults are served by
 * GET /api/models (`curationDefault`); a per-project partial overrides the fields
 * it sets (issue #384).
 */
export interface CurationConfig {
  /** Budget for OVERVIEW.md. */
  overviewMaxTokens: number;
  /** Budget for CHANGELOG.md (injected into the preload). */
  changelogMaxTokens: number;
  /** Budget for the CLAUDE.md curated-notes section. */
  claudeMaxTokens: number;
}

/** A per-project curation override — every field optional (absent ⇒ inherit). */
export type CurationOverride = Partial<CurationConfig>;

/**
 * A file the user attached in the composer (issue #328), already uploaded to the
 * attachment store. Rendered as a thumbnail (image) or chip (other) in the user
 * bubble, and passed to the server on send so it prepends the Read-tool hint.
 */
export interface AttachmentRef {
  /** Opaque attachment-store id — also the basename served at `/api/chat-files/:id`. */
  id: string;
  /** Original display filename. */
  filename: string;
  /** Renderer hint (image → thumbnail, else typed chip). */
  kind: AttachmentKind;
  /** Byte size (for the chip's size label); absent on a reload-parsed ref. */
  size?: number;
}

/** Renderer hint for an attachment (a superset-ish of SentFileKind + generic `file`). */
export type AttachmentKind =
  | "image"
  | "video"
  | "pdf"
  | "markdown"
  | "code"
  | "text"
  | "html"
  | "file";

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
  summary: string;
  links?: ProjectLink[];
  dir: string;
  /**
   * The keeper's working directory (cwd). Equals `dir` for a notebook project;
   * for a repo-backed project it's the nested checkout under `dir` (issue #187);
   * for a LINKED project it's `path` — an existing checkout outside the data repo
   * that Paddock uses in place and never writes to (issue #206).
   */
  workingDir: string;
  /**
   * Where the sweeper's curated trio (`CLAUDE.md`/`OVERVIEW.md`/`CHANGELOG.md`)
   * lives: `workingDir` for a managed project, `dir` for an unmanaged one. Equals
   * `dir` except for a managed project with an external `path` (issue #206).
   */
  contentDir: string;
  /**
   * Whether Paddock curates this project's own files (issue #206) — always
   * concrete, derived server-side as `managed ?? !(repo || path)`.
   *
   * Replaced `repoBacked`. Whether a git repo backs the project is a SEPARATE
   * question, answered per directory by the git status endpoint (`status.repo`),
   * not by this flag.
   */
  managed: boolean;
  /** The external git repo URL, when one is recorded (issue #187 / #206). */
  repo?: string;
  /**
   * The directory this project's content lives in, when one was nominated
   * (issue #206). `workingDir` equals it. For an unmanaged project this is a
   * checkout used in place; for a managed one it is where the notes live.
   */
  path?: string;
  /** True once a sweep has written OVERVIEW.md (drives the preload checkbox + Overview hint). */
  hasOverview: boolean;
  /** Pinned file names rendered as sibling tabs (order-preserving). Default []. */
  pinned: string[];
  /** The keeper model this project runs on. Always concrete (server resolves the default). */
  model: string;
  /**
   * Per-project offered-models allow-list (issue #457 Step 2). `undefined` =
   * offer the instance list (`/api/models`); a non-empty array of catalog ids
   * NARROWS the picker to that subset. Raw override (not baked concrete) — the UI
   * resolves the offered list as `models ?? instance list`.
   */
  models?: string[];
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
   * Per-project keeper-chat recovery override (issue #301). `undefined` = inherit
   * every instance default (`PADDOCK_RECOVERY_*`); a partial object overrides the
   * fields it sets. Layer 2 (`surfaceKilledTask`) drives the "keeper is idle" +
   * Continue affordance; the rest configure the (follow-up) Layer 3 auto re-drive.
   */
  recovery?: RecoveryOverride;
  /**
   * Per-project inbound-attachment override (issue #328). `undefined` = inherit
   * every instance default (`PADDOCK_ATTACHMENTS_*`); a partial object overrides
   * the fields it sets. The composer resolves the effective config (this ??
   * instance default) to gate its picker + client-side size/type guards.
   * (Surfacing this in Settings is Phase 2; the field is wired now.)
   */
  attachments?: AttachmentsOverride;
  /**
   * Per-project sweeper-curation budget override (issue #384). `undefined` =
   * inherit every instance default (`PADDOCK_CURATION_*`); a partial object
   * overrides the per-file token budgets it sets. Resolved against the instance
   * default at sweep time.
   */
  curation?: CurationOverride;
  /**
   * Compact per-chat "last completed turn" timestamps for the sidebar UNREAD
   * badge (#161): one entry per project chat that has a completed keeper turn,
   * `lastTurnCompletedAt` being its most recent (from job records, not a
   * transcript parse). The sidebar counts entries whose time is newer than the
   * server-backed `lastSeen` read-state (#160/#189). Absent/[] means no completed
   * chats. `lastSeen` is the per-user (or shared) last-viewed epoch-ms, absent
   * when the chat has never been seen on this instance.
   */
  chatTurns?: {
    sessionId: string;
    lastTurnCompletedAt: string;
    lastSeen?: number;
    /** Manual unread override (#458) — folded into the sidebar unread badge count. */
    unread?: boolean;
  }[];
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
  /**
   * Absolute path to the directory this project's content lives in (issue #206).
   *
   * An existing directory is used in place; a missing one is cloned into (with
   * `repo`) or created (when managed). The server validates it — absolute, and
   * outside the projects root / data dir / every other project's working
   * directory — and rejects the create otherwise. No git repo is required.
   * Immutable once set, and it takes precedence over `repo` for the cwd.
   */
  path?: string;
  /**
   * Whether Paddock curates this project's own CLAUDE.md/OVERVIEW.md/CHANGELOG.md
   * (issue #206). Omit to let the server derive it as `!(repo || path)` — which
   * settles the unambiguous cases — and send it explicitly only for a `path` with
   * no `repo`, where "checkout" vs "notes folder" is a real choice.
   * `managed: true` together with `repo` is rejected.
   */
  managed?: boolean;
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
  /**
   * Per-project offered-models allow-list (issue #457 Step 2). A non-empty array
   * of catalog ids narrows this project's picker (each must be within the instance
   * allow-list); an empty array or `null` clears the override so it offers the
   * instance list again. Same reset-to-inherit tri-state as `driveMode`.
   */
  models?: string[] | null;
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
  /**
   * When this chat was last actually used: the timestamp of the last real
   * message in its transcript (#863), falling back to the file's mtime only
   * when no message carries a usable date. Deliberately NOT mtime — Paddock
   * touches transcripts for reasons that are not conversation, and this is both
   * the "updated X ago" label and the sidebar's sort key.
   */
  updatedAt: string;
  resumable: boolean;
  preview?: string;
  /**
   * Whether the chat is filed away in the Archived section (issue #95). A
   * non-destructive per-chat flag; archived chats stay fully functional.
   */
  archived?: boolean;
  /**
   * Whether the chat is starred/pinned (issue #373). Starred chats float to the
   * top of their population (active or Archived). Orthogonal to `archived` — a
   * chat can be both. A non-destructive per-chat flag.
   */
  starred?: boolean;
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
   * Whether the user MANUALLY flagged this chat unread (#458) — a per-user
   * override layered on top of the derived unread signal, so a chat resurfaces
   * its cue even after its last turn was seen ("look at it again in the
   * morning"). Cleared when the chat is marked seen. Absent ⇒ not manually flagged.
   */
  unread?: boolean;
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
   * The chat that CREATED this one — the edge the sidebar nests on. Recorded at
   * creation for newer chats, backfilled server-side from the injected kickoff
   * message for older ones. Absent for roots and where no edge is recoverable.
   *
   * `project` may differ from the one being viewed (a keeper can spawn into a
   * sibling project); the tree renders those as roots, since their parent isn't
   * in this list to nest under.
   */
  parent?: ChatParentRef;
  /**
   * For a TRIGGER chat (Epic T / T4): the truthful-from-config capability descriptor
   * of the trigger that owns it — its type (schedule/event/webhook), WHEN it fires,
   * and granted tools, read from the same `trigger-<slug>-<name>` agent config
   * herdctl enforces. Drives the floating capability banner atop the chat (see
   * {@link ChatTriggerInfo}). Absent for every non-trigger chat.
   */
  trigger?: ChatTriggerInfo;
}

/**
 * How a chat came to exist (issue #261) — the dimension the list badges (#267). The
 * `hook` origin is reused by event/webhook triggers (Epic T), which share the same
 * badge surface.
 *
 * `adopted` (#588) is the one origin that predates paddock entirely: the chat was
 * adopted from the user's own Claude Code CLI history, so its turns happened in a
 * terminal before this project ever saw them. It is badged for exactly that reason
 * — adopted history reads identically to a chat started here otherwise, and "did I
 * write this in paddock or in my terminal?" is not answerable from the transcript.
 */
export type ChatOrigin = "human" | "scheduled" | "spawned" | "hook" | "adopted";

/**
 * The capability descriptor of the TRIGGER that owns a trigger chat (Epic T / T4) —
 * mirrors the server's `ChatTriggerInfo` (packages/server/src/trigger-config.ts). The
 * successor to the retired Epic G hook banner: it also carries the trigger `type` and
 * WHEN it fires (an event `on`, a `cron`/`interval`, or a webhook `path`). Everything
 * here is read from the registered `trigger-<slug>-<name>` agent config, so the banner
 * it drives is truthful by construction.
 */
export interface ChatTriggerInfo {
  /** The trigger's name (`project.yaml` map key + the `<name>` in its agent name). */
  name: string;
  /** WHICH kind of trigger fires this chat (schedule / event / webhook). */
  type: TriggerType;
  /** For an `event` trigger: the lifecycle event that fires it. */
  event?: TriggerEvent;
  /** For a `schedule` trigger: the cron expression, when cron-timed. */
  cron?: string;
  /** For a `schedule` trigger: the interval string, when interval-timed. */
  interval?: string;
  /** For a `webhook` trigger: the reserved ingress path. */
  path?: string;
  /** The herdctl agent enforcing the capability (`trigger-<slug>-<name>`). */
  agentName: string;
  /** Whether the trigger is currently armed (a disabled trigger's past chats still show). */
  enabled: boolean;
  /**
   * The declared tool grant (herdctl `allowed_tools`); `[]` = none declared. Note
   * `[]` is NOT enforced as a deny-all — herdctl only emits the allow-list when it
   * is non-empty, so an empty one leaves Claude's default tools in place (#647).
   */
  allowedTools: string[];
  /** The permission mode the trigger's turns run under, when it sets one. */
  permissionMode?: string;
  /** The trigger agent's model override, when set (else the keeper default applies). */
  model?: string;
  /** The trigger's max agent turns (its runaway bound). */
  maxTurns: number;
}

/** A chat's provenance marker (issue #261): origin + spawn depth. */
export interface ChatProvenance {
  origin: ChatOrigin;
  /** Spawn hops from the human/scheduled root (0 = root itself). */
  depth: number;
}

/**
 * One working directory the user already has native Claude Code CLI history for,
 * and which of its sessions this workspace could adopt (#588).
 *
 * There can be more than one: a repo-backed project matches both its own working
 * directory and the ORIGIN checkout the user actually ran `claude` in. The server
 * dedupes by session id across sources, so the ids here do not overlap.
 */
export interface AdoptableSource {
  /** The native transcript folder's recorded cwd. */
  sourceCwd: string;
  /** The adoptable (native, non-sidechain, un-adopted) session ids under it. */
  sessionIds: string[];
  /** The same sessions, with what the confirmation dialog needs to show them. */
  sessions: AdoptableCandidate[];
}

/**
 * One session on offer, described well enough to decide about (#660).
 *
 * The adoption used to be an unconfirmed click, so an id was all the count needed.
 * A dialog that asks "adopt these?" has to say what "these" ARE — the instance
 * that prompted this offered 26 chats of which the user recognised none.
 */
export interface AdoptableCandidate {
  sessionId: string;
  /** ISO 8601 last-modified time of the transcript. */
  mtime: string;
  /** First user message, truncated server-side at 100 chars. */
  preview?: string;
  /** Auto-generated session name, when the transcript carries a summary. */
  autoName?: string;
  sizeBytes: number;
}

/**
 * `GET <base>/adoptable-chats` (#588) — how many native CLI chats this workspace
 * could adopt right now, and where they'd come from.
 *
 * `count` is a LIVE figure, not a one-shot offer: it is re-read after every adoption
 * and drops to 0 only because there is genuinely nothing left to take, so the
 * adoption affordance reappears by itself if the user later runs more terminal
 * sessions in the same directory (gotcha #5 on the issue).
 */
export interface AdoptableChats {
  count: number;
  sources: AdoptableSource[];
}

/** One session the adoption declined to take, and why. */
export interface AdoptSkip {
  sessionId: string;
  reason: string;
}

/**
 * `POST <base>/adopt-chats` (#588) — the session ids actually adopted, plus the
 * ones that were passed over. A partly-skipped adoption is a success with a caveat,
 * not a failure: the adopted chats are really there, so the result is reported
 * rather than thrown.
 */
export interface AdoptChatsResult {
  adopted: string[];
  skipped: AdoptSkip[];
}

/**
 * `POST <base>/unadopt-chats` (#660) — the session ids released by undoing the
 * most recent adoption.
 *
 * An empty array is a legitimate, non-error outcome: there was nothing to undo
 * because nothing was adopted, it has already been undone, or the server has
 * restarted since (the undo offer is deliberately in-memory and short-lived).
 */
export interface UnadoptChatsResult {
  released: string[];
}

/**
 * The chat that created another one — the sidebar's nesting edge. Mirrors the
 * server's `ChatParentRef` (packages/server/src/chat-dto.ts).
 */
export interface ChatParentRef {
  project: string;
  sessionId: string;
  /** The parent's display name at creation time — a fallback label only. */
  name?: string;
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

/** One tool a trigger may be granted, for the capability picker (server catalog). */
export interface GrantableTool {
  name: string;
  group: "read" | "write" | "web" | "orchestration" | "browser";
  description: string;
}

// --- Unified triggers (Epic T / T4) ----------------------------------------
// A trigger collapses event hooks + cron schedules into ONE declarative shape over
// the `startAgentTurn` core: WHEN ({@link TriggerWhen}, a discriminated union) + WHAT
// ({@link TriggerRun}) + `enabled`. Mirrors the server's `trigger-config.ts`; drives
// the Triggers tab (the successor to the Hooks tab + the Settings→Schedules section).

/** The trigger kinds. `webhook` is shape-reserved (no ingress yet — deferred T6). */
export type TriggerType = "schedule" | "event" | "webhook";

/** The lifecycle events an `event`-type trigger may fire on (mirrors the server). */
export type TriggerEvent = "onArchive" | "afterTurn";

/** New-vs-accrete for a fired trigger: a fresh chat each fire, or one owned session. */
export type TriggerSession = "new" | "resume";

/** The Claude Code permission mode a trigger agent's turns run under. */
export type TriggerPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/** WHEN a trigger fires — a discriminated union on `type`. */
export type TriggerWhen =
  | { type: "schedule"; cron?: string; interval?: string }
  | { type: "event"; on: TriggerEvent }
  | { type: "webhook"; path: string };

/**
 * WHAT a fired trigger does — the shared agent-run definition (identical across every
 * trigger type). Exactly one of `prompt` / `promptFile`; `tools` is the allow-list
 * (`[]` = none declared, which herdctl does not enforce as a deny-all — see #647).
 */
export interface TriggerRun {
  prompt?: string;
  promptFile?: string;
  session: TriggerSession;
  model?: string;
  tools: string[];
  maxSpawnDepth?: number;
  permissionMode?: TriggerPermissionMode;
  maxTurns?: number;
}

/**
 * A project's trigger (the project.yaml `triggers` record) plus its map key `name`
 * and the herdctl agent it registers as (`trigger-<slug>-<name>`). The DTO the
 * unified `/api/projects/:slug/triggers` surface returns (Epic T / T3).
 */
export interface Trigger {
  name: string;
  agentName: string;
  trigger: TriggerWhen;
  run: TriggerRun;
  enabled: boolean;
}

/** The write shape for creating/replacing a trigger (the server sanitises it). */
export interface TriggerInput {
  trigger: TriggerWhen;
  run: TriggerRun;
  enabled: boolean;
}

/**
 * The Triggers tab's list payload: the triggers + the picker's catalog — the
 * grantable tools, the events an event-trigger can fire on, and the trigger types —
 * so the tab renders precise type/event/capability pickers without hard-coding them.
 */
export interface TriggersResponse {
  triggers: Trigger[];
  grantableTools: GrantableTool[];
  events: TriggerEvent[];
  triggerTypes: TriggerType[];
}

/**
 * A trigger's most-recent RUN (Epic T follow-up / #327) — projected from a herdctl job
 * record, or synthesized from a schedule fire when no per-trigger job is attributable.
 */
export interface TriggerLastRun {
  /** herdctl job id, or null when the last-run is only known from schedule state. */
  jobId: string | null;
  /** The chat the run belongs to (link target), or null. */
  sessionId: string | null;
  /** Terminal/live status: completed | failed | cancelled | running | pending. */
  status: string;
  /** Why it exited (success | error | max_turns | timeout | cancelled), if recorded. */
  exitReason: string | null;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** ISO timestamp the run finished, or null while running. */
  finishedAt: string | null;
  /** Wall-clock seconds, or null while running / unrecorded. */
  durationSeconds: number | null;
  /** The agent's own one-line summary of the run, when it wrote one. */
  summary: string | null;
}

/**
 * One trigger's live RUNTIME state (Epic T follow-up / #327) — the "last-run / next-run
 * / status" the Triggers tab renders alongside each trigger's config. Config is served
 * by {@link TriggersResponse}; this is the runtime half, polled separately so the tab
 * refreshes status without re-fetching the picker catalog. Keyed by `name`.
 */
export interface TriggerRuntime {
  name: string;
  type: TriggerType;
  /** True when a run is in flight (a live job, or the cron scheduler reports running). */
  running: boolean;
  /** ISO timestamp of the next scheduled fire (schedule triggers only), else null. */
  nextRunAt: string | null;
  /** Cron scheduler status for a schedule trigger (idle/running/disabled), else null. */
  scheduleStatus: string | null;
  /** The last fire's error message (schedule triggers), or null. */
  lastError: string | null;
  /** The most-recent run, or null when the trigger has never fired. */
  lastRun: TriggerLastRun | null;
}

/** The Triggers tab's runtime-state payload (the "status" half of the view). */
export interface TriggerRuntimeResponse {
  runtime: TriggerRuntime[];
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
 * On the Max plan this cost is informational (no per-token quota) — the
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

/**
 * Which chats `GET /chats/usage` computes rings for (issue #537). The server
 * defaults to `active`, so archived rings are only paid for once the sidebar's
 * Archived group is expanded.
 */
export type ChatUsageScope = "active" | "archived" | "all";

/** A persisted message hydrated from a session's transcript (core ChatMessage). */
export interface ChatToolCall {
  toolName: string;
  inputSummary?: string;
  output: string;
  isError: boolean;
  durationMs?: number;
  /**
   * True when this tool call is still in flight on history rehydration
   * (herdctl#399 / `@herdctl/core@5.24.0`): `parseSessionMessages` emits an
   * unpaired `tool_use` (no matching `tool_result`) as a `role:"tool"` message
   * with `pending:true` (empty output, no duration), upgraded in place when the
   * `tool_result` arrives. The web renders this as the same live "RUNNING" block
   * (#175) so a foreground sub-agent/tool no longer vanishes on refresh.
   */
  pending?: boolean;
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

/**
 * A surfaced turn-ending condition (issue #329). A keeper turn can dead-end
 * without a normal reply — a subscription/usage-limit hit, the max-turns cap, or
 * an error (network / API 5xx-overload / auth / crash). The server classifies the
 * ending and the web renders it as a distinct notice turn instead of a silently
 * dead chat. Mirrors the server's `TurnNotice`.
 */
export interface TurnNotice {
  kind: "usage_limit" | "error" | "max_turns";
  /** One-line human summary shown in the banner. */
  message: string;
  /** Usage-limit only: the parsed "resets …" clause, e.g. `"7:10pm (…)"`. */
  resetTime?: string;
  /** Optional secondary detail (the raw SDK error subtype / message). */
  detail?: string;
  /** Whether a Continue/Retry affordance is safe to offer (false for a limit). */
  retryable: boolean;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  toolCall?: ChatToolCall;
  /** A surfaced turn-ending condition recovered from the transcript on reload
   *  (issue #329) — present only on the synthetic notice message the server
   *  appends. Rendered as a distinct notice turn, not an assistant bubble. */
  notice?: TurnNotice;
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
  /**
   * Context-window fill (tokens) as of this message (issue #451): the nearest
   * assistant turn's `input + cache_read + cache_creation`, forward-filled across
   * the turns between. Drives the per-message hover meter. Absent before the
   * first assistant turn (and on older transcripts).
   */
  contextTokens?: number;
}

/** Enriched single-project response from GET /api/projects/:slug. */
export interface ProjectDetail {
  project: Project;
  changelog: string;
  /**
   * Raw OVERVIEW.md text — the sweep-curated current-state notes, rendered on
   * Home as the sibling of the changelog (#599). `""` when the workspace has no
   * overview yet, same as `changelog`. Optional on the wire so a client running
   * against an older server degrades to "no overview" rather than crashing.
   */
  overview?: string;
  chats: Chat[];
}

/**
 * One row of the Home attention feed (#599): a chat, plus which workspace it
 * belongs to. The workspace fields are what let the ROOT's fleet-wide list stay
 * attributable — the same chat name can exist in three projects, and "which one
 * is this?" has to be answerable from the row itself.
 */
export interface AttentionChat extends Chat {
  projectSlug: string;
  projectName: string;
}

/**
 * `GET <base>/chats/attention` — the chats in a workspace's SUBTREE that are
 * running or unread. On the root mount the subtree is the whole fleet; on a
 * project mount it is that project alone. A chat appears in at most one list: a
 * live turn hasn't landed a reply yet, so `running` wins.
 */
export interface AttentionChats {
  running: AttentionChat[];
  unread: AttentionChat[];
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

/** Routing fields present on every server->client chat event. */
interface Routing {
  projectSlug: string;
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
        /** Live sub-agent enrichment recovered from the launch input (#429). */
        subagentType?: string;
        description?: string;
        hasSubagent?: boolean;
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
        /** Live sub-agent enrichment recovered from the launch input (#429). */
        subagentType?: string;
        description?: string;
        hasSubagent?: boolean;
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
  | { type: "chat:error"; payload: { projectSlug: string; error: string } }
  | {
      /** Re-attach fallback: the live turn's buffer aged out; re-hydrate from transcript (issue #54). */
      type: "chat:resync";
      payload: { projectSlug: string; sessionId: string };
    }
  | {
      /** A session's live-turn status changed — drives Stop restore + indicators (issues #52/#53). */
      type: "chat:active";
      payload: {
        projectSlug: string;
        sessionId: string;
        jobId: string | null;
        running: boolean;
        /**
         * Epoch-ms the turn started, from the hub (the only thing that knows —
         * a job record is written at the END of a turn). Optional so a client
         * built against an older server still parses the frame; when it is
         * absent the client renders a placeholder rather than inventing a
         * start time, because a clock that silently restarts on every reload is
         * worse than one that admits it does not know.
         */
        startedAt?: number;
        /**
         * Whether a MODEL TURN is in flight, as opposed to `running`, which since
         * #604 also counts background work left behind by a finished turn. Status
         * readouts use `running`; the composer lock and working indicator use this,
         * so an hour-long Monitor does not make the chat unusable. Optional: an
         * older server omits it and the client falls back to `running`.
         */
        turnRunning?: boolean;
      };
    }
  | {
      /** The server auto-sent the queued message, so clear localStorage (#197). */
      type: "chat:queued_flushed";
      payload: { projectSlug: string; sessionId: string };
    }
  | {
      /**
       * The chat's queued message changed server-side (#629). The slot is shared
       * chat state — one queue per chat, not one per client — so every attached
       * client renders what the server actually holds, and echoes `qid` back on
       * its next write to prove it is editing the slot as it stands.
       */
      type: "chat:queued_state";
      payload: {
        projectSlug: string;
        sessionId: string;
        text: string | null;
        qid?: string;
        /** `returned` — a user pressed Stop and took the message back (#751). */
        reason?: "returned";
      };
    }
  | {
      /**
       * A user pressed Stop, so the queued message is handed BACK to their
       * composer instead of being sent (#751). Sent only to the socket that
       * asked to cancel — never rendered as a sent user bubble, because it
       * wasn't sent.
       */
      type: "chat:queued_returned";
      payload: { projectSlug: string; sessionId: string; text: string };
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
  | {
      /**
       * A background task was killed at the turn boundary and the keeper is idle
       * (issue #347). Broadcast live by the recovery engine on detection so the
       * "keeper is idle / Continue" affordance appears without a refresh.
       */
      type: "chat:killed_task";
      payload: Routing & { sessionId: string; summary: string; timestamp: string };
    }
  | {
      /**
       * A session's live background work (#604) — the tasks still running after
       * the turn that launched them returned. A LEVEL frame: `tasks` is the
       * complete set and an empty array means idle, so clients replace rather
       * than pair edges (a dropped frame then cannot wedge a stale indicator).
       * Broadcast on every change and replayed on connect.
       */
      type: "chat:background";
      payload: Routing & { sessionId: string; tasks: LiveBackgroundTask[] };
    }
  | {
      /**
       * The answer to one `chat:stop_task` (#848). Unicast to the asking socket.
       * `stopping` = accepted, wait for the terminal notification to remove the
       * row; `gone` = no live session, the work died with it (not an error, and
       * the server has already dropped the row); `error` = the stop did NOT
       * happen and the task is still running.
       */
      type: "chat:stop_task_result";
      payload: {
        sessionId: string;
        taskId: string;
        outcome: StopTaskResult["outcome"];
        message?: string;
      };
    }
  | {
      /**
       * A keeper turn dead-ended without a normal reply (issue #329): a
       * subscription/usage-limit hit, the max-turns cap, or an error. Emitted
       * inline during the turn so the chat surfaces WHY it stopped instead of
       * looking dead. Rendered as a distinct notice turn.
       */
      type: "chat:notice";
      payload: Routing & { notice: TurnNotice };
    }
  | { type: "pong" };

/**
 * One live background task on a session (#604), mirroring the server's
 * `LiveBackgroundTaskWire`.
 *
 * `type` is the RAW SDK discriminant (`local_bash`, `local_agent`, …) and `role`
 * is the rendering role the server derives from it (#846). Both are plain
 * strings on purpose: an unknown kind falls back to the raw discriminant and
 * should render as a generic row rather than be dropped.
 *
 * `role` is optional only so a stale cached SPA talking to a newer server — or
 * the reverse — degrades to the old raw-type rendering instead of blanking every
 * row. Read it through `roleOf` in `RunningWork.tsx`, never directly.
 */
export interface LiveBackgroundTask {
  id: string;
  type: string;
  role?: string;
  description: string;
  /** Epoch-ms the server first observed this task. */
  startedAt: number;
  /** Links the task to its launching tool card in the transcript, when known. */
  toolUseId?: string;
  /** `subagent` role only. */
  agentType?: string;
  /** `shell` role only. */
  command?: string;
  /** `workflow` role only. */
  workflowName?: string;
  /** `monitor` / MCP-task role only. */
  server?: string;
  tool?: string;
  /** Latest tool this task ran. */
  lastToolName?: string;
  /** Steps taken so far. */
  toolUses?: number;
  /** Ambient/housekeeping work the SDK asks consumers to keep out of the transcript. */
  skipTranscript?: boolean;
  /**
   * May this task be stopped (#848)? Decided by the SERVER, from the raw SDK
   * discriminant, and not re-derived here: `monitor_ws` can be killed and
   * `monitor_mcp` cannot, so a label alone is not enough to tell. Absent means
   * stoppable, so a server older than the field still offers the button.
   */
  stoppable?: boolean;
}

/**
 * What came back from asking the server to stop one background task (#848).
 *
 * Three outcomes, only ONE of which is a failure — collapsing them would either
 * alarm the user about work that is already gone, or (worse) tell them a task
 * stopped when it is still running:
 *
 *  - `stopping` — accepted. Hold the row; the SDK's terminal notification is
 *    what removes it. A click that raced a natural completion lands here too,
 *    because the stop is idempotent.
 *  - `gone` — the session is no longer live, so the work went with it. Settle
 *    quietly; the row is already on its way out via `chat:background`.
 *  - `error` — the stop was refused and the task is STILL RUNNING (a
 *    `monitor_mcp` task, say, which the CLI cannot kill). Say so on the row.
 */
export interface StopTaskResult {
  taskId: string;
  outcome: "stopping" | "gone" | "error";
  /** Present only on `error` — safe to show. */
  message?: string;
}

// --- Instance-wide settings (issue #385) ------------------------------------

/**
 * The rendering/validation kind of an instance-config field. `text` is `string`
 * with a multi-line control (a `<textarea>`) — identical wire shape and
 * coercion, used for prompt-sized values (issue #635).
 */
export type InstanceConfigFieldType =
  | "number"
  | "boolean"
  | "string"
  | "text"
  | "enum"
  | "string-list";

/**
 * One field on the instance-wide Settings screen (GET /api/instance-config).
 * `default` is the built-in default. A field renders read-only when `!editable`
 * OR `envOverridden` (an env var shadows the file, so editing it would silently
 * no-op).
 *
 * TWO values, because the file and the running process can disagree (#722):
 *  - `value` — what the running process resolved at boot (frozen there);
 *  - `pendingValue` — what `paddock.config.yaml` says right now, i.e. what a
 *    restart would resolve. The editor binds to THIS, so a save round-trips
 *    instead of appearing to revert and another tab's write is visible.
 */
export interface InstanceConfigField {
  key: string;
  group: string;
  label: string;
  help?: string;
  type: InstanceConfigFieldType;
  enumValues?: string[];
  value: unknown;
  pendingValue: unknown;
  /** `pendingValue` differs from `value`: this field is waiting on a restart. */
  pendingRestart: boolean;
  default: unknown;
  editable: boolean;
  sensitive: boolean;
  envOverridden: boolean;
  /** The env var shadowing this field (present only when `envOverridden`). */
  envVar?: string;
}

export interface InstanceConfigGroup {
  id: string;
  label: string;
  description?: string;
  fields: InstanceConfigField[];
}

export interface InstanceConfig {
  groups: InstanceConfigGroup[];
  /** Absolute path a PUT writes to (informational). */
  configPath: string;
  /** Some field's file value differs from the running process's. */
  restartRequired: boolean;
  /** Fingerprint of the file this snapshot was read from; echoed back on save. */
  configVersion: string | null;
  /** The file exists but could not be read/parsed (pending values unknowable). */
  configFileError?: string;
}

// --- Discovery (#745) --------------------------------------------------------
//
// Mirrors `packages/server/src/discover.ts`. Hand-mirrored rather than imported,
// the same as every other type in this file: the web package does not depend on
// the server package, and the wire shape is the contract between them.

/**
 * Why a transcript folder did not become a candidate. Reported as a TALLY (rule
 * → count), never as a list of paths — a page that says "nothing found" with no
 * further explanation is indistinguishable from a broken one.
 */
export type DiscoverExclusion =
  | "no-recorded-cwd"
  | "missing"
  | "system-path"
  | "temp-root"
  | "paddock-internal"
  | "home-root"
  | "outside-home"
  | "already-managed"
  | "no-git"
  | "no-sessions";

/** One directory Discovery proposes as a project (`GET /api/discover`). */
export interface DiscoverCandidate {
  /**
   * The directory, symlinks resolved — the value to POST as `path` to
   * `POST /api/projects`, and therefore also the created project's `workingDir`.
   */
  path: string;
  /**
   * The cwd the transcripts actually record, when it is a DIFFERENT spelling of
   * {@link path} (a symlinked home, `/private/var` vs `/var`).
   *
   * Absent in the ordinary case, and worth surfacing when present: a linked
   * project's importable sources are matched on EXACT cwd equality against its
   * stored (resolved) working directory, so a divergent spelling is how an
   * import comes back with zero chats despite a healthy count on this row.
   */
  recordedPath?: string;
  /** Basename — the name a project created here should default to. */
  name: string;
  /** A slug free on this instance (basename-derived, parent-qualified on collision). */
  suggestedSlug: string;
  hasGit: boolean;
  /** First normalised git remote, when the checkout has one. */
  gitRemote?: string;
  insideHome: boolean;
  /** Sessions on offer here, after the shared noise filter. The ranking key. */
  sessionCount: number;
  /** Sessions the noise filter withheld — so "why 5 and not 12?" has an answer. */
  filteredCount: number;
  /** ISO 8601 mtime of the newest offered session. */
  lastSessionAt?: string;
}

/** `GET /api/discover` — what Discovery found, and what it threw away. */
export interface DiscoverResult {
  /** The Claude home that was scanned — the directory to bind-mount in a container. */
  claudeHome: string;
  homeDir: string;
  /** Transcript folders enumerated. `0` means "no history at all". */
  scanned: number;
  candidates: DiscoverCandidate[];
  /** Rule → how many DIRECTORIES it excluded. Only non-zero entries appear. */
  excluded: Partial<Record<DiscoverExclusion, number>>;
}

/**
 * `GET /api/discover/sessions?dir=…` — one directory's importable sessions, for
 * lazy expansion of a row. `sessions[].sessionId` is what `POST …/adopt-chats`
 * takes as `sessionIds`.
 */
export interface DiscoverSessions {
  path: string;
  sessions: AdoptableCandidate[];
  /** Withheld candidates and why — same vocabulary as `adoptable-chats`. */
  filtered: Array<{ sessionId: string; reason: string }>;
}
