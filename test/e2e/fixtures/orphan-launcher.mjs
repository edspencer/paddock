/**
 * Stand-in for the Playwright runner in orphan-watchdog.spec.ts.
 *
 * Reproduces how Playwright starts a `webServer`: through a shell, DETACHED, so
 * the shell leads a process group of its own and a group kill of this launcher
 * cannot reach it (playwright-core processLauncher: `detached: process.platform
 * !== "win32"`). The spec kills THIS process to simulate an aborted run.
 */
import { spawn } from "node:child_process";

const [out, harness] = process.argv.slice(2);

spawn("/bin/sh", ["-c", `${process.execPath} ${harness} ${out}`], {
  detached: true,
  stdio: "ignore",
});

setInterval(() => {}, 1 << 30);
