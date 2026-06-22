import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a fresh temp directory and return its REAL (symlink-resolved) path.
 *
 * macOS maps /tmp → /private/tmp; Claude Code records transcripts under the real
 * path and paddock canonicalizes its data dir, so tests must use the real path
 * too or session-discovery encode mismatches (the same reason config.ts
 * canonicalizes). Returns an absolute, canonical dir under the OS temp root.
 */
export async function makeTmpDir(prefix = "paddock-test-"): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fsSync.realpathSync(base);
}

/** Recursively remove a temp dir, ignoring errors. */
export async function rmTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
