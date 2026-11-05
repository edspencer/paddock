// From edspencer/cli-contract reference/runtime-file.ts @ SPEC 0.1; local changes: `node:fs` / `node:path` imports
// unchanged, nothing else — the module is Node built-ins only and Paddock's `<home>` is its data dir, so it needed
// no adaptation. Kept verbatim on purpose: wave C4 re-syncs it, and a divergence here would be a divergence in the
// one file every tool's `busy`, `service status` and `update` agree on.
//
// `<home>/runtime.json`: what a running instance tells its own CLI (SPEC §4, ROADMAP). `serve` writes it once it's
// listening and removes it on a clean exit; `busy`, `service status` and `update` read it to find the instance.
//
// It holds `{ pid, port, url, version, startedAt }`. A token for /api/busy will join it once SPEC §10's first question
// is settled; the file is written 0600 already, so adding one later changes nothing about who can read it.
// Node built-ins only.

import fs from "node:fs";
import path from "node:path";

export interface RuntimeInfo {
  pid: number;
  port: number;
  /** Where the CLI reaches it, e.g. `http://127.0.0.1:3729`. */
  url: string;
  version: string;
  /** ISO 8601. */
  startedAt: string;
}

export const RUNTIME_FILE = "runtime.json";

export function runtimeFilePath(home: string): string {
  return path.join(home, RUNTIME_FILE);
}

/** Writes the file atomically (a temporary file, then a rename), readable only by this user. */
export function writeRuntimeFile(
  home: string,
  info: Omit<RuntimeInfo, "startedAt"> & { startedAt?: string },
): RuntimeInfo {
  const full: RuntimeInfo = {
    pid: info.pid,
    port: info.port,
    url: info.url,
    version: info.version,
    startedAt: info.startedAt ?? new Date().toISOString(),
  };
  fs.mkdirSync(home, { recursive: true });
  const file = runtimeFilePath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return full;
}

/** The file's contents, or null if it's missing or isn't a runtime file (a half-written or foreign file). */
export function readRuntimeFile(home: string): RuntimeInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(runtimeFilePath(home), "utf8");
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<RuntimeInfo>;
    if (
      Number.isInteger(v.pid) &&
      Number.isInteger(v.port) &&
      typeof v.url === "string" &&
      typeof v.version === "string" &&
      typeof v.startedAt === "string"
    ) {
      return v as RuntimeInfo;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Removes the file, but only if it's still ours: a second instance may have started since and written its own.
 * Call it on a clean exit. Returns whether it removed anything.
 */
export function removeRuntimeFile(home: string, pid: number = process.pid): boolean {
  const info = readRuntimeFile(home);
  if (!info || info.pid !== pid) return false;
  fs.rmSync(runtimeFilePath(home), { force: true });
  return true;
}

/** Whether a process with this pid exists. EPERM means it exists but isn't ours, which still counts. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The runtime file, if the process it names is still alive. A crashed instance leaves a stale file behind. */
export function readLiveRuntimeFile(home: string): RuntimeInfo | null {
  const info = readRuntimeFile(home);
  return info && isPidAlive(info.pid) ? info : null;
}
