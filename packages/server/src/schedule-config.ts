/**
 * Scheduled-chat config helpers (issue #265 / DD-2).
 *
 * A Paddock schedule IS herdctl's `ScheduleSchema` shape, passed through the stack
 * **unmolested** — the same field names herdctl's cron engine already reads, so a
 * `schedules` block on the keeper agent config is armed with no translation. This
 * module holds the small, pure surface around that pass-through:
 *
 *  - {@link sanitizeSchedules} — validate/normalise a hand-edited `project.yaml`
 *    `schedules` map, DROPPING malformed entries so one bad edit can't brick the
 *    keeper's `addAgent` registration (which would throw on an invalid schedule).
 *
 * The `schedules` block itself is now declared only via unified TRIGGERS
 * (trigger-config.ts forwards SCHEDULE-type triggers into the keeper agent); this
 * module retains only the back-compat parser for any legacy `schedules:` block still
 * present in a hand-edited `project.yaml`.
 */

/**
 * A scheduled chat declaration — herdctl's `ScheduleSchema` shape (same field
 * names) plus the Paddock-only {@link PaddockSchedule.promptFile}. v1 arms the two
 * timer types (`cron` / `interval`); herdctl's schema also defines `webhook` /
 * `chat`, left out here since Paddock only schedules timers.
 */
export interface PaddockSchedule {
  /** `cron` (5-field/`@daily` expression) or `interval` (e.g. `"30m"`, `"1h"`). */
  type: "cron" | "interval";
  /** The cron expression — required when `type: cron`. */
  cron?: string;
  /** The interval string (e.g. `"15m"`) — required when `type: interval`. */
  interval?: string;
  /**
   * The inline prompt the scheduled turn runs. A schedule may instead point at a
   * {@link promptFile}, which Paddock resolves to a prompt at fire time (so herdctl
   * only ever receives a plain `prompt`). When both are set the file wins.
   */
  prompt?: string;
  /** Whether the schedule is armed. Defaults true (herdctl's default). */
  enabled?: boolean;
  /**
   * New-vs-accrete (DD-2). `false` (default) → a FRESH chat every fire; `true` →
   * resume the schedule's ONE owned session (created on first fire, reused after),
   * so a "manager" accretes one transcript.
   */
  resume_session?: boolean;
  /**
   * PADDOCK-ONLY convenience (DD-2): a git-tracked, keeper-editable prompt file
   * under the project's `.paddock/schedules/` dir (e.g. `"daily-manager.md"`),
   * relative to that dir. Read at fire time and forwarded as the schedule's
   * `prompt`. NEVER forwarded into the herdctl config (kept pure). Traversal
   * outside `.paddock/schedules/` and non-`.md` names are rejected.
   */
  promptFile?: string;
}

const SCHEDULE_TYPES: ReadonlySet<string> = new Set(["cron", "interval"]);

/** A schedule name we're willing to key on (also a safe herdctl schedule key). */
export function isValidScheduleName(name: string): boolean {
  return typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name) && name.length <= 64;
}

/**
 * Validate + normalise one untrusted schedule record into a {@link PaddockSchedule},
 * or `null` if it's malformed. A `cron` schedule MUST carry a `cron`; an `interval`
 * one MUST carry an `interval` (herdctl would reject a type/field mismatch, so we
 * drop it here rather than let `addAgent` throw and take the whole keeper down).
 */
export function sanitizeSchedule(raw: unknown): PaddockSchedule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== "string" || !SCHEDULE_TYPES.has(type)) return null;
  const out: PaddockSchedule = { type: type as PaddockSchedule["type"] };
  if (type === "cron") {
    if (typeof o.cron !== "string" || o.cron.trim() === "") return null;
    out.cron = o.cron.trim();
  } else {
    if (typeof o.interval !== "string" || o.interval.trim() === "") return null;
    out.interval = o.interval.trim();
  }
  if (typeof o.prompt === "string") out.prompt = o.prompt;
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (typeof o.resume_session === "boolean") out.resume_session = o.resume_session;
  if (typeof o.promptFile === "string" && o.promptFile.trim() !== "") {
    out.promptFile = o.promptFile.trim();
  }
  return out;
}

/**
 * Sanitise a whole `schedules` map, dropping malformed entries and entries with an
 * unsafe name. Returns `undefined` when nothing survives (so it stays absent on
 * disk / off the agent config).
 */
export function sanitizeSchedules(raw: unknown): Record<string, PaddockSchedule> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, PaddockSchedule> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidScheduleName(name)) continue;
    const s = sanitizeSchedule(val);
    if (s) out[name] = s;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}


