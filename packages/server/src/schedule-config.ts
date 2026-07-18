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
 *  - {@link schedulesToHerdctl} — project the Paddock records onto the exact fields
 *    herdctl accepts, STRIPPING the Paddock-only `promptFile` so the forwarded
 *    config stays pure (herdctl only ever sees a plain `prompt`).
 *  - {@link schedulePromptFileAbsPath} — resolve a `promptFile` to an absolute path
 *    under the project's `.paddock/schedules/` dir, rejecting traversal / non-`.md`.
 *
 * Keeping this off `projects.ts`/`herdctl.ts` makes each piece unit-testable in
 * isolation and keeps the pass-through contract in one obvious place.
 */
import path from "node:path";

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

/** The dir (relative to a project's working dir) holding keeper-editable prompts. */
export const SCHEDULE_PROMPT_DIR = path.join(".paddock", "schedules");

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

/**
 * Project one {@link PaddockSchedule} onto the exact fields herdctl's
 * `ScheduleSchema` accepts, STRIPPING the Paddock-only `promptFile` (resolved at
 * fire time by the host handler, so herdctl only ever sees a plain `prompt`).
 */
export function scheduleToHerdctl(s: PaddockSchedule): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type };
  if (s.type === "cron" && s.cron) out.cron = s.cron;
  if (s.type === "interval" && s.interval) out.interval = s.interval;
  // Forward the inline prompt verbatim when present; when a promptFile drives the
  // schedule we omit prompt entirely — the host handler supplies the resolved text,
  // and leaving it out keeps the forwarded herdctl config pure.
  if (typeof s.prompt === "string") out.prompt = s.prompt;
  if (typeof s.enabled === "boolean") out.enabled = s.enabled;
  if (typeof s.resume_session === "boolean") out.resume_session = s.resume_session;
  return out;
}

/**
 * Build the `schedules` block to forward into the keeper agent config, or
 * `undefined` when the project declares none. Each entry is the pure herdctl shape
 * (see {@link scheduleToHerdctl}).
 */
export function schedulesToHerdctl(
  map: Record<string, PaddockSchedule> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!map) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, s] of Object.entries(map)) out[name] = scheduleToHerdctl(s);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve a `promptFile` to an absolute path under the project's
 * `.paddock/schedules/` dir, or `null` if it escapes that dir, is absolute, or
 * isn't a `.md` file. The name is treated as relative to the schedules dir (so a
 * bare `"daily.md"` resolves to `<workingDir>/.paddock/schedules/daily.md`).
 */
export function schedulePromptFileAbsPath(
  workingDir: string,
  promptFile: string,
): string | null {
  if (typeof promptFile !== "string" || promptFile.trim() === "") return null;
  const rel = promptFile.trim();
  if (path.isAbsolute(rel)) return null;
  const base = path.resolve(workingDir, SCHEDULE_PROMPT_DIR);
  const target = path.resolve(base, rel);
  const within = target === base || target.startsWith(base + path.sep);
  if (!within) return null;
  if (!target.toLowerCase().endsWith(".md")) return null;
  return target;
}
