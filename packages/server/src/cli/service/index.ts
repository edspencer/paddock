/**
 * `paddock service install | uninstall | status` (#796).
 *
 * Registers Paddock as a **per-user** background service — a launchd
 * LaunchAgent on macOS, a `systemd --user` unit on Linux — so it is up from
 * login rather than for as long as a terminal tab.
 *
 * This file is the dispatch and the human output; the two backends do the
 * writing and `spec.ts` holds every decision that is not init-system-specific.
 *
 * Three things this deliberately does not do:
 *
 * - **It does not set `PADDOCK_DATA_DIR`.** With nothing named, the service and
 *   a `paddock` typed into a terminal both land on `~/.paddock`: one instance,
 *   two ways to reach it.
 * - **It does not generate an auth token.** A service is up longer than an
 *   `npx` run, but not reachable by anything new: a local process that can
 *   reach the port could already read the same Claude login as the same user.
 *   Duration, not reach. `PADDOCK_AUTH_MODE` is there for anyone who wants one
 *   anyway, and the bind-safety guard (#435) still refuses a routable interface
 *   with auth off.
 * - **It does not claim to start at boot.** See `launchd.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, type CliOptions, type ServiceAction } from "../args.js";
import {
  buildSpec,
  defaultDataDir,
  hostFromArgv,
  isNpxPath,
  NPX_REFUSAL,
  portFromArgv,
  serviceDir,
  type ServiceSpec,
} from "./spec.js";
import { spawnRunner, type Runner, type ServiceBackend } from "./backend.js";
import { createLaunchdBackend } from "./launchd.js";
import { createSystemdBackend } from "./systemd.js";
import { waitForReady, READY_TIMEOUT_LABEL, type Readiness } from "./ready.js";

export interface ServiceContext {
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** `process.execPath` — the interpreter the unit will name explicitly. */
  nodePath: string;
  /** Absolute realpath of `dist/cli/paddock.js`. */
  scriptPath: string;
  /** The `findUp("package.json")` root, tested for an npx cache path. */
  packageRoot: string;
  homeDir: string;
  /** `process.env.PADDOCK_DATA_DIR`, if the installing shell had one. */
  envDataDir?: string;
  /** `process.env.XDG_CONFIG_HOME`, if set — where the systemd user unit goes. */
  xdgConfigHome?: string;
  pathEnv?: string;
  run?: Runner;
  /**
   * "Did the URL answer?", injected for the same reason `run` is.
   *
   * Without a seam here every install test would really poll 127.0.0.1 for the
   * full timeout and then assert on the disappointed message — twenty seconds
   * per case, and green for the wrong reason.
   */
  checkReady?: (url: string) => Promise<Readiness>;
}

/**
 * Pick a backend, or explain why there isn't one.
 *
 * Windows is the honest gap. It has no per-user service concept that maps onto
 * either of these without a scheduled task or a service wrapper, and shipping
 * an untested third writer would be worse than saying so.
 */
function backendFor(ctx: ServiceContext): ServiceBackend {
  const run = ctx.run ?? spawnRunner;
  if (ctx.platform === "darwin") return createLaunchdBackend(run, ctx.homeDir);
  if (ctx.platform === "linux") return createSystemdBackend(run, ctx.homeDir, ctx.xdgConfigHome);
  throw new CliError(
    `\`paddock service\` supports macOS (launchd) and Linux (systemd --user), not ${ctx.platform}.\n` +
      "Run `paddock` in a terminal, or keep it up with whatever your platform uses.",
  );
}

/** The data dir the service will use, and whether it has to be named explicitly. */
function resolveDataDir(
  opts: CliOptions,
  ctx: ServiceContext,
): { dataDir: string; explicit: string | undefined } {
  // Mirrors `paddock.ts`: flag beats env beats default. An env var set in the
  // installing shell is an explicit choice too — but it is one the service
  // would NOT inherit, so it gets written into the unit rather than silently
  // dropped in favour of ~/.paddock.
  const chosen = opts.dataDir ?? ctx.envDataDir;
  if (chosen !== undefined) {
    const resolved = path.resolve(chosen);
    return { dataDir: resolved, explicit: resolved };
  }
  return { dataDir: defaultDataDir(ctx.homeDir), explicit: undefined };
}

function specFor(opts: CliOptions, ctx: ServiceContext): { spec: ServiceSpec; dataDir: string } {
  const { dataDir, explicit } = resolveDataDir(opts, ctx);
  const spec = buildSpec({
    nodePath: ctx.nodePath,
    scriptPath: ctx.scriptPath,
    dataDir,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(explicit !== undefined ? { dataDirArg: explicit } : {}),
    ...(opts.verbose ? { verbose: true } : {}),
    ...(ctx.pathEnv !== undefined ? { pathEnv: ctx.pathEnv } : {}),
  });
  return { spec, dataDir };
}

/** The line every surface has to carry, because otherwise it gets filed as a bug. */
const AT_LOGIN =
  "  Paddock starts when you LOG IN, not when the machine boots — it runs as\n" +
  "  you, so it can use the Claude login you already have. After a restart\n" +
  "  that nobody logs into, Paddock is not running.";

/**
 * Say what is about to happen, before the part that looks like a hang (#861).
 *
 * `backend.install` runs `launchctl bootout` / `bootstrap` / `kickstart` — or
 * the systemd equivalents — through `spawnSync`, and on macOS the bootstrap is
 * followed by Background-Task-Management registering the new LaunchAgent as a
 * login item (the "… can run in the background" notification fires in this
 * window). Three to five seconds, and every one of them silent.
 *
 * **There is no spinner here, and that is not laziness.** Those subprocess calls
 * are synchronous: they block the event loop, so a `setInterval` ticker would
 * sit frozen for exactly the span it was added to animate — worse than no
 * spinner, because a stopped spinner reads as a crashed process. Animating it
 * would mean making the whole `Runner` seam async, which is a much larger change
 * than this issue is asking for. The defect reported was the SILENCE, and text
 * on the screen fixes the silence.
 */
function installProgress(backend: ServiceBackend): string {
  const kind = backend.platform === "darwin" ? "the LaunchAgent" : "the user service";
  return backend.platform === "darwin"
    ? `\n  Installing ${kind} and starting Paddock…\n` +
        "  macOS may take a few seconds to approve the background item."
    : `\n  Installing ${kind} and starting Paddock…`;
}

async function install(
  opts: CliOptions,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<void> {
  if (isNpxPath(ctx.packageRoot)) throw new CliError(NPX_REFUSAL);

  const { spec, dataDir } = specFor(opts, ctx);
  const url = `http://${hostFromArgv(spec.args)}:${portFromArgv(spec.args)}`;

  console.log(installProgress(backend));
  backend.install(spec);

  // The unit is written and the supervisor has accepted it. That is NOT the
  // same as "Paddock is running", which is what this block used to assert
  // before anything had been checked — so the success message could sit over a
  // crash-loop (a port clash restarts every RestartSec/ThrottleInterval, and
  // both supervisors report `running` for most of that window) and still print
  // a URL and a tick. Waiting is what makes the headline true.
  console.log(`  Waiting for ${url} to answer…`);
  const readiness = await (ctx.checkReady ?? ((u: string) => waitForReady({ url: u })))(url);

  const kind =
    backend.platform === "darwin" ? "a launchd LaunchAgent" : "a systemd --user service";
  const linger = backend.lingerNote();

  console.log(
    [
      "",
      readiness === "ready"
        ? `  ✓ Paddock is installed as ${kind}, and running at ${url}`
        : `  Paddock is installed as ${kind}, but ${url} did not answer\n` +
          `  within ${READY_TIMEOUT_LABEL}. The unit is in place; it may still be\n` +
          "  coming up, or it may be failing to start — the logs below say which.",
      "",
      ...(readiness === "ready" ? [] : [`  URL:  ${url}`]),
      `  Data: ${dataDir}`,
      `  Unit: ${backend.unitPath}`,
      backend.logsHint(spec),
      "",
      AT_LOGIN,
      ...(linger !== undefined ? ["", linger] : []),
      "",
      "  paddock service status      is it up, and where",
      "  paddock service uninstall   stop it and remove the unit",
      "",
    ].join("\n"),
  );
}

function uninstall(ctx: ServiceContext, backend: ServiceBackend): void {
  const existed = backend.uninstall();
  console.log(
    existed
      ? `\n  Paddock's ${backend.platform === "darwin" ? "LaunchAgent" : "user service"} is stopped and removed.\n  ${backend.unitPath}\n\n  Your data is untouched — it was never in there.\n`
      : `\n  No Paddock service was installed (${backend.unitPath}).\n  Nothing to do.\n`,
  );
  // Leave the service directory: it holds logs, and the last thing anyone wants
  // from `uninstall` is for the record of why they are uninstalling to vanish.
  void ctx;
}

function status(opts: CliOptions, ctx: ServiceContext, backend: ServiceBackend): void {
  const state = backend.status();
  if (!state.registered) {
    console.log(
      [
        "",
        "  Paddock is not installed as a service.",
        `  Looked for: ${backend.unitPath}`,
        "",
        "  paddock service install     register it and start it now",
        "",
      ].join("\n"),
    );
    return;
  }

  // Everything below is read back out of the INSTALLED unit, not recomputed
  // from today's flags — the installed port is the one the URL has to name.
  const url = `http://${hostFromArgv(state.argv)}:${portFromArgv(state.argv)}`;
  const dataFromUnit = state.argv.indexOf("--data-dir");
  const dataDir =
    dataFromUnit >= 0 && state.argv[dataFromUnit + 1] !== undefined
      ? state.argv[dataFromUnit + 1]
      : defaultDataDir(ctx.homeDir);
  // Drop `--data-dir` before building the log-path spec (#824). `resolveDataDir`
  // gives `opts.dataDir` precedence over `ctx.envDataDir`, which is right for
  // `install` (see the comment there) and wrong here: this whole block reports
  // the INSTALLED unit, so letting today's flag through printed the unit's data
  // dir beside a `Logs:` path under a directory the service never writes to. On
  // macOS that log path is real and load-bearing, not just cosmetic.
  //
  // `--data-dir` is documented as install-only (SERVICE_USAGE), so ignoring it
  // here matches both the help text and the stated intent of this block.
  const statusOpts: CliOptions = { ...opts };
  delete statusOpts.dataDir;
  const { spec } = specFor(statusOpts, { ...ctx, envDataDir: dataDir });
  const linger = backend.lingerNote();

  console.log(
    [
      "",
      state.running
        ? `  Paddock is running${state.pid !== undefined ? ` (pid ${state.pid})` : ""}.`
        : "  Paddock is registered as a service, but not running right now.",
      "",
      `  URL:  ${url}`,
      `  Data: ${dataDir}`,
      `  Unit: ${backend.unitPath}`,
      `  Args: paddock ${state.argv.join(" ")}`,
      backend.logsHint(spec),
      "",
      AT_LOGIN,
      ...(linger !== undefined && !state.running ? ["", linger] : []),
      "",
    ].join("\n"),
  );
}

export async function runService(
  action: ServiceAction,
  opts: CliOptions,
  ctx: ServiceContext,
): Promise<void> {
  const backend = backendFor(ctx);
  if (action === "install") return install(opts, ctx, backend);
  if (action === "uninstall") return uninstall(ctx, backend);
  return status(opts, ctx, backend);
}

/** Exported for the entrypoint's context assembly, and for tests. */
export { serviceDir, isNpxPath };
export type { ServiceSpec };

/** Best-effort home dir; `os.homedir()` throws on a machine with no passwd entry. */
export function safeHomeDir(): string {
  try {
    return os.homedir();
  } catch {
    return process.env.HOME ?? "/";
  }
}

/** Realpath, falling back to the input — a broken symlink is not worth a crash. */
export function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
