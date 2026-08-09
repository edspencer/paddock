/**
 * Stand-in for `test/e2e/server.mjs` in orphan-watchdog.spec.ts.
 *
 * Same shape as the real launcher — spawn a long-lived child NON-detached, then
 * arm the watchdog — but with a sleeper in place of the paddock server, so the
 * spec needs no port, no build and no browser. Reports the pids it created so
 * the spec can census them by pid rather than by pattern.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { armOrphanWatchdog } from "../orphan-watchdog.mjs";

const out = process.argv[2];

// Non-detached, exactly as server.mjs spawns the paddock server: the child
// inherits our process group, which is what lets the watchdog take the whole
// tree down with one group kill.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
  stdio: "ignore",
});

writeFileSync(
  out,
  JSON.stringify({ shell: process.ppid, harness: process.pid, child: child.pid }),
);

armOrphanWatchdog(child, { intervalMs: 200 });
setInterval(() => {}, 1 << 30);
