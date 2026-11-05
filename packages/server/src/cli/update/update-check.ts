/**
 * `<home>/update-check.json` — what the last registry question found
 * (CLI contract SPEC §3).
 *
 * The contract's rule is that **nothing contacts the registry by itself**: only
 * `update`, `update --check` and `doctor` ask, and only when a person runs
 * them. But `service status` should still be able to mention a newer version,
 * because that is where someone looks. The cache is how both hold: the three
 * commands that ask write what they found here, and `status` reads the file and
 * never opens a socket.
 *
 * The document is the one `schemas/update-check.schema.json` describes, so
 * `update --check --json` and this file are the same shape — one less thing to
 * keep in step, and `status --json`'s `update` object is a projection of it.
 *
 * Generic: wave C4 lifts this into `reference/`. Node built-ins only.
 */
import fs from "node:fs";
import path from "node:path";
import type { InstallMethod } from "./install-method.js";

export const UPDATE_CHECK_FILE = "update-check.json";

export function updateCheckPath(home: string): string {
  return path.join(home, UPDATE_CHECK_FILE);
}

/** `update --check --json`, and the cached copy. Matches `schemas/update-check.schema.json`. */
export interface UpdateCheck {
  name: string;
  current: string;
  target: string;
  /** The dist-tag asked for, or null when `--to` named a version. */
  tag: string | null;
  updateAvailable: boolean;
  installMethod: InstallMethod;
  canUpdate: boolean;
  /** `<tool> update`, or the command this install needs instead. */
  command: string | null;
  engines: string | null;
  nodeOk: boolean;
  changelog: string | null;
  /** ISO 8601. */
  checkedAt: string;
}

/** What `service status --json` carries (`schemas/service-status.schema.json`). */
export interface UpdateSummary {
  latest: string;
  updateAvailable: boolean;
  checkedAt: string;
}

/**
 * Write the cache atomically.
 *
 * Atomic because `service status` reads it on a path where a torn read has no
 * recovery worth having — it would report `updateAvailable` as absent and say
 * nothing, which is indistinguishable from "never checked". Best-effort:
 * failing to write a cache must never fail an update, so this throws nothing.
 */
export function writeUpdateCheck(home: string, check: UpdateCheck): void {
  try {
    fs.mkdirSync(home, { recursive: true });
    const file = updateCheckPath(home);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(check, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  } catch {
    /* a cache that could not be written is not a failed update */
  }
}

/** The cache, or null when there isn't one (or it isn't one). */
export function readUpdateCheck(home: string): UpdateCheck | null {
  try {
    const raw = JSON.parse(fs.readFileSync(updateCheckPath(home), "utf8")) as Partial<UpdateCheck>;
    if (
      typeof raw.name === "string" &&
      typeof raw.current === "string" &&
      typeof raw.target === "string" &&
      typeof raw.updateAvailable === "boolean" &&
      typeof raw.checkedAt === "string"
    ) {
      return raw as UpdateCheck;
    }
  } catch {
    /* missing, half-written, or from something else */
  }
  return null;
}

/**
 * How long a cached answer is worth repeating.
 *
 * `status` says "0.81.0 is available" on the strength of a file, so the file
 * has to be recent enough that the claim is still likely true. A week is long
 * enough to cover "I checked on Monday, it is Friday" and short enough that a
 * months-old file does not have `status` advertising a version that has since
 * been superseded twice.
 */
export const UPDATE_CHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The summary `service status` shows, or undefined when there is nothing worth
 * repeating: no cache, a cache from a different install, or one too old.
 */
export function updateSummary(
  home: string,
  o: { now?: number; maxAgeMs?: number } = {},
): UpdateSummary | undefined {
  const check = readUpdateCheck(home);
  if (check === null) return undefined;
  const at = Date.parse(check.checkedAt);
  if (!Number.isFinite(at)) return undefined;
  const age = (o.now ?? Date.now()) - at;
  if (age > (o.maxAgeMs ?? UPDATE_CHECK_MAX_AGE_MS)) return undefined;
  return {
    latest: check.target,
    updateAvailable: check.updateAvailable,
    checkedAt: check.checkedAt,
  };
}

export interface NoticeInput {
  name: string;
  current: string;
  target: string;
  /** `paddock update`, or the command this install needs instead (SPEC §3, §6). */
  command: string;
  /** The parenthetical after the command: `the global folder isn't writable`. */
  note?: string;
  changelog?: string | null;
}

/**
 * SPEC §3's update notice, verbatim in shape:
 *
 * ```
 * Paddock 0.80.0 is available (you have 0.79.1).
 *   Run: paddock update
 *   Changes: https://github.com/edspencer/paddock/releases/tag/v0.80.0
 * ```
 *
 * Returned as a string rather than printed, because the caller decides the
 * stream: §3 puts this on **stderr**, always, so that a `--json` document on
 * stdout stays the only thing on stdout.
 */
export function updateNotice(o: NoticeInput): string {
  const lines = [`${o.name} ${o.target} is available (you have ${o.current}).`];
  lines.push(`  Run: ${o.command}${o.note !== undefined ? `    (${o.note})` : ""}`);
  if (o.changelog !== undefined && o.changelog !== null) lines.push(`  Changes: ${o.changelog}`);
  return lines.join("\n");
}
