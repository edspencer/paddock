import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for #788 class A: an aborted E2E run must not leave the
 * fixture launcher and its server running forever.
 *
 * Before the fix, a deliberately-aborted run left 6 live processes holding
 * 387 MB and answering /api/health 200 indefinitely — 0 of 6 self-reaped over a
 * 150s drain, under SIGKILL and SIGTERM alike. The next run then attached to
 * that corpse via `reuseExistingServer`.
 *
 * This exercises the real `armOrphanWatchdog` against the real process
 * topology — launcher → detached `sh -c` → harness → non-detached child — but
 * with a sleeper standing in for the paddock server, so it needs no port, no
 * build and no browser. It uses no `page`, so no browser is launched for it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Liveness by `State:`, NOT by `process.kill(pid, 0)`.
 *
 * A zombie still has a pid entry and still accepts signals, so `kill(pid, 0)`
 * reports it alive — it is a reaped-pending corpse holding no memory and no
 * port. Where pid 1 is an application rather than an init (this repo's own
 * Dockerfile, until #788 class B), those corpses persist indefinitely and would
 * make this test fail against a watchdog that worked perfectly. This is the
 * exact live-vs-zombie conflation #788's diagnostic note is about.
 */
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Parse past the LAST ')': a comm can itself contain spaces and parens.
    return stat.replace(/^[\s\S]*\) /, "").split(" ")[0] !== "Z";
  } catch {
    return false; // gone entirely
  }
};
const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
};

// The watchdog reads /proc to see past the shell wrapper that Playwright puts
// between the runner and the launcher. CI and the dev box are both Linux.
test.skip(process.platform !== "linux", "watchdog needs procfs");

test("an aborted run does not leak the fixture launcher (#788 class A)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "paddock-orphan-"));
  const out = path.join(tmp, "pids.json");

  const launcher = spawn(
    process.execPath,
    [path.join(here, "fixtures", "orphan-launcher.mjs"), out, path.join(here, "fixtures", "orphan-harness.mjs")],
    { stdio: "ignore" },
  );

  let pids!: { shell: number; harness: number; child: number };
  try {
    expect(await waitFor(() => existsSync(out), 15_000), "harness should report its pids").toBe(
      true,
    );
    pids = JSON.parse(readFileSync(out, "utf8"));

    // Precondition: the whole tree is up, and the shell really is detached into
    // its own group — i.e. a group kill of the launcher cannot reach it, which
    // is the entire reason the watchdog has to exist.
    expect(alive(pids.harness), "harness alive before abort").toBe(true);
    expect(alive(pids.child), "child alive before abort").toBe(true);
    const shellStat = readFileSync(`/proc/${pids.shell}/stat`, "utf8").replace(/^[\s\S]*\) /, "");
    expect(Number(shellStat.split(" ")[2]), "shell leads its own process group").toBe(pids.shell);

    // Abort the run the way a harness timeout does: kill the runner outright.
    launcher.kill("SIGKILL");

    // The watchdog polls at 200ms here; allow generous slack for a loaded box.
    expect(
      await waitFor(() => !alive(pids.harness) && !alive(pids.child) && !alive(pids.shell), 15_000),
      "launcher, shell and server should all self-terminate once orphaned",
    ).toBe(true);
  } finally {
    // Never leave residue behind, by explicit pid only.
    for (const pid of [pids?.child, pids?.harness, pids?.shell, launcher.pid]) {
      if (pid && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
});

test("the watchdog stays quiet while the run is healthy (#788 class A)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "paddock-orphan-"));
  const out = path.join(tmp, "pids.json");

  const launcher = spawn(
    process.execPath,
    [path.join(here, "fixtures", "orphan-launcher.mjs"), out, path.join(here, "fixtures", "orphan-harness.mjs")],
    { stdio: "ignore" },
  );

  let pids!: { shell: number; harness: number; child: number };
  try {
    expect(await waitFor(() => existsSync(out), 15_000)).toBe(true);
    pids = JSON.parse(readFileSync(out, "utf8"));

    // A false positive here would kill the fixture server mid-suite, which is
    // strictly worse than the leak: the whole run would fail. 15 poll cycles.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(alive(pids.harness), "harness must survive a healthy run").toBe(true);
    expect(alive(pids.child), "server must survive a healthy run").toBe(true);
  } finally {
    for (const pid of [pids?.child, pids?.harness, pids?.shell, launcher.pid]) {
      if (pid && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
});
