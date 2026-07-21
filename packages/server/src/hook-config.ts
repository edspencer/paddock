/**
 * Event-hook config helpers (Epic G, ticket G1 — hook foundation).
 *
 * A hook is an **event-triggered agent turn** (design doc §5, GG-1..GG-4). Each
 * hook is registered as its OWN herdctl agent `hook-<slug>-<name>` — exactly how
 * keeper/sweeper/scratch agents are registered via `fleet.addAgent` — whose tool
 * config (`allowed_tools`/`denied_tools`/`permission_mode`/`model`/`max_turns`) IS
 * its capability set. There is NO hook "kind"/profile and NO "curator" concept: a
 * hook with no tools is simply a hook granted no tools; a hook that must write files
 * is granted `Write` and does the I/O itself.
 *
 * This module is the small, pure surface around that model — the exact shape of the
 * shipped `schedule-config.ts` so the two features stay symmetric:
 *
 *  - {@link sanitizeHooks} — validate/normalise a hand-edited `project.yaml` `hooks`
 *    map, DROPPING malformed entries so one bad edit can't brick the project's agent
 *    registration (an invalid agent config would throw in `addAgent`).
 *  - {@link hookToAgentToolConfig} — project a hook's {@link HookCapabilities} onto
 *    the exact herdctl agent tool-config fields, so the hook agent enforces the
 *    capability by construction (the capability banner in G6 is therefore truthful).
 *    the project's `.paddock/hooks/` dir, rejecting traversal / non-`.md`.
 *
 * Keeping this off `projects.ts`/`herdctl.ts` makes each piece unit-testable in
 * isolation and gives G3/G4/G5 (visibility, Hooks tab, hook MCP) ONE frozen shape to
 * build against.
 */

/**
 * The lifecycle events a hook can trigger on. v1 wires **`onArchive`** (fired after
 * a chat-archive commits — Ed's motivating cleanup example). The enum is the
 * extension point for the cheap after-commit siblings the design lists
 * (onChatCreate, onFork, onUnarchive, onProjectCreate); `onProjectDelete` needs
 * before/blocking semantics and is deliberately deferred.
 */
export type HookEvent = "onArchive";

/** The events v1 knows about — the guard {@link sanitizeHook} validates against. */
export const HOOK_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(["onArchive"]);

/** Claude Code permission mode a hook agent's turns run under. */
export type HookPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

/**
 * A hook's capability set (GG-1) — projected verbatim onto the hook's OWN herdctl
 * agent's tool config, so the registered agent enforces exactly these tools. An
 * absent/empty {@link HookCapabilities.allowedTools} is a **tool-less** hook (it can
 * only think + return text); granting `Bash` lets it spin down servers / delete
 * clones itself. This is intentionally the whole capability model — there is no
 * higher-level profile.
 */
export interface HookCapabilities {
  /**
   * The tools the hook agent may use (herdctl `allowed_tools`). Omit or `[]` for a
   * tool-less hook. The CLI runtime auto-denies any tool NOT on this list, so this
   * is the effective grant.
   */
  allowedTools?: string[];
  /** Tools explicitly denied even if otherwise allowed (herdctl `denied_tools`). */
  deniedTools?: string[];
  /** The permission mode the hook agent's turns run under (herdctl `permission_mode`). */
  permissionMode?: HookPermissionMode;
  /** Model override for the hook agent; defaults to the keeper default when absent. */
  model?: string;
  /** Max agent turns — bounds a runaway hook. Defaults to {@link HOOK_DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
}

/**
 * A hook declaration — persisted per project (`project.yaml` `hooks` map, keyed by
 * name) with prompt bodies in `.paddock/hooks/*.md` (git-tracked + keeper-editable),
 * mirroring the shipped `.paddock/schedules/*.md` pattern.
 *
 * **New hooks default `enabled: false`** (GG-3) — a safe-create default so nothing
 * fires the instant a hook is written; enabling is just editing it to `true`.
 */
export interface PaddockHook {
  /** The lifecycle event this hook fires on. */
  event: HookEvent;
  /** The capability set granted to the hook's agent (GG-1). Absent = tool-less. */
  capabilities?: HookCapabilities;
  /**
   * The inline prompt the hook turn runs. A hook may instead point at a
   * {@link promptFile}, which Paddock reads fresh at fire time. When both are set the
   * file wins.
   */
  prompt?: string;
  /**
   * PADDOCK-ONLY convenience: a git-tracked, keeper-editable prompt file under the
   * project's `.paddock/hooks/` dir (e.g. `"cleanup.md"`), relative to that dir. Read
   * at fire time and used as the hook's prompt. Traversal outside `.paddock/hooks/`
   * and non-`.md` names are rejected.
   */
  promptFile?: string;
  /**
   * Whether the hook is armed. **Defaults `false`** for a newly-created hook (GG-3);
   * a disabled hook is registered as an agent but never fired by the dispatcher.
   */
  enabled?: boolean;
}

/**
 * The CRUD/DTO shape returned by the hook service ({@link import("./hooks.js").HookService}) —
 * a {@link PaddockHook} plus its map key `name` and the herdctl agent it registers
 * as. This is the frozen contract G4 (Hooks tab) and G5 (hook MCP) build against.
 */
export interface HookDto extends PaddockHook {
  /** The hook's name — the `project.yaml` map key + the `<name>` in its agent name. */
  name: string;
  /** The herdctl agent this hook is registered as (`hook-<slug>-<name>`). */
  agentName: string;
}

/**
 * The compact, web-facing capability descriptor for a hook chat (Epic G / G3,
 * GG-6). Rides on the chat DTO whenever a chat's provenance origin is `hook`, so
 * the floating capability banner can state — TRUTHFULLY FROM CONFIG — what the hook
 * agent is: its trigger {@link event}, its herdctl agent name, whether it's armed,
 * and the exact tool grant herdctl enforces on its turns. Built by
 * {@link toChatHookInfo} from the same {@link HookCapabilities} that
 * {@link hookToAgentToolConfig} projects onto the registered agent, so the banner and
 * the enforced capability can never disagree.
 */
export interface ChatHookInfo {
  /** The hook's name (`project.yaml` map key + the `<name>` in its agent name). */
  name: string;
  /** The lifecycle event that fires this hook. */
  event: HookEvent;
  /** The herdctl agent enforcing the capability (`hook-<slug>-<name>`). */
  agentName: string;
  /** Whether the hook is armed (a disabled hook's past chats are still shown). */
  enabled: boolean;
  /** The exact tool grant (herdctl `allowed_tools`); `[]` = a tool-less hook. */
  allowedTools: string[];
  /** Tools explicitly denied even if otherwise allowed, when the hook sets any. */
  deniedTools?: string[];
  /** The permission mode the hook's turns run under, when the hook sets one. */
  permissionMode?: HookPermissionMode;
  /** The hook agent's model override, when set (else the keeper default applies). */
  model?: string;
  /** The hook's max agent turns (its runaway bound). */
  maxTurns: number;
}

/** Default max agent turns for a hook when its capabilities don't set one. */
export const HOOK_DEFAULT_MAX_TURNS = 30;

/**
 * Resolve whether a project's turns get the hook-management MCP (Epic G / G5,
 * GG-4): a per-project override wins; otherwise inherit the instance default.
 * Mirrors {@link import("./spawn-capability.js").resolveMaxSpawnDepth} — a boolean
 * override is carried on disk only when set, so an absent value transparently
 * inherits the instance (env / YAML) default. A non-boolean override is ignored
 * (defensive: a hand-edited `project.yaml` can't wedge dispatch).
 */
export function resolveHooksMcpEnabled(
  override: boolean | undefined,
  instanceDefault: boolean,
): boolean {
  return typeof override === "boolean" ? override : instanceDefault === true;
}

/**
 * Merge a partial `set_hook` update (Epic G / G5) over the existing hook so an edit
 * that OMITS a field preserves it. `ProjectStore.setHook` full-REPLACES the named
 * record, so without this a caller that changes only the prompt would silently wipe
 * the hook's capability grant (and vice versa). `incoming` carries ONLY the fields
 * the caller supplied (the MCP handler builds it that way), so a shallow overlay is
 * exactly "patch the provided fields": a supplied `capabilities` replaces the whole
 * set (the caller gave a new one — intended), while an omitted one is inherited. A
 * brand-new hook (`existing` null) starts from `{}` and defaults `enabled: false`
 * (GG-3, safe-create). Returns an untrusted record for {@link sanitizeHook} to
 * validate (so it stays `Record<string, unknown>`, never a typed `PaddockHook`).
 *
 * `prompt` and `promptFile` are MUTUALLY EXCLUSIVE (the file wins at fire time), so
 * supplying one clears the inherited counterpart — otherwise switching a file-backed
 * hook to an inline prompt would leave the stale `promptFile` winning and silently
 * discard the edit. Supplying neither (a capability/enabled-only edit) leaves the
 * existing prompt source untouched.
 */
export function mergeHookUpdate(
  existing: PaddockHook | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing
    ? {
        event: existing.event,
        ...(existing.capabilities ? { capabilities: existing.capabilities } : {}),
        ...(existing.prompt !== undefined ? { prompt: existing.prompt } : {}),
        ...(existing.promptFile !== undefined ? { promptFile: existing.promptFile } : {}),
        enabled: existing.enabled === true,
      }
    : {};
  const record = { ...base, ...incoming };
  // Switching prompt source: one supplied side clears the inherited other, so the
  // record never ends up with both (which would let the stale file win at fire time).
  if (incoming.prompt !== undefined && incoming.promptFile === undefined) delete record.promptFile;
  if (incoming.promptFile !== undefined && incoming.prompt === undefined) delete record.prompt;
  if (record.enabled === undefined) record.enabled = false;
  return record;
}

/**
 * One tool a hook may be granted, for the capability picker (G4). `name` is the
 * literal `allowed_tools` pattern the hook agent is registered with; `group`
 * clusters them in the UI; `description` says precisely what granting it lets the
 * hook do. This is the same set of tools the keeper defaults grant (herdctl.ts
 * `defaults.allowed_tools`), so the picker never offers a tool the CLI runtime
 * would auto-deny — the capability the UI shows is the capability enforced.
 */
export interface GrantableTool {
  name: string;
  group: "read" | "write" | "web" | "orchestration" | "browser";
  description: string;
}

/**
 * The tools a hook can be granted, mirroring the keeper's default allowlist
 * (herdctl `defaults.allowed_tools`) so the picker is truthful. Grouped + described
 * for the G4 capability picker. `ToolSearch` is included because several of the
 * autonomy tools surface as deferred tools reached through it; the browser MCP is a
 * no-op unless the box enables Playwright (documented on {@link BROWSER_MCP_TOOL}).
 * The `mcp__playwright__*` pattern is offered verbatim so a hook that lists it gets
 * the browser tools auto-allowed exactly as the keeper does.
 */
export const GRANTABLE_TOOLS: readonly GrantableTool[] = [
  { name: "Read", group: "read", description: "Read a file from the project working dir." },
  { name: "Glob", group: "read", description: "Find files by glob pattern." },
  { name: "Grep", group: "read", description: "Search file contents (ripgrep)." },
  { name: "Edit", group: "write", description: "Edit an existing file in place." },
  { name: "Write", group: "write", description: "Create or overwrite a file — needed to author OVERVIEW/CHANGELOG etc." },
  { name: "NotebookEdit", group: "write", description: "Edit Jupyter notebook cells." },
  { name: "Bash", group: "write", description: "Run shell commands — spin down pm servers, delete clones, git, etc. The broadest grant." },
  { name: "WebFetch", group: "web", description: "Fetch and read a URL." },
  { name: "WebSearch", group: "web", description: "Search the web." },
  { name: "Task", group: "orchestration", description: "Spawn a sub-agent to do a scoped task." },
  { name: "TodoWrite", group: "orchestration", description: "Track a multi-step plan as a checklist." },
  { name: "Skill", group: "orchestration", description: "Invoke a packaged skill (code-review, deep-research, …)." },
  { name: "ToolSearch", group: "orchestration", description: "Load deferred tool schemas on demand." },
  { name: "ScheduleWakeup", group: "orchestration", description: "Schedule a follow-up wake (session drive-mode only)." },
  { name: "Monitor", group: "orchestration", description: "Watch a condition/background task and be re-invoked." },
  { name: "CronCreate", group: "orchestration", description: "Create a cron schedule (session drive-mode only)." },
  { name: "CronList", group: "orchestration", description: "List cron schedules." },
  { name: "CronDelete", group: "orchestration", description: "Delete a cron schedule." },
  { name: "mcp__playwright__*", group: "browser", description: "Drive a headless browser (navigate / click / snapshot). No-op unless the box enables Playwright." },
];

/** A hook name we're willing to key on (also a safe herdctl agent-name segment). */
export function isValidHookName(name: string): boolean {
  return typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name) && name.length <= 64;
}

/** Normalise an untrusted string[] of tool patterns, dropping non-strings/blanks. */
function sanitizeToolList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate + normalise one untrusted capability record. Never returns null (a hook
 * with no valid capabilities is simply tool-less); unknown fields are dropped.
 */
export function sanitizeCapabilities(raw: unknown): HookCapabilities | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: HookCapabilities = {};
  const allowed = sanitizeToolList(o.allowedTools);
  if (allowed) out.allowedTools = allowed;
  const denied = sanitizeToolList(o.deniedTools);
  if (denied) out.deniedTools = denied;
  if (typeof o.permissionMode === "string" && PERMISSION_MODES.has(o.permissionMode)) {
    out.permissionMode = o.permissionMode as HookPermissionMode;
  }
  if (typeof o.model === "string" && o.model.trim() !== "") out.model = o.model.trim();
  if (typeof o.maxTurns === "number" && Number.isFinite(o.maxTurns) && o.maxTurns > 0) {
    out.maxTurns = Math.floor(o.maxTurns);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate + normalise one untrusted hook record into a {@link PaddockHook}, or
 * `null` if it's malformed (unknown/absent event). A record with neither `prompt`
 * nor `promptFile` is still valid — it runs an empty prompt (the caller's business),
 * we don't drop it — but an unknown `event` is dropped so a typo can't silently
 * arm nothing OR (worse) take down the whole project's agent registration.
 */
export function sanitizeHook(raw: unknown): PaddockHook | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.event !== "string" || !HOOK_EVENTS.has(o.event as HookEvent)) return null;
  const out: PaddockHook = { event: o.event as HookEvent };
  const caps = sanitizeCapabilities(o.capabilities);
  if (caps) out.capabilities = caps;
  if (typeof o.prompt === "string") out.prompt = o.prompt;
  if (typeof o.promptFile === "string" && o.promptFile.trim() !== "") {
    out.promptFile = o.promptFile.trim();
  }
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  return out;
}

/**
 * Sanitise a whole `hooks` map, dropping malformed entries and entries with an
 * unsafe name. Returns `undefined` when nothing survives (so it stays absent on
 * disk / off the project record), exactly like {@link sanitizeHooks}' schedule twin.
 */
export function sanitizeHooks(raw: unknown): Record<string, PaddockHook> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, PaddockHook> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidHookName(name)) continue;
    const h = sanitizeHook(val);
    if (h) out[name] = h;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Project a hook's {@link HookCapabilities} onto the exact herdctl agent tool-config
 * fields (snake_case), so the registered `hook-<slug>-<name>` agent enforces the
 * capability BY CONSTRUCTION. A tool-less hook yields `allowed_tools: []` (the CLI
 * runtime then denies every tool). Always sets `allowed_tools` + `max_turns` so a
 * hook agent never silently inherits the keeper's broad default toolset; the other
 * fields are set only when the capability specifies them (else the fleet defaults
 * apply). This is the ONE place capability→config translation lives.
 */
export function hookToAgentToolConfig(caps: HookCapabilities | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {
    // A hook's grant is exactly its allowedTools — default to NONE (tool-less), never
    // the keeper's broad inherited allowlist. An empty list = the CLI runtime denies
    // all tools, which is the correct "no capability" semantics.
    allowed_tools: caps?.allowedTools ?? [],
    max_turns: caps?.maxTurns ?? HOOK_DEFAULT_MAX_TURNS,
  };
  if (caps?.deniedTools) out.denied_tools = caps.deniedTools;
  if (caps?.permissionMode) out.permission_mode = caps.permissionMode;
  if (caps?.model) out.model = caps.model;
  return out;
}
