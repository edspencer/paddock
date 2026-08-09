/**
 * Orphan self-termination for the E2E fixture launcher (#788 class A).
 *
 * An aborted E2E run used to leak `test/e2e/server.mjs` + its paddock server
 * FOREVER: 387 MB per abort, still answering /api/health 200 on their ports —
 * which the NEXT run then attaches to (`reuseExistingServer`). Measured on the
 * dev box: 0 of 6 leaked processes self-reaped over a 150s drain, and SIGTERM
 * behaved identically to SIGKILL, so "abort more gently" is not a remedy.
 *
 * Nothing external will ever stop the launcher, so it has to notice on its own
 * — the property chromium already has (it watches its pipe and self-exits,
 * which is why browsers end up as zombies while this launcher ends up
 * immortal):
 *
 *   * Playwright spawns `webServer` commands DETACHED, so the `sh -c` wrapper
 *     leads a process group of its own. A group kill of the test runner cannot
 *     reach it by design.
 *   * `server.mjs`'s SIGINT/SIGTERM handlers are therefore DEAD CODE on the
 *     abort path — it is never signalled at all. Do not "fix" this by adding
 *     more signal handlers; they cannot fire.
 *
 * What we watch, and why it is NOT just `process.ppid`: Playwright runs the
 * launcher via `/bin/sh -c node test/e2e/server.mjs`, and that shell does NOT
 * exec it — the shell survives as its parent indefinitely. Measured across an
 * abort, the launcher's ppid was unchanged at t+0s, t+3s and t+150s while the
 * Playwright runner above it was already a zombie. So the death to detect is
 * the GRANDparent's, not the parent's. We check both, since a shell that did
 * exec the launcher leaves the runner as its direct parent.
 *
 * Both are compared against the value captured at BOOT, never against `1` — in
 * a container a process can legitimately be started BY pid 1, so a bare
 * `=== 1` test false-positives.
 */
import { readFileSync } from "node:fs";

/** Read a field of /proc/<pid>/stat, 0-indexed from `state` (stat field 3). */
const procField = (pid, index) => {
  try {
    // Parse past the LAST ')': a comm can itself contain spaces and parens.
    const rest = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^[\s\S]*\) /, "");
    return Number(rest.split(" ")[index]);
  } catch {
    return null; // process gone, or no procfs (non-Linux)
  }
};

const ppidOf = (pid) => procField(pid, 1); // stat field 4 (ppid)

/**
 * Poll for our launcher chain dying and, when it does, take this whole process
 * group down. Returns the timer (already `unref`'d, so it never keeps an
 * otherwise-healthy run alive).
 *
 * @param {import("node:child_process").ChildProcess} child the spawned server
 */
export function armOrphanWatchdog(child, { intervalMs = 1000 } = {}) {
  const ourPgid = procField(process.pid, 2); // stat field 5 (pgrp)
  const bornParent = process.ppid;
  const bornGrandparent = ppidOf(bornParent);

  const timer = setInterval(() => {
    const orphaned = process.ppid !== bornParent || ppidOf(bornParent) !== bornGrandparent;
    if (!orphaned) return;

    // Take the whole tree down, not just the direct child: the paddock server
    // spawns `claude` grandchildren, and they share this process group
    // precisely BECAUSE the server is spawned non-detached. Do NOT add
    // `detached: true` to that spawn — Playwright's own teardown is
    // `kill(-pgid, SIGKILL)` against this group (processLauncher.killProcess),
    // so a detached child would escape it and leak on every CLEAN run too.
    //
    // The `> 1` guard covers the degenerate case: pid 1 in a container is a
    // real server, and killing its group would take the whole box down.
    if (ourPgid && ourPgid > 1) {
      try {
        process.kill(-ourPgid, "SIGKILL"); // kills this process too
      } catch {
        /* group already gone */
      }
    }
    try {
      child.kill("SIGKILL"); // fallback where procfs is unavailable
    } catch {
      /* already dead */
    }
    process.exit(1);
  }, intervalMs);

  timer.unref();
  return timer;
}
