/**
 * `paddock service logs [-f] [-n <lines>]` (SPEC §1, §7).
 *
 * One implementation for every platform, which is the whole reason the units
 * write to a file rather than to the journal: `journalctl --user -u paddock` on
 * Linux and a pair of files on macOS meant "where are the logs" had two
 * answers, neither of which Windows could ever have.
 *
 * Reading the tail of a file is deliberately done by hand rather than by
 * spawning `tail`: `tail -f` is not on every box this runs on (and is `Get-
 * Content -Wait` on the platform the contract requires us not to rule out),
 * and shelling out would make the output depend on which `tail` won a PATH
 * lookup.
 */
import fs from "node:fs";

/** How many lines `logs` prints when nobody says otherwise (SPEC §1). */
export const DEFAULT_LOG_LINES = 50;

/** How much of the end of the file to read for a tail, in bytes. */
const TAIL_WINDOW = 256 * 1024;

/** The gap between size checks when following. */
const FOLLOW_INTERVAL_MS = 400;

/**
 * The last `lines` lines of `file`.
 *
 * Only the last {@link TAIL_WINDOW} bytes are read. A service log is append-only
 * and can reach tens of megabytes between rotations, and reading all of it to
 * print fifty lines would make `logs` slower than the thing it is reporting on.
 * A window that happens to start mid-line drops that partial first line rather
 * than printing half of one.
 */
export function tailFile(file: string, lines: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_WINDOW);
    const length = size - start;
    if (length === 0) return "";
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    // A window that starts mid-line: drop the fragment.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const all = text.split("\n");
    // A trailing newline produces a final empty element that is not a line.
    if (all[all.length - 1] === "") all.pop();
    return all.slice(-lines).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

export interface FollowOptions {
  /** Where to start reading from — normally the file's size after the tail. */
  from: number;
  /** Injected for tests. */
  intervalMs?: number;
  /** Injected for tests: return false to stop the loop. */
  keepGoing?: () => boolean;
  write?: (s: string) => void;
}

/**
 * Print what gets appended to `file`, from `from` onwards, until the process is
 * interrupted.
 *
 * Polling rather than `fs.watch`: the writer here is the supervisor's own file
 * descriptor, and `fs.watch` on an appended-to file is unreliable across
 * platforms (no events at all on some network filesystems, and a stream of
 * them on others). A 400 ms poll of the size is both portable and cheap.
 *
 * Rotation is handled by the one case that can actually happen: the server
 * rotates by COPY-AND-TRUNCATE (see `service-log.ts`), so the inode is stable
 * and the size goes DOWN. Seeing that, this resets to the new start rather than
 * reading past the end forever, which is what a naive follower does — it goes
 * quiet after the first rotation and never recovers.
 */
export async function followFile(file: string, opts: FollowOptions): Promise<void> {
  const interval = opts.intervalMs ?? FOLLOW_INTERVAL_MS;
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const keepGoing = opts.keepGoing ?? ((): boolean => true);
  let offset = opts.from;

  while (keepGoing()) {
    await new Promise<void>((r) => setTimeout(r, interval));
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      // The file can vanish: an uninstall, or a rotation that renames. Wait for
      // it to come back rather than giving up — `logs -f` is left running.
      continue;
    }
    if (size < offset) {
      // Truncated: the rotation above, or a hand-run `: > service.log`.
      offset = 0;
    }
    if (size === offset) continue;
    const fd = fs.openSync(file, "r");
    try {
      const length = size - offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      write(buf.toString("utf8"));
      offset = size;
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** The file's size, or 0 if it is not there — where a follow should start. */
export function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
