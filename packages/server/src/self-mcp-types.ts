/**
 * Type declarations for the Paddock self-management MCP (issue #214).
 *
 * The agent-facing DTOs (`SelfMcpProject`/`SelfMcpChat`/`SelfMcpMessage`/
 * `SelfMcpTrigger`) plus the two per-turn context bags (`SelfMcpContext` read-side,
 * `SelfMcpWriteContext` write-side) the caller wires to ProjectStore/HerdctlService.
 * Pure declarations — no runtime code — re-exported from `self-mcp.ts` so existing
 * importers keep working.
 */

/** A project as surfaced to the agent. */
export interface SelfMcpProject {
  slug: string;
  name: string;
  /** The project's area ("Unsorted" when empty); omitted when blank. */
  area?: string;
  status: string;
}

/**
 * The arguments `create_project` passes through to the create path (issue #467) —
 * the subset of {@link import("./project-types.js").CreateProjectInput} the tool
 * exposes, already trimmed + shape-validated by the handler. Deliberately a local
 * declaration (not an import of `CreateProjectInput`) so this module keeps zero
 * runtime coupling; the caller widens it back to the real input at the boundary.
 */
export interface SelfMcpCreateProjectInput {
  name: string;
  /** Explicit kebab-case slug; absent ⇒ the store derives one from `name`. */
  slug?: string;
  /** Git URL ⇒ a REPO-BACKED project (#187): cloned into a nested checkout. */
  repo?: string;
  summary?: string;
  /** The project's area (persisted as `group`; `list_projects` reports it as `area`). */
  group?: string;
  status?: string;
}

/** A newly-created project as surfaced back to the agent (issue #467). */
export interface SelfMcpCreatedProject {
  slug: string;
  name: string;
  /** The project's metadata dir (OVERVIEW/CHANGELOG/`.chats` live here). */
  dir: string;
  /** The keeper's cwd — the nested checkout when repo-backed, else `dir`. */
  workingDir: string;
  /** Whether the project is backed by a cloned external repo (#187). */
  repoBacked: boolean;
  /** The repo URL when repo-backed, else undefined. */
  repo?: string;
  /**
   * Whether the keeper agent registered. The REST create path treats a registration
   * failure as non-fatal (the project IS created), so this mirrors it — but reports
   * it, because a project with no live keeper can't take a `create_chat` yet.
   */
  keeperRegistered: boolean;
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
  /**
   * Whether the chat is filed away in the UI's "Archived" section (#489). Always
   * present — `list_chats` hides archived chats by default, so the flag is what
   * lets a caller that passed `include_archived: true` tell the two apart, and it
   * mirrors the REST DTO (`chat-dto.ts`), which has always carried it.
   */
  archived: boolean;
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
  /**
   * Start a brand-new chat in `projectSlug` kicked off with `prompt`. Returns its
   * new sessionId. `opts.model` (issue #336) is a per-chat model override for the
   * spawned chat's kickoff turn ONLY — already validated against the picker
   * allow-list by the handler; absent ⇒ inherit the project/box default.
   */
  createChat: (
    projectSlug: string,
    prompt: string,
    opts?: { name?: string; preloadContext?: boolean; model?: string },
  ) => Promise<{ sessionId: string }>;
  /**
   * Eager-fork `sourceSessionId` (in `projectSlug`) into a new chat, optionally
   * kicked off with `prompt`. Returns the new sessionId. `model` (issue #336) is a
   * per-chat override applied to the kickoff turn ONLY (a fork with no `prompt`
   * runs no turn, so a `model` without a `prompt` has no effect); absent ⇒ inherit
   * the project/box default.
   */
  forkChat: (args: { projectSlug: string; sourceSessionId: string; prompt?: string; name?: string; model?: string }) => Promise<{ sessionId: string }>;
  /** Send `prompt` as a new turn to an existing chat. */
  sendMessage: (projectSlug: string, sessionId: string, prompt: string) => Promise<void>;
  /** Set (or clear) a chat's archived flag (presentational metadata only). */
  setArchived: (projectSlug: string, sessionId: string, archived: boolean) => Promise<void>;
  /**
   * Whether the PROJECT tools (`create_project`, issue #467) are enabled for this
   * instance — the `selfMcpProjectsEnabled` gate, resolved by the caller. When false
   * the tool is NOT injected at all (absent, not present-but-refusing), the same
   * binary discipline as {@link triggersMcpEnabled}.
   */
  projectsMcpEnabled: boolean;
  /**
   * Provision a whole new project and register its keeper agent — the SAME two steps
   * `POST /api/projects` performs, in the same order (`ProjectStore.create` then
   * `ensureProjectAgent`), so the REST and MCP paths cannot drift. All the real work
   * (slug/repo validation, `project.yaml`, seeded CHANGELOG/CLAUDE.md, the #187
   * repo-backed clone into a nested `.gitignore`d checkout WITH rollback on failure)
   * stays in the store. Throws on a create failure; a keeper-registration failure is
   * non-fatal (mirroring the route) and reported via `keeperRegistered`.
   */
  createProject: (input: SelfMcpCreateProjectInput) => Promise<SelfMcpCreatedProject>;
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
