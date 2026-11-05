/**
 * Process lifecycle for a Paddock server: bind the port, publish
 * `runtime.json`, and wire signal-driven shutdown. Split out of `index.ts` so
 * the `paddock` CLI (src/cli/paddock.ts) and the plain `node dist/index.js`
 * entrypoint share one implementation.
 *
 * Config is resolved INSIDE `buildApp()`, not at module load, so a caller may
 * still mutate `process.env` right up until this function is invoked. The CLI
 * depends on that to apply its own defaults (e.g. a data dir under $HOME).
 */
import { buildApp } from "./app.js";
import { startServiceLogRotation } from "./service-log.js";
import { removeRuntimeFile, writeRuntimeFile } from "./runtime-file.js";
import { PADDOCK_VERSION } from "./version.js";

/**
 * How long a clean shutdown gets before we exit anyway.
 *
 * The CLI contract requires the SIGTERM path to exit "within the unit's stop
 * timeout" (SPEC §4, §8), and the tightest of those is **launchd's**: with no
 * `ExitTimeOut` in the plist, a LaunchAgent gets 20 seconds before SIGKILL
 * (systemd's user default is 90). So the budget is 20 seconds, and this sits
 * inside it with room for the exit itself.
 *
 * The deadline matters because the two awaits below are not bounded by anything
 * else. `app.close()` waits for in-flight requests and open WebSockets, and a
 * browser holding `/ws` is the normal state of a running Paddock; `fleet.stop()`
 * talks to subprocesses. Exceeding the budget is strictly worse than exiting at
 * it: SIGKILL skips the rest of this function, so the runtime file would be left
 * behind for the next instance's `busy` to find and the log would have no record
 * of what was cut short.
 */
export const SHUTDOWN_DEADLINE_MS = 15_000;

/**
 * The URL to record in `runtime.json` — the one a CLI on this machine can
 * actually fetch, which is not always the one we bound.
 *
 * A wildcard bind is the normal case for a container or a dev box (`HOST=0.0.0.0`
 * is what this repo's own `pm` wrapper injects), and `http://0.0.0.0:<port>` is
 * not an address to connect TO. Node happens to resolve it to loopback on Linux
 * and fails on some other stacks, so the file records loopback explicitly rather
 * than relying on that. A real interface address is left alone: someone who
 * bound `192.168.1.10` meant it, and that address reaches the server from here
 * as well as from anywhere else.
 *
 * IPv6 gets brackets, because `new URL('http://::1:7233')` is not a URL.
 */
export function runtimeUrl(host: string, port: number): string {
  const loopback: Record<string, string> = {
    "0.0.0.0": "127.0.0.1",
    "::": "::1",
    "": "127.0.0.1",
  };
  const h = loopback[host] ?? host;
  return `http://${h.includes(":") ? `[${h}]` : h}:${String(port)}`;
}

export async function start(): Promise<void> {
  const { app, cfg, close, hub } = await buildApp();

  // Nothing else rotates the service log: the supervisor appends to it through
  // its own descriptor, a `systemd --user` unit writing to a file gets no
  // journal rotation, and macOS has nothing that would (SPEC §7). A no-op on a
  // foreground run, where that file does not exist — see service-log.ts.
  const stopRotation = startServiceLogRotation(cfg.dataDir, {
    warn: (message) => {
      app.log.warn(message);
    },
  });

  /**
   * Exit on SIGTERM/SIGINT having said what was cut short (SPEC §4, §8).
   *
   * Three things are deliberate here.
   *
   * **It records rather than finishes.** A chat turn is a `claude` subprocess
   * that can run for minutes; no 20-second stop timeout can wait for one, and
   * `herdctl.stop()` ends the fleet with `waitForJobs: false` precisely because
   * waiting is not an option. So the contract's other half applies — record the
   * work under way — and the record is this `warn` line in the service log,
   * which is the one artefact that survives the restart and which
   * `paddock service logs` reads. What is NOT done, and should not be, is
   * writing a note into the cut-short chat's transcript: `claude` owns that file
   * and may append to it after we are gone, so a server-side write cannot be
   * ordered against the subprocess's own and would be the resurrection race
   * `turn-interlock.ts` exists to avoid.
   *
   * The reason a count is enough: `/api/busy` reports the same numbers BEFORE
   * the stop, and `paddock service stop` refuses on them. The log line is for
   * the race §4 admits — work that started between the check and the signal.
   *
   * **It is idempotent.** A supervisor that sends SIGTERM twice, or a Ctrl-C
   * after a SIGTERM, used to re-enter `close()` concurrently: a second
   * `app.close()` on a closing Fastify rejects, and a second `fleet.stop()`
   * races the first. The guard makes the extra signals no-ops.
   *
   * **It exits 0.** The unit's `Restart=always` / `KeepAlive` means the
   * supervisor brings Paddock back whatever the code; 0 is what makes a logout
   * or a `service stop` read as a clean stop rather than a crash in the logs.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const running = hub.runningSessions().length;
    app.log.warn(
      running > 0
        ? `${signal}: shutting down with ${running} chat turn(s) in flight — they are being cut short. ` +
            "Run `paddock busy` before a stop or an update to see this before it happens."
        : `${signal}: shutting down, no chat turn in flight.`,
    );
    stopRotation();
    // Published once we were listening; removed here so a `busy` or a
    // `service status` run after this exit does not find a live-looking
    // instance. Before the slow awaits, because this is the part that must land
    // even if they overrun the deadline below.
    removeRuntimeFile(cfg.dataDir);
    // Bounded: see SHUTDOWN_DEADLINE_MS. `exit(0)` either way, so a hung
    // `app.close()` cannot turn a stop into a SIGKILL.
    await Promise.race([close(), new Promise((r) => setTimeout(r, SHUTDOWN_DEADLINE_MS))]).catch(
      () => undefined,
    );
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: cfg.port, host: cfg.host });

  // `<dataDir>/runtime.json`, 0600, written only once we are actually listening
  // (SPEC §4) — it is how `paddock busy`, and later `update`, find THIS instance
  // without guessing a port. A failure to write it is logged and not fatal: the
  // server is up and serving, and the one thing that stops working is a CLI
  // finding it, which is better than refusing to run.
  try {
    writeRuntimeFile(cfg.dataDir, {
      pid: process.pid,
      port: cfg.port,
      url: runtimeUrl(cfg.host, cfg.port),
      version: PADDOCK_VERSION,
    });
  } catch (err) {
    app.log.warn(
      `could not write ${cfg.dataDir}/runtime.json (${(err as Error).message}) — ` +
        "`paddock busy` will report this instance as not running",
    );
  }

  app.log.info(`paddock-server listening on http://${cfg.host}:${cfg.port}`);
}
