/**
 * Rotating the service log (SPEC §7: "the tool rotates its own log").
 *
 * The service's stdout and stderr are appended to `<dataDir>/logs/service.log`
 * by the supervisor itself — launchd's `StandardOutPath`, systemd's
 * `StandardOutput=append:`. Nothing else rotates it: a `systemd --user` unit
 * gets no journal rotation because it is not using the journal, and macOS has
 * never had anything that would. Left alone, an instance that has been up for
 * months has a log file nobody can open.
 *
 * ## Why copy-and-truncate, and not rename
 *
 * The usual rotation is `rename(log, log.1)` then create a new `log`. That is
 * exactly wrong here, because **we are not the writer**. The supervisor holds
 * an open append-mode descriptor on the inode; renaming the path does not move
 * the descriptor, so every subsequent line goes to `service.log.1` and the
 * fresh `service.log` stays empty for ever. `logrotate`'s `copytruncate` exists
 * for this case and this is it: copy the bytes out, then `truncate()` the
 * original to zero. The descriptor's next write — `O_APPEND`, so the offset is
 * re-derived from the file length — lands at 0.
 *
 * The cost is honest and small: a line written between the copy and the
 * truncate is lost. The alternative costs every line after the first rotation.
 *
 * ## When it runs
 *
 * At boot, and then on an interval. Not on every write, because the writes do
 * not come through this process's own logger — they come through a file
 * descriptor the supervisor opened — so there is no write to hook. The timer is
 * `unref`'d: a rotation pending must never be the reason the process will not
 * exit.
 *
 * It is a no-op anywhere there is no service log, which is every foreground
 * `paddock serve`: the file does not exist, so nothing is copied and nothing is
 * truncated. No caller has to know whether it is running under a supervisor.
 */
import fs from "node:fs";
import path from "node:path";

/** Rotate once the log passes this. */
export const ROTATE_AT_BYTES = 8 * 1024 * 1024;

/** How many rotated generations to keep (`service.log.1` … `.3`). */
export const KEEP_GENERATIONS = 3;

/** How often to look. */
export const ROTATE_CHECK_MS = 15 * 60 * 1000;

export interface RotateOptions {
  maxBytes?: number;
  keep?: number;
  /** Where a warning goes. Failing to rotate is never fatal. */
  warn?: (message: string) => void;
}

/** `<dataDir>/logs/service.log` — the one file both streams append to. */
export function serviceLogFile(dataDir: string): string {
  return path.join(dataDir, "logs", "service.log");
}

/**
 * Rotate `<dataDir>/logs/service.log` if it has grown past the limit.
 *
 * Returns true if it rotated. Never throws: a log directory that has become
 * read-only is worth a warning, not a server that will not start.
 */
export function rotateServiceLog(dataDir: string, opts: RotateOptions = {}): boolean {
  const maxBytes = opts.maxBytes ?? ROTATE_AT_BYTES;
  const keep = opts.keep ?? KEEP_GENERATIONS;
  const file = serviceLogFile(dataDir);

  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return false;
  } catch {
    // No log file: a foreground run, or a service that has not written yet.
    return false;
  }

  try {
    // Shuffle the generations down, oldest first, so nothing is overwritten
    // before it has been moved. The oldest is dropped.
    const gen = (n: number): string => `${file}.${String(n)}`;
    fs.rmSync(gen(keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) {
      if (fs.existsSync(gen(n))) fs.renameSync(gen(n), gen(n + 1));
    }
    fs.copyFileSync(file, gen(1));
    // The truncate, not an unlink: see the header. The supervisor's descriptor
    // has to keep working, and it only does if the inode survives.
    fs.truncateSync(file, 0);
    return true;
  } catch (err) {
    opts.warn?.(`could not rotate ${file}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Rotate now, then every {@link ROTATE_CHECK_MS}. Returns a stop function.
 *
 * The timer is unref'd, so this cannot hold the process open — which matters
 * because the one thing worse than an unrotated log is a `paddock serve` that
 * does not exit on Ctrl-C.
 */
export function startServiceLogRotation(
  dataDir: string,
  opts: RotateOptions = {},
): () => void {
  rotateServiceLog(dataDir, opts);
  const timer = setInterval(() => {
    rotateServiceLog(dataDir, opts);
  }, ROTATE_CHECK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
