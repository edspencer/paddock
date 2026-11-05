/**
 * `<home>/update.lock` — one update at a time (CLI contract SPEC §5 step 1).
 *
 * Two concurrent updates is not a theoretical race. The second one stops the
 * service the first just started, or installs an older target over a newer one,
 * and the loser's rollback then "restores" a version nobody asked for. It is
 * also easy to cause: an Ansible run and a person at a terminal, or a scheduler
 * firing twice.
 *
 * So: `O_EXCL` create, holding the pid. A lock whose pid is alive refuses with
 * exit 1. A lock whose pid is gone — a crashed or killed update — is stale and
 * is removed, because the alternative is an install that can never update
 * itself again without someone finding out about a file they have never heard
 * of.
 *
 * Generic: wave C4 lifts this into `reference/lock.ts`. Node built-ins only.
 */
import fs from "node:fs";
import path from "node:path";

export const LOCK_FILE = "update.lock";

export function lockPath(home: string): string {
  return path.join(home, LOCK_FILE);
}

export interface LockBody {
  pid: number;
  startedAt: string;
  /** What is holding it, for the message: `paddock update --to 0.81.0`. */
  command?: string;
}

export interface Lock {
  path: string;
  /** Remove the file, but only if it is still ours. Safe to call twice. */
  release(): void;
}

/** The lock is held by a live process. Carries its pid so the caller can say so. */
export class LockHeldError extends Error {
  readonly holder: LockBody;
  readonly path: string;
  constructor(file: string, holder: LockBody) {
    super(
      `another update is already running (pid ${holder.pid}, started ${holder.startedAt})\n` +
        `         If that is wrong, remove ${file} and try again.`,
    );
    this.holder = holder;
    this.path = file;
  }
}

export interface AcquireOptions {
  home: string;
  pid?: number;
  command?: string;
  /** Injected so a stale lock can be tested without spawning a process to kill. */
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

/**
 * Take the lock, or throw {@link LockHeldError}.
 *
 * The retry is deliberately ONCE. After removing a stale lock the create is
 * attempted again, and a second `EEXIST` means another process won the same
 * race in that microsecond — which is a genuine holder, not a stale file, so it
 * refuses. Looping instead would be a way to spin forever against a lock being
 * recreated as fast as it is deleted.
 */
export function acquireLock(o: AcquireOptions): Lock {
  const file = lockPath(o.home);
  const pid = o.pid ?? process.pid;
  const isAlive = o.isAlive ?? defaultIsAlive;
  const body: LockBody = {
    pid,
    startedAt: (o.now ?? (() => new Date()))().toISOString(),
    ...(o.command !== undefined ? { command: o.command } : {}),
  };
  fs.mkdirSync(o.home, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' is O_CREAT|O_EXCL|O_WRONLY: the create is the lock, in one
      // syscall, so there is no window between "is it there?" and "make it".
      fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { path: file, release: () => releaseLock(file, pid) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(file);
      // An unreadable or pid-less lock file counts as stale: it is either
      // half-written or from a version that wrote something else, and either
      // way nobody can prove a process is holding it.
      if (holder !== null && isAlive(holder.pid) && holder.pid !== pid) {
        throw new LockHeldError(file, holder);
      }
      if (attempt === 1) {
        throw new LockHeldError(file, holder ?? { pid: 0, startedAt: "unknown" });
      }
      fs.rmSync(file, { force: true });
    }
  }
  // Unreachable: both branches of the loop above either return or throw.
  throw new LockHeldError(file, { pid: 0, startedAt: "unknown" });
}

export function readLock(file: string): LockBody | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockBody>;
    if (Number.isInteger(raw.pid) && typeof raw.startedAt === "string") return raw as LockBody;
  } catch {
    /* missing, half-written, or not ours */
  }
  return null;
}

/** Remove the lock only when it still names `pid`: never delete somebody else's. */
export function releaseLock(file: string, pid: number): void {
  const holder = readLock(file);
  if (holder === null || holder.pid === pid) fs.rmSync(file, { force: true });
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and is not ours, which still counts.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
