/**
 * Unified trigger config helpers (Epic T "Unify Triggers", ticket T1 — foundation).
 *
 * A **trigger** collapses what were two separate config blocks — event **hooks**
 * (Epic G) and cron **schedules** (Epic D) — into ONE declarative shape over the
 * existing `startAgentTurn` execution core (design doc `DESIGN-unified-triggers.md`
 * §2). A trigger is **when** ({@link TriggerWhen}, a discriminated union on
 * `trigger.type`) + **what** ({@link TriggerRun}, a shared agent-run definition) +
 * top-level {@link PaddockTrigger.enabled}:
 *
 *   - `schedule` → `cron` **xor** `interval` (fired by herdctl's cron engine)
 *   - `event`    → a known `on` value (`onArchive` / `afterTurn`, fired by the bus)
 *   - `webhook`  → `path` — **shape reserved only**; NO ingress is wired in T1
 *     (that is the deferred T6/#311). It validates + persists so the config surface
 *     is frozen, but nothing fires it.
 *
 * This module is the small, PURE surface around that model — deliberately the same
 * shape as the shipped `hook-config.ts` / `schedule-config.ts` it subsumes, so the
 * `TriggerService` (foundation) and T2–T5 (schedule tool-scoping, verb collapse,
 * Triggers tab, sweeper fold-in) build against ONE frozen contract:
 *
 *  - {@link PaddockTriggerSchema} — the Zod **discriminated union** validating one
 *    trigger (`trigger.type` discriminant + the cron-xor-interval / prompt-xor-
 *    promptFile refinements). Zod (not a hand-rolled sanitizer like its hook/schedule
 *    ancestors) per the ticket, because the discriminant + xor rules read cleanly as
 *    one schema and give T3's REST layer structured errors — while the MAP-level
 *    {@link sanitizeTriggers} keeps the house "drop one malformed entry, don't brick
 *    the project" semantics its predecessors have.
 *  - {@link sanitizeTrigger} / {@link sanitizeTriggers} — validate an untrusted
 *    record / a hand-edited `project.yaml` `triggers` map.
 *  - {@link triggerToAgentToolConfig} — project a trigger's {@link TriggerRun} onto
 *    the herdctl agent tool-config fields (for an event/webhook trigger that runs as
 *    its OWN `trigger-<slug>-<name>` agent), so the grant is enforced by construction.
 *  - {@link triggersToHerdctlSchedules} — project schedule-type triggers onto the
 *    herdctl `ScheduleSchema` shape forwarded into the keeper agent's `schedules`
 *    block (so herdctl's cron engine arms them, exactly as legacy schedules are).
 *  - {@link triggerPromptFileAbsPath} — resolve a `promptFile` under the project's
 *    `.paddock/triggers/` dir, rejecting traversal / non-`.md`.
 */
import path from "node:path";
import { z } from "zod";

/** The trigger kinds. `webhook` is shape-reserved (no ingress in T1 — deferred T6). */
export type TriggerType = "schedule" | "event" | "webhook";

/**
 * The lifecycle events an `event`-type trigger may fire on. `onArchive` is wired
 * (fired after a chat-archive commits — the Epic G motivating cleanup). `afterTurn`
 * is a KNOWN value (validation accepts it) reserved for the sweeper fold-in (T5) —
 * it validates + persists now but isn't emitted until then, exactly as `webhook` is
 * shape-reserved. Adding a sibling event stays a ~3-line change (new value here + a
 * payload + one `emit()` at the commit site).
 */
export const TRIGGER_EVENTS = ["onArchive", "afterTurn"] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/** New-vs-accrete for a fired trigger (design §2.3). */
export type TriggerSession = "new" | "resume";

/** Claude Code permission mode a trigger agent's turns run under. */
export type TriggerPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;

/** The dir (relative to a project's working dir) holding keeper-editable prompts. */
export const TRIGGER_PROMPT_DIR = path.join(".paddock", "triggers");

/** Default max agent turns for a trigger when its run doesn't set one. */
export const TRIGGER_DEFAULT_MAX_TURNS = 30;

// --- Zod schema (the frozen discriminated union) -------------------------------

/**
 * The `schedule` variant — `cron` xor `interval`. The xor can't live inside the
 * discriminatedUnion member (Zod requires plain object members), so the cron-xor-
 * interval rule is enforced by {@link PaddockTriggerSchema}'s `superRefine`; here we
 * only shape/trim the two optional timer fields.
 */
const scheduleWhenSchema = z.object({
  type: z.literal("schedule"),
  cron: z.string().trim().min(1).optional(),
  interval: z.string().trim().min(1).optional(),
});

/** The `event` variant — a KNOWN `on` value (an unknown one fails validation). */
const eventWhenSchema = z.object({
  type: z.literal("event"),
  on: z.enum(TRIGGER_EVENTS),
});

/** The `webhook` variant — shape reserved (a `path`); no ingress is wired in T1. */
const webhookWhenSchema = z.object({
  type: z.literal("webhook"),
  path: z.string().trim().min(1),
});

/** The discriminated union on `trigger.type` — the heart of the unified model. */
const triggerWhenSchema = z.discriminatedUnion("type", [
  scheduleWhenSchema,
  eventWhenSchema,
  webhookWhenSchema,
]);

/**
 * The shared agent-run definition (design §2.3) — WHAT a fired trigger does,
 * identical across every trigger type. `tools` is a deny-by-default allow-list (the
 * trigger's capability; `[]` = a tool-less curator); `session` selects new-vs-accrete;
 * the rest mirror the per-agent overrides hooks already carry.
 */
const runSchema = z.object({
  /** Inline prompt (mutually exclusive with {@link promptFile} — enforced below). */
  prompt: z.string().optional(),
  /** Git-tracked `.paddock/triggers/*.md` prompt file, read fresh at fire time. */
  promptFile: z.string().trim().min(1).optional(),
  /** `new` = a fresh chat each fire; `resume` = one owned accreting session. */
  session: z.enum(["new", "resume"]).default("new"),
  /** Optional per-trigger model override (else the keeper default applies). */
  model: z.string().trim().min(1).optional(),
  /** Deny-by-default allow-list = the trigger's capability. `[]` = tool-less. */
  tools: z.array(z.string().trim().min(1)).default([]),
  /** Recursion bound for internal spawning (reuses B1); 0 = may not spawn. */
  maxSpawnDepth: z.number().int().nonnegative().optional(),
  /** Optional permission mode (else inherits the project-agent default). */
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  /** Optional max-turns cap (else {@link TRIGGER_DEFAULT_MAX_TURNS}). */
  maxTurns: z.number().int().positive().optional(),
});

/**
 * The frozen trigger schema: `trigger` (discriminated union) + `run` + `enabled`.
 * Two cross-field refinements the discriminatedUnion can't express inline:
 *  - a `schedule` trigger requires EXACTLY ONE of `cron` / `interval`;
 *  - `run` requires EXACTLY ONE of `prompt` / `promptFile`.
 *
 * `enabled` **defaults `false`** — a trigger created programmatically (or via a
 * hand-edit that omits it) is inert until deliberately switched on (design §2.3,
 * mirroring the Epic G safe-create default).
 */
export const PaddockTriggerSchema = z
  .object({
    trigger: triggerWhenSchema,
    run: runSchema,
    enabled: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.trigger.type === "schedule") {
      const hasCron = val.trigger.cron !== undefined;
      const hasInterval = val.trigger.interval !== undefined;
      // XOR: both or neither is invalid.
      if (hasCron === hasInterval) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trigger"],
          message: "a schedule trigger requires exactly one of `cron` or `interval`",
        });
      }
    }
    const hasPrompt = val.run.prompt !== undefined;
    const hasFile = val.run.promptFile !== undefined;
    // XOR: exactly one of an inline prompt or a prompt file.
    if (hasPrompt === hasFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run"],
        message: "`run` requires exactly one of `prompt` or `promptFile`",
      });
    }
  });

/** A validated trigger — the persisted per-project record (`project.yaml` `triggers`). */
export type PaddockTrigger = z.infer<typeof PaddockTriggerSchema>;

/** The `when` discriminated union, on its own (WHEN a trigger fires). */
export type TriggerWhen = PaddockTrigger["trigger"];
/** The `schedule` variant of {@link TriggerWhen}. */
export type ScheduleTriggerWhen = Extract<TriggerWhen, { type: "schedule" }>;
/** The `event` variant of {@link TriggerWhen}. */
export type EventTriggerWhen = Extract<TriggerWhen, { type: "event" }>;
/** The `webhook` variant of {@link TriggerWhen}. */
export type WebhookTriggerWhen = Extract<TriggerWhen, { type: "webhook" }>;
/** The shared agent-run definition (WHAT a fired trigger does). */
export type TriggerRun = PaddockTrigger["run"];

/**
 * The CRUD/DTO shape the trigger service ({@link import("./triggers.js").TriggerService})
 * returns — a {@link PaddockTrigger} plus its map key `name` and the deterministic
 * herdctl agent it registers as (`trigger-<slug>-<name>`). This is the frozen contract
 * T2–T5 build against (the analogue of the shipped `HookDto`).
 */
export type TriggerDto = PaddockTrigger & {
  /** The trigger's name — the `project.yaml` map key + the `<name>` in its agent name. */
  name: string;
  /** The herdctl agent this trigger registers as (`trigger-<slug>-<name>`). */
  agentName: string;
};

// --- validation ---------------------------------------------------------------

/** A trigger name we're willing to key on (also a safe herdctl agent-name segment). */
export function isValidTriggerName(name: string): boolean {
  return typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name) && name.length <= 64;
}

/**
 * Validate + normalise one untrusted trigger record into a {@link PaddockTrigger},
 * or `null` if it's malformed (bad discriminant, both/neither cron+interval, unknown
 * `on`, both/neither prompt+promptFile, …). Defaults are applied (`enabled: false`,
 * `session: "new"`, `tools: []`). Unknown fields are stripped (Zod default).
 */
export function sanitizeTrigger(raw: unknown): PaddockTrigger | null {
  const result = PaddockTriggerSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Sanitise a whole `triggers` map, DROPPING malformed entries and entries with an
 * unsafe name — so one bad hand-edit can't brick the project's agent registration
 * (an invalid trigger agent config would throw in `addAgent`). Returns `undefined`
 * when nothing survives (so it stays absent on disk / off the project record),
 * exactly like its `sanitizeHooks` / `sanitizeSchedules` ancestors.
 */
export function sanitizeTriggers(raw: unknown): Record<string, PaddockTrigger> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, PaddockTrigger> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidTriggerName(name)) continue;
    const t = sanitizeTrigger(val);
    if (t) out[name] = t;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- projection helpers -------------------------------------------------------

/**
 * Whether a trigger runs on its OWN scoped `trigger-<slug>-<name>` agent (so
 * {@link triggerToAgentToolConfig} governs its capability) rather than as the keeper.
 *
 *  - **event** → ALWAYS its own agent (Epic G / T1). Its `tools` allow-list IS the
 *    capability; an empty `[]` means a deliberately tool-less curator.
 *  - **schedule** → its own scoped agent ONLY when it declares a NON-EMPTY `run.tools`
 *    allow-list (T2 — the per-trigger tool-scoping this ticket adds). A schedule with NO
 *    tools inherits the project agent's default toolset by running as the keeper,
 *    preserving the pre-T2 behaviour (ticket #307: "a schedule with no tools inherits
 *    the project-agent default"). This is the one asymmetry with events — a schedule's
 *    empty `tools` reads as "unscoped, run as keeper", NOT "tool-less curator", because
 *    schedules historically ran with the keeper's full tools and there are no users to
 *    migrate off that default.
 *  - **webhook** → reserved (never fired in T1), so it registers no agent.
 *
 * The ONE place the keeper-vs-own-agent routing decision lives, shared by the herdctl
 * agent registration ({@link import("./herdctl.js").HerdctlService.registerTriggerAgents})
 * and the fire path (`fireTriggerForProject` in `ws.ts`) so arming and firing always agree.
 */
export function triggerRunsOnOwnAgent(trigger: PaddockTrigger): boolean {
  if (trigger.trigger.type === "event") return true;
  if (trigger.trigger.type === "schedule") return (trigger.run.tools?.length ?? 0) > 0;
  return false; // webhook: shape reserved, nothing fires it.
}

/**
 * Project a trigger's {@link TriggerRun} onto the exact herdctl agent tool-config
 * fields (snake_case), so an event/webhook trigger's OWN `trigger-<slug>-<name>`
 * agent enforces the capability BY CONSTRUCTION. Always sets `allowed_tools` +
 * `max_turns` so a trigger agent never silently inherits the keeper's broad default
 * toolset; a tool-less trigger yields `allowed_tools: []` (the CLI runtime then
 * denies every tool). The ONE place run→agent-config translation lives. (The exact
 * analogue of `hookToAgentToolConfig`.)
 */
export function triggerToAgentToolConfig(run: TriggerRun): Record<string, unknown> {
  const out: Record<string, unknown> = {
    allowed_tools: run.tools ?? [],
    max_turns: run.maxTurns ?? TRIGGER_DEFAULT_MAX_TURNS,
  };
  if (run.permissionMode) out.permission_mode = run.permissionMode;
  if (run.model) out.model = run.model;
  return out;
}

/**
 * Project ONE schedule-type trigger onto the herdctl `ScheduleSchema` fields the
 * cron engine reads (`type` `cron`|`interval`, the timer field, `resume_session`,
 * `enabled`), for forwarding into the keeper agent's `schedules` block. The
 * Paddock-only prompt (inline/`promptFile`) is resolved at fire time by the trigger
 * handler, so herdctl only ever sees a plain `prompt` (or none) — kept pure. The
 * `resume_session` flag is derived from `run.session` so herdctl's own new-vs-accrete
 * stays in agreement with Paddock's (the handler still owns the OWNED-session sidecar).
 */
export function scheduleTriggerToHerdctl(
  when: ScheduleTriggerWhen,
  run: TriggerRun,
  enabled: boolean,
): Record<string, unknown> {
  const isCron = when.cron !== undefined;
  const out: Record<string, unknown> = { type: isCron ? "cron" : "interval" };
  if (isCron) out.cron = when.cron;
  else out.interval = when.interval;
  // Forward the inline prompt only when a promptFile isn't driving the trigger (the
  // handler reads the file fresh at fire time and supplies the resolved text).
  if (typeof run.prompt === "string" && run.promptFile === undefined) out.prompt = run.prompt;
  out.resume_session = run.session === "resume";
  // Forward the Paddock-level enabled flag so herdctl's engine doesn't even fire a
  // disabled schedule trigger (the handler double-checks too — belt and braces).
  out.enabled = enabled;
  return out;
}

/**
 * Build the `schedules` block to forward into the keeper agent config from a
 * project's SCHEDULE-type triggers, or `undefined` when it declares none. Non-schedule
 * triggers (event/webhook) are skipped — they don't arm the cron engine. Keyed by
 * trigger name (the same key the fire handler resolves back to a trigger).
 */
export function triggersToHerdctlSchedules(
  map: Record<string, PaddockTrigger> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!map) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, t] of Object.entries(map)) {
    if (t.trigger.type !== "schedule") continue;
    out[name] = scheduleTriggerToHerdctl(t.trigger, t.run, t.enabled === true);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve a `promptFile` to an absolute path under the project's `.paddock/triggers/`
 * dir, or `null` if it escapes that dir, is absolute, or isn't a `.md` file. The name
 * is treated as relative to the triggers dir (so a bare `"daily.md"` resolves to
 * `<workingDir>/.paddock/triggers/daily.md`). Byte-for-byte the hook/schedule twin's guard.
 */
export function triggerPromptFileAbsPath(workingDir: string, promptFile: string): string | null {
  if (typeof promptFile !== "string" || promptFile.trim() === "") return null;
  const rel = promptFile.trim();
  if (path.isAbsolute(rel)) return null;
  const base = path.resolve(workingDir, TRIGGER_PROMPT_DIR);
  const target = path.resolve(base, rel);
  const within = target === base || target.startsWith(base + path.sep);
  if (!within) return null;
  if (!target.toLowerCase().endsWith(".md")) return null;
  return target;
}
