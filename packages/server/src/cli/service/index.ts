/**
 * `paddock service install | uninstall | status | start | stop | restart`
 * (#796; the lifecycle three added in #873).
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
import { EXIT } from "../exit-codes.js";
import {
  buildSpec,
  defaultDataDir,
  hostFromArgv,
  isNpxPath,
  NPX_REFUSAL,
  portFromArgv,
  serviceDir,
  serviceLogPath,
  PADDOCK_SERVICE,
} from "./spec.js";
import {
  spawnRunner,
  type LingerState,
  type Runner,
  type ServiceManager as ServiceBackend,
  type ServiceSpec,
  type ServiceState,
} from "./manager.js";
import { createLaunchd, renderPlist } from "./launchd.js";
import { createSystemd, renderUnit } from "./systemd.js";
import { underNodeModules } from "../update/install-method.js";
import { missingPaths } from "./path-env.js";
import { DEFAULT_LOG_LINES, followFile, sizeOf, tailFile } from "./logs.js";
import { readLiveRuntimeFile } from "../../runtime-file.js";
import { PADDOCK_VERSION } from "../../version.js";
import { updateSummary, type UpdateSummary } from "../update/update-check.js";
import {
  waitForReady,
  fetchHealth,
  identifyPaddock,
  isListening,
  READY_TIMEOUT_LABEL,
  type HealthAnswer,
  type Readiness,
} from "./ready.js";

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
   * Without a seam here every `install` / `start` / `restart` test would really
   * poll 127.0.0.1 for the full timeout and then assert on the disappointed
   * message — twenty seconds per case, and green for the wrong reason.
   */
  checkReady?: (url: string) => Promise<Readiness>;
  /**
   * "What does `/api/health` say?", injected for the same reason `checkReady`
   * is — `status` has to be assertable without a server to ask.
   */
  probeHealth?: (url: string) => Promise<HealthAnswer | undefined>;
  /**
   * The busy check `stop` and `restart` run first (SPEC §1, §4): null to go
   * ahead, or 75 having printed the refusal.
   *
   * Injected for the third time for the third version of the same reason: the
   * real one reads `<home>/runtime.json` and fetches a URL, so a test of "does
   * stop refuse" would otherwise need a server to be busy at it.
   */
  guardBusy?: (
    action: "stop" | "restart",
    home: string,
    opts: { force?: boolean; json?: boolean },
  ) => Promise<number | null>;
  /**
   * Who holds `host:port` — nothing, a Paddock, or something else — asked by
   * `install` before it writes a unit (SPEC §1). Injected so a test's answer
   * does not depend on what happens to be listening on the box running it.
   */
  portOwner?: (host: string, port: number) => Promise<PortOwner>;
}

export type PortOwner = "free" | "paddock" | "other";

/** The real {@link ServiceContext.portOwner}: a TCP connect, then `/api/health` and `/api/busy`. */
export async function portOwner(host: string, port: number): Promise<PortOwner> {
  const probe = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" ? "::1" : host;
  if (!(await isListening(probe, port))) return "free";
  const who = await identifyPaddock(`http://${probe.includes(":") ? `[${probe}]` : probe}:${port}`);
  return who?.paddock === true ? "paddock" : "other";
}

/**
 * Why `install` won't write a unit that runs a checkout (SPEC §1, §6).
 *
 * A checkout (or an `npm link`) is a working tree: it gets rebuilt, switched to
 * another branch, cleaned and moved, and a unit that runs it follows every one
 * of those — half-built `dist/` included — at the next login, unattended. The
 * flag is there for working on Paddock itself, where that is the point.
 */
export function checkoutRefusal(packageRoot: string): string {
  return (
    `this copy of Paddock is a checkout (${packageRoot}), so \`service install\` won't use it.\n` +
    "         A unit that runs a checkout follows every rebuild, branch switch and move of\n" +
    "         it, at your next login, unattended. Install it properly first:\n\n" +
    "  npm i -g @edspencer/paddock && paddock service install\n\n" +
    "  Or run this checkout as the service anyway (when working on Paddock):\n" +
    "  paddock service install --from-checkout\n"
  );
}

/**
 * Pick a backend, or explain why there isn't one.
 *
 * Windows is the honest gap. It has no per-user service concept that maps onto
 * either of these without a scheduled task or a service wrapper, and shipping
 * an untested third writer would be worse than saying so.
 */
export function serviceBackend(ctx: ServiceContext): ServiceBackend {
  return backendFor(ctx);
}

function backendFor(ctx: ServiceContext): ServiceBackend {
  const run = ctx.run ?? spawnRunner;
  if (ctx.platform === "darwin") return createLaunchd(PADDOCK_SERVICE, { run, homeDir: ctx.homeDir });
  if (ctx.platform === "linux") {
    return createSystemd(PADDOCK_SERVICE, {
      run,
      homeDir: ctx.homeDir,
      ...(ctx.xdgConfigHome !== undefined ? { xdgConfigHome: ctx.xdgConfigHome } : {}),
    });
  }
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

/** The value of a flag in a recorded argument vector, or undefined. */
function argValue(argv: string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i]) && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return undefined;
}

/**
 * The settings an EXISTING unit carries, as if they had been typed
 * (`service install --refresh`, SPEC §1 and §5 step 11).
 *
 * This is what makes a reinstall idempotent rather than a reset. A unit
 * installed with `--port 9000 --data-dir /srv/paddock` must come back on 9000
 * pointing at /srv/paddock — and `update` is precisely the caller that has no
 * way to know those values, because it runs the NEW version's CLI in a shell
 * that never typed them.
 *
 * Flags still win, so `service install --refresh --port 7300` moves the port.
 * The ENVIRONMENT deliberately does not: `resolveDataDir` normally lets
 * `PADDOCK_DATA_DIR` stand in for `--data-dir`, which would be wrong here —
 * the refresh is a faithful re-render of a unit, and inheriting the updating
 * shell's data dir would silently repoint somebody's service at a different
 * instance. A unit with no recorded `--data-dir` keeps having none, which is
 * how it stays the same `~/.paddock` a bare `paddock` reaches.
 */
function inherit(opts: CliOptions, state: ServiceState): CliOptions {
  const port = argValue(state.argv, ["--port", "-p"]);
  const host = argValue(state.argv, ["--host"]);
  const dataDir = argValue(state.argv, ["--data-dir", "-d"]);
  return {
    ...opts,
    ...(opts.port === undefined && port !== undefined ? { port } : {}),
    ...(opts.host === undefined && host !== undefined ? { host } : {}),
    ...(opts.dataDir === undefined && dataDir !== undefined ? { dataDir } : {}),
    verbose: opts.verbose || state.argv.includes("--verbose"),
  };
}

function specFor(
  opts: CliOptions,
  ctx: ServiceContext,
  /** Set on a `--refresh`: the data dir comes from the unit, not the environment. */
  fromUnit = false,
): { spec: ServiceSpec; dataDir: string } {
  const { dataDir, explicit } = fromUnit
    ? opts.dataDir !== undefined
      ? { dataDir: path.resolve(opts.dataDir), explicit: path.resolve(opts.dataDir) }
      : { dataDir: defaultDataDir(ctx.homeDir), explicit: undefined }
    : resolveDataDir(opts, ctx);
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
 * What `status` says about a unit installed before #872.
 *
 * Upgrading the package leaves the unit file alone, so the people still holding
 * the broken shape are exactly the people who will never notice — the symptom
 * is Paddock being absent one morning, with nothing in the logs, because it was
 * signalled rather than crashed. Naming the fix here is the only path from that
 * symptom back to a working service.
 */
function staleUnitWarning(backend: ServiceBackend): string {
  const key =
    backend.platform === "darwin"
      ? "KeepAlive is conditional on a non-zero exit"
      : "Restart=on-failure";
  return (
    `This unit predates a fix (#872): ${key}, so a graceful stop — the kind ` +
    "sleep, logout or a stray `kill` sends — puts Paddock down until you start " +
    "it again by hand. Re-run `paddock service install` to update the unit."
  );
}

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

/**
 * The `enable-linger` line, printed only to the people it applies to (SPEC §7): when linger is off. Nothing when it's
 * on, and nothing when loginctl couldn't answer (`doctor` reports that check as skipped).
 */
export function lingerNote(linger: LingerState): string | undefined {
  if (!linger.applies || linger.enabled !== false) return undefined;
  return (
    "  Lingering is off, so this service stops when you log out — including\n" +
    "  out of an SSH session. To keep Paddock up, once:\n" +
    `    sudo loginctl enable-linger ${linger.user ?? "$USER"}`
  );
}

async function install(
  opts: CliOptions,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<number> {
  if (isNpxPath(ctx.packageRoot)) throw new CliError(NPX_REFUSAL);
  // A checkout is a package root that isn't under any `node_modules` (SPEC §6):
  // `packages/server` in the repo, `<prefix>/lib/node_modules/@edspencer/paddock/
  // packages/server` from npm. `npm link` reads the same, on purpose.
  if (!underNodeModules(ctx.packageRoot) && opts.fromCheckout !== true) {
    throw new CliError(checkoutRefusal(ctx.packageRoot));
  }

  // `--refresh` (SPEC §5 step 11): re-render an EXISTING unit, keeping what it
  // records. With nothing installed there is nothing to refresh — exit 4, the
  // same code every other command that needs a unit returns, rather than
  // quietly performing a first install from defaults. That distinction is the
  // whole reason the flag exists: `update` runs this through the new version's
  // CLI, and a silent fallback would move a `--port 9000` service to 7233 on
  // the one run nobody is watching.
  const refreshing = opts.refresh === true;
  // A reinstall keeps what the installed unit records — its port, host, data
  // dir and verbosity — unless a flag says otherwise (SPEC §1). It used to do
  // that only with `--refresh`, so `service install` over a `--port 9000`
  // service quietly moved it to 7233. `--refresh` still differs in two ways:
  // it ignores `PADDOCK_DATA_DIR` in this shell, and with no unit it exits 4.
  const current = backend.status();
  const existing: ServiceState | undefined = current.registered ? current : undefined;
  if (refreshing) {
    if (existing === undefined) {
      if (opts.dryRun === true && opts.json === true) {
        // `--dry-run --json` prints its own document (runService leaves it be).
        console.error(notInstalled(backend));
        console.log(JSON.stringify({ ok: false, action: "install", dryRun: true, error: "not installed", unit: backend.unitPath }, null, 2));
      } else {
        console.log(notInstalled(backend));
      }
      return EXIT.NOT_INSTALLED;
    }
  }

  const { spec, dataDir } = specFor(
    existing !== undefined ? inherit(opts, existing) : opts,
    ctx,
    refreshing,
  );
  const url = `http://${hostFromArgv(spec.args)}:${portFromArgv(spec.args)}`;

  // `--dry-run` (SPEC §1): the unit, on stdout, and nothing written — not the
  // unit, not the service or log folders `backend.install` would make. The
  // where-it-would-go line is on stderr, so `> paddock.service` captures the
  // unit alone.
  if (opts.dryRun === true) {
    const contents =
      backend.platform === "darwin" ? renderPlist(PADDOCK_SERVICE, spec) : renderUnit(PADDOCK_SERVICE, spec);
    if (opts.json === true) {
      console.log(
        JSON.stringify({ ok: true, action: "install", dryRun: true, unit: backend.unitPath, contents }, null, 2),
      );
    } else {
      console.error(`paddock: dry run: this is the unit \`service install\` would write to ${backend.unitPath}. Nothing was written.`);
      console.log(contents.trimEnd());
    }
    return EXIT.OK;
  }

  // Refuse a port something else holds (SPEC §1): the service would start,
  // fail to bind, and restart every ten seconds, for good. A Paddock holding it
  // is fine — that's the reinstall this replaces — and so is the unit's own
  // running service when it's too old to say it's Paddock (before 0.81).
  const port = Number(portFromArgv(spec.args));
  const owner = await (ctx.portOwner ?? portOwner)(hostFromArgv(spec.args), port);
  if (owner === "other") {
    const itsOwn = current.registered && current.running && portFromArgv(current.argv) === String(port);
    if (!itsOwn) {
      throw new CliError(
        `port ${port} is held by something that isn't Paddock, so the service could not start.\n` +
          `  Stop it, or pick another port:  paddock service install --port ${port + 1}`,
      );
    }
  }

  if (existing !== undefined) {
    console.log(
      `\n  Re-writing ${backend.unitPath}\n  Keeping: paddock ${spec.args.join(" ")}`,
    );
  }
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
  // Asked of the OS now, rather than printed at everyone (SPEC §7): the people
  // who have already enabled lingering were being told to enable it at every
  // install, which is how the line stopped being read by the people it is for.
  const linger = lingerNote(backend.linger());

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
      `  Logs: ${spec.logPath}   (paddock service logs -f)`,
      "",
      AT_LOGIN,
      ...(linger !== undefined ? ["", linger] : []),
      "",
      "  paddock service status      is it up, and where",
      "  paddock service restart     bounce it after editing config",
      "  paddock service uninstall   stop it and remove the unit",
      "",
    ].join("\n"),
  );
  // "It is installed but did not answer" is a failure, and used to exit 0 — so
  // an Ansible task or a CI step could not tell it from a working install.
  return readiness === "ready" ? EXIT.OK : EXIT.FAILED;
}

function uninstall(ctx: ServiceContext, backend: ServiceBackend): number {
  const existed = backend.uninstall();
  console.log(
    existed
      ? `\n  Paddock's ${backend.platform === "darwin" ? "LaunchAgent" : "user service"} is stopped and removed.\n  ${backend.unitPath}\n\n  Your data is untouched — it was never in there.\n`
      : `\n  No Paddock service was installed (${backend.unitPath}).\n  Nothing to do.\n`,
  );
  // Leave the service directory and the logs: the last thing anyone wants from
  // `uninstall` is for the record of why they are uninstalling to vanish (and
  // SPEC §1 requires it — `uninstall` keeps the data home and the logs).
  void ctx;
  // 0 either way: "there was nothing to remove" is the state the caller asked
  // for. `uninstall` is idempotent on purpose, so a teardown script can run it
  // without first asking whether it has anything to do.
  return EXIT.OK;
}

/**
 * The data dir the INSTALLED unit uses, read out of its own argument vector.
 *
 * Today's `--data-dir` flag is deliberately ignored (#824): every reporting
 * surface here describes the unit on disk, and letting a flag through printed
 * the unit's data dir beside a log path under a directory the service never
 * writes to. `--data-dir` is documented as install-only (SERVICE_USAGE).
 */
function dataDirOf(state: ServiceState, ctx: ServiceContext): string {
  const i = state.argv.indexOf("--data-dir");
  return i >= 0 && state.argv[i + 1] !== undefined
    ? state.argv[i + 1]
    : defaultDataDir(ctx.homeDir);
}

/** The URL the installed unit serves, read back out of the unit. */
function urlOf(state: ServiceState): string {
  return `http://${hostFromArgv(state.argv)}:${portFromArgv(state.argv)}`;
}

/**
 * The log file to read: the one the unit names, else where we would write it.
 *
 * A unit written before the logs moved to `<dataDir>/logs/service.log` names
 * the old `<dataDir>/service/paddock.log`, and that is the file its service is
 * still appending to — so that is the file `logs` has to read. The fallback
 * covers a unit we could not parse.
 */
function logPathOf(state: ServiceState, dataDir: string): string {
  return state.logPath ?? serviceLogPath(dataDir);
}

/**
 * The version of the Paddock the unit points at.
 *
 * Found by walking up from the `cli.js` in the unit to the nearest
 * `package.json`, which is `packages/server/package.json` in both the repo and
 * the published tarball — the same hop the CLI itself makes to answer
 * `--version`. Undefined when the unit names a path that is no longer there,
 * which is a state `status` reports rather than guesses around.
 */
export function installedVersionOf(cliPath: string | undefined): string | undefined {
  if (cliPath === undefined) return undefined;
  let dir = path.dirname(cliPath);
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const raw = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string };
        return raw.version;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * What `service status` knows, before it is either printed or serialised.
 *
 * One shape for both renderings, so `--json` cannot quietly disagree with the
 * prose above it — which is the usual way a `--json` flag rots.
 */
export interface StatusReport {
  installed: boolean;
  running: boolean;
  /** Did `/api/health` answer? Only then is the service actually usable. */
  answering: boolean;
  /** The version the unit points at, and the version that answered. */
  installedVersion: string | null;
  runningVersion: string | null;
  port: number | null;
  host: string | null;
  url: string | null;
  pid: number | null;
  /** The Paddock arguments the unit records, interpreter and script stripped. */
  args: string[];
  /** The plist / unit file — present whether or not it exists. */
  unit: string;
  manager: "launchd" | "systemd";
  /** The one file both streams append to. */
  log: string | null;
  dataDir: string | null;
  node: string | null;
  cli: string | null;
  /** Linux only: null where the platform has no such concept. */
  linger: boolean | null;
  /**
   * What the last `update --check` found, from `<data-dir>/update-check.json`
   * (SPEC §3).
   *
   * `status` never asks the registry itself — the contract is explicit that
   * nothing contacts it by itself, and a status command run by a monitoring
   * loop would be exactly the background check §3 forbids. So this repeats a
   * file somebody's `update --check` or `doctor` wrote.
   *
   * **Absent, not null, when there is nothing to repeat.** The contract's
   * `schemas/service-status.schema.json` types this key as an OBJECT, so a
   * `null` fails the schema and the conformance runner says so — which is how
   * this was found. The other optional fields here are `| null` because the
   * schema types THOSE as nullable; this one it does not.
   */
  update?: UpdateSummary;
  /** A stale unit, a missing Node — things that are wrong but not fatal. */
  warnings: string[];
}

/** `{ update }` when there is a recent check to repeat, and `{}` otherwise. */
function withUpdate(home: string): { update?: UpdateSummary } {
  const summary = updateSummary(home, { currentVersion: PADDOCK_VERSION });
  return summary !== undefined ? { update: summary } : {};
}

/** What `status` reports, and what `doctor`'s service checks read: one report, so the two agree. */
export async function buildStatus(ctx: ServiceContext, backend: ServiceBackend): Promise<StatusReport> {
  const state = backend.status();
  const base = {
    installed: state.registered,
    args: state.argv,
    manager: backend.platform === "darwin" ? ("launchd" as const) : ("systemd" as const),
    unit: backend.unitPath,
  };
  const linger = backend.linger();
  const lingerValue = linger.applies ? (linger.enabled ?? null) : null;

  if (!state.registered) {
    return {
      ...base,
      running: false,
      answering: false,
      installedVersion: null,
      runningVersion: null,
      port: null,
      host: null,
      url: null,
      pid: null,
      log: null,
      dataDir: null,
      node: null,
      cli: null,
      linger: lingerValue,
      ...withUpdate(path.resolve(ctx.envDataDir ?? defaultDataDir(ctx.homeDir))),
      warnings: [],
    };
  }

  const dataDir = dataDirOf(state, ctx);
  const url = urlOf(state);
  const health = await (ctx.probeHealth ?? ((u: string) => fetchHealth(u)))(url);
  const installedVersion = installedVersionOf(state.cliPath);

  const warnings: string[] = [];
  if (!state.keepsAlive) warnings.push(staleUnitWarning(backend));
  for (const gone of missingPaths([state.nodePath, state.cliPath])) {
    warnings.push(
      `The unit runs ${gone}, which is not there any more. ` +
        "That happens when a Node version is removed (nvm, fnm, volta) or the " +
        "package is reinstalled elsewhere. Re-run `paddock service install`.",
    );
  }
  if (
    installedVersion !== undefined &&
    health?.version !== undefined &&
    installedVersion !== health.version
  ) {
    warnings.push(
      `It is running ${health.version}, but ${installedVersion} is installed. ` +
        "The package was upgraded under a service that has not restarted: " +
        "`paddock service restart`.",
    );
  }
  if (linger.applies && linger.enabled === false) {
    warnings.push(
      "Lingering is off, so this service stops when you log out — including out " +
        `of an SSH session. To keep it up: sudo loginctl enable-linger ${linger.user ?? "$USER"}`,
    );
  }

  return {
    ...base,
    running: state.running,
    answering: health?.ok === true,
    installedVersion: installedVersion ?? null,
    runningVersion: health?.version ?? null,
    port: Number(portFromArgv(state.argv)),
    host: hostFromArgv(state.argv),
    url,
    pid: state.pid !== undefined ? Number(state.pid) : null,
    log: logPathOf(state, dataDir),
    dataDir,
    node: state.nodePath ?? null,
    cli: state.cliPath ?? null,
    linger: lingerValue,
    ...withUpdate(dataDir),
    warnings,
  };
}

/**
 * `status` (SPEC §1, §2).
 *
 * The exit code is the headline and the reason this command is worth scripting:
 *
 * - **4** — no unit. Nothing to start, nothing to ask.
 * - **3** — installed, but not running or not answering. "Not answering"
 *   counts, because a supervisor reports a crash-looping job as `running` for
 *   most of the window between restarts, and a service nothing can reach is not
 *   up whatever the supervisor thinks.
 * - **0** — installed, running and answering.
 *
 * Those are the numbers `systemctl status` and LSB init scripts already use, so
 * an Ansible task or a shell `if` written against either keeps working.
 */
async function status(
  opts: CliOptions,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<number> {
  const report = await buildStatus(ctx, backend);

  if (opts.json === true) {
    // Exactly one JSON document on stdout, and nothing else (SPEC §1). Every
    // other line this command can print goes to stderr under --json or is not
    // printed at all.
    console.log(JSON.stringify(report, null, 2));
    return statusExit(report);
  }

  if (!report.installed) {
    console.log(
      [
        "",
        "  Paddock is not installed as a service.",
        `  Looked for: ${report.unit}`,
        "",
        "  paddock service install     register it and start it now",
        "",
      ].join("\n"),
    );
    // The notice belongs here too. Found in QA: it was printed only on the
    // installed path, so a machine with no service got `update` in `--json`
    // and silence in the prose — the exact `--json`-disagrees-with-the-text rot
    // that one StatusReport is supposed to prevent. A newer version is worth
    // knowing about whether or not a unit exists.
    noteUpdate(report);
    return EXIT.NOT_INSTALLED;
  }

  const versions =
    report.runningVersion !== null && report.runningVersion !== report.installedVersion
      ? `  Version: ${report.runningVersion} running, ${report.installedVersion ?? "unknown"} installed`
      : `  Version: ${report.runningVersion ?? report.installedVersion ?? "unknown"}`;

  console.log(
    [
      "",
      report.running
        ? report.answering
          ? `  Paddock is running${report.pid !== null ? ` (pid ${String(report.pid)})` : ""} and answering.`
          : `  Paddock is running${report.pid !== null ? ` (pid ${String(report.pid)})` : ""}, but ${report.url ?? "its URL"} is not answering.`
        : report.answering
          ? // Found in QA, and worth its own line: the supervisor does not have
            // the job, yet something IS serving that URL — usually a `paddock
            // serve` in a terminal on the same port. "Not running" on its own
            // reads as "nothing there", and then `service start` fails on a
            // port clash for reasons the status screen had the answer to.
            `  The service is not running, but something IS answering at ${report.url ?? "its URL"}\n` +
            "  — most likely a `paddock serve` in a terminal. The service cannot take\n" +
            "  that port while it is held."
          : "  Paddock is registered as a service, but not running right now.",
      "",
      `  URL:  ${report.url ?? "unknown"}`,
      versions,
      `  Data: ${report.dataDir ?? "unknown"}`,
      `  Unit: ${report.unit}`,
      `  Args: paddock ${report.args.join(" ")}`,
      `  Logs: ${report.log ?? "unknown"}   (paddock service logs -f)`,
      "",
      AT_LOGIN,
      ...report.warnings.flatMap((w) => ["", `  ⚠ ${w}`]),
      "",
    ].join("\n"),
  );
  // The update notice goes to STDERR, and only ever repeats the cache (SPEC
  // §3). stderr because it is prose about something other than what was asked
  // for, and because that keeps every byte of stdout under the `--json`
  // discipline's one rule rather than two.
  noteUpdate(report);
  return statusExit(report);
}

/**
 * Repeat the cached update answer on stderr, when there is one worth repeating
 * (SPEC §3).
 *
 * Nothing is fetched here. The `Run:` line is the plain `paddock update`
 * rather than §6's per-install variant, because working that out needs the
 * install method and the target's tag — and `status` has deliberately not
 * asked the registry, so it has neither. Anyone whose install cannot update
 * itself gets the right command from `update --check`, which has.
 */
function noteUpdate(report: StatusReport): void {
  const update = report.update;
  if (update === undefined || !update.updateAvailable) return;
  console.error("");
  const have = report.runningVersion ?? report.installedVersion;
  console.error(
    `  ${update.latest} is available${have !== null && have !== undefined ? ` (you have ${have})` : ""}.`,
  );
  console.error("    Run: paddock update");
  console.error(`    Checked: ${update.checkedAt}`);
}

/** The exit code a report means (SPEC §2). */
function statusExit(report: StatusReport): number {
  if (!report.installed) return EXIT.NOT_INSTALLED;
  if (!report.running || !report.answering) return EXIT.NOT_RUNNING;
  return EXIT.OK;
}

/**
 * The URL an installed unit is actually serving, or undefined if none is.
 *
 * Read out of the unit rather than recomputed from today's flags, for the same
 * reason `status` does it: the port in the file is the port the server is on.
 */
function installedUrl(state: ServiceState): string {
  return `http://${hostFromArgv(state.argv)}:${portFromArgv(state.argv)}`;
}

/** "It isn't installed" — the same answer, wherever it is asked. */
function notInstalled(backend: ServiceBackend): string {
  return [
    "",
    "  Paddock is not installed as a service.",
    `  Looked for: ${backend.unitPath}`,
    "",
    "  paddock service install     register it and start it now",
    "",
  ].join("\n");
}

/**
 * `start` / `restart` (#873), which differ only in what they tolerate.
 *
 * `start` on something already running is reported and not acted on — asking
 * launchd to bootstrap a loaded job is an error, and "it is already up" is the
 * outcome the user wanted anyway. `restart` has no such case: bouncing a
 * stopped service is a legitimate way to start it, and the sequence each
 * backend uses handles both states.
 *
 * Both then WAIT. Neither supervisor's "started" means the port answers — it
 * means the fork succeeded — so printing a URL on the strength of it produces a
 * success message that can sit over a crash-loop (a port clash restarts every
 * `ThrottleInterval`, and `launchctl print` says `running` for most of that
 * window). The wait is what makes the last line true.
 */
async function startOrRestart(
  action: "start" | "restart",
  opts: CliOptions,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<number> {
  const before = backend.status();
  if (!before.registered) {
    console.log(notInstalled(backend));
    return EXIT.NOT_INSTALLED;
  }

  const url = installedUrl(before);
  if (action === "start" && before.running) {
    console.log(`\n  Paddock is already running${pid(before)}.\n\n  URL:  ${url}\n`);
    return EXIT.OK;
  }

  // A restart stops the instance first, so it asks the same question `stop`
  // asks (SPEC §1): refuse with 75 unless `--force`. `start` does not — there
  // is nothing running for it to cut short, and asking would be theatre.
  if (action === "restart") {
    const refused = await busyCheck(action, opts, ctx, before);
    if (refused !== null) return refused;
  }

  console.log(`\n  ${action === "start" ? "Starting" : "Restarting"} Paddock…`);
  if (action === "start") backend.start();
  else backend.restart();

  const readiness = await (ctx.checkReady ?? ((u: string) => waitForReady({ url: u })))(url);
  const after = backend.status();
  console.log(
    [
      "",
      readiness === "ready"
        ? `  ✓ Paddock is running${pid(after)} at ${url}`
        : `  Paddock was ${action === "start" ? "started" : "restarted"}, but ${url} did not\n` +
          `  answer within ${READY_TIMEOUT_LABEL}. It may still be coming up — check:`,
      ...(readiness === "ready"
        ? []
        : [
            "",
            "  paddock service status",
            `  paddock service logs   (${logPathOf(after, dataDirOf(after, ctx))})`,
          ]),
      "",
    ].join("\n"),
  );
  // A start that never answered is a failure, not a success with a caveat: the
  // caller — often an Ansible task — has no other way to find out.
  return readiness === "ready" ? EXIT.OK : EXIT.FAILED;
}

/**
 * The busy check, asked of the instance the UNIT describes (SPEC §1, §4).
 *
 * `home` is `dataDirOf(state, ctx)` — the unit's own data dir, not whatever
 * `--data-dir` this invocation carries. Same rule as `status` and `logs`
 * (#824): the instance about to be stopped is the one the unit points at, and
 * reading `runtime.json` from somewhere else would ask a different Paddock
 * whether this one is busy.
 *
 * Returns null to go ahead, or the code to return (75).
 */
async function busyCheck(
  action: "stop" | "restart",
  opts: CliOptions,
  ctx: ServiceContext,
  state: ServiceState,
): Promise<number | null> {
  const guard = ctx.guardBusy ?? (await import("../busy-command.js")).guardServiceBusy;
  return guard(action, dataDirOf(state, ctx), {
    ...(opts.force === true ? { force: true } : {}),
    ...(opts.json === true ? { json: true } : {}),
  });
}

/** `stop` (#873): put it down, leave it installed. */
async function stop(
  opts: CliOptions,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<number> {
  const state = backend.status();
  if (!state.registered) {
    console.log(notInstalled(backend));
    return EXIT.NOT_INSTALLED;
  }
  if (!state.running) {
    console.log(`\n  Paddock is already stopped.\n  Unit: ${backend.unitPath}\n`);
    return EXIT.OK;
  }

  // Refuse with 75 if it is in the middle of something, unless --force (SPEC
  // §4). Deliberately AFTER the two cases above: an unit that is not there, or
  // a service already stopped, has no instance to ask and no work to cut short.
  const refused = await busyCheck("stop", opts, ctx, state);
  if (refused !== null) return refused;

  backend.stop();
  console.log(
    [
      "",
      "  Paddock is stopped. The unit is still installed.",
      `  Unit: ${backend.unitPath}`,
      "",
      "  It comes back when you log in again, or now with:",
      "",
      "    paddock service start",
      "",
    ].join("\n"),
  );
  return EXIT.OK;
}

function pid(state: ServiceState): string {
  return state.pid !== undefined ? ` (pid ${state.pid})` : "";
}

/**
 * `logs [-f] [-n <lines>]` (SPEC §1, §7).
 *
 * Reads the file the INSTALLED unit names, which is the only file its service
 * is actually appending to — a unit written before the logs moved still names
 * the old path, and sending its owner to a file nothing writes to would be
 * worse than sending them nowhere.
 *
 * Exit 4 with no unit, like every other command that needs one. A unit whose
 * log file does not exist yet is NOT an error: a service installed thirty
 * seconds ago and still booting has nothing to show, and that is worth saying
 * rather than failing over.
 */
async function logs(
  opts: CliOptions,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<number> {
  const state = backend.status();
  if (!state.registered) {
    console.log(notInstalled(backend));
    return EXIT.NOT_INSTALLED;
  }

  const file = logPathOf(state, dataDirOf(state, ctx));
  const lines = opts.lines ?? DEFAULT_LOG_LINES;

  if (!fs.existsSync(file)) {
    // stderr: with `-f` this is a caveat ahead of a stream, and prose on stdout
    // would be mixed into the log output itself.
    console.error(`paddock: nothing has been written to ${file} yet.`);
    if (opts.follow !== true) return EXIT.OK;
  } else {
    const tail = tailFile(file, lines);
    if (tail !== "") console.log(tail);
  }

  if (opts.follow === true) {
    console.error(`paddock: following ${file} — Ctrl-C to stop.`);
    await followFile(file, { from: sizeOf(file) });
  }
  return EXIT.OK;
}

/**
 * Dispatch, returning the exit code rather than setting one (SPEC §2).
 *
 * The code is returned up to `paddock.ts`, which assigns `process.exitCode` —
 * never `process.exit()`, which truncates piped output mid-write.
 */
export async function runService(
  action: ServiceAction,
  opts: CliOptions,
  ctx: ServiceContext,
): Promise<number> {
  // `--force` is rejected on every action but `stop` and `restart` — in
  // `parseCommand`, once, for every verb. See the note there.
  const backend = backendFor(ctx);
  // `--json` on the actions that change something (SPEC §1): their prose goes
  // to stderr, and stdout gets one document — what was done, and the status
  // afterwards. `status` has its own; `--dry-run` prints its own.
  if (opts.json === true && action !== "status" && action !== "logs" && opts.dryRun !== true) {
    return withJson(action, () => act(action, opts, ctx, backend), ctx, backend);
  }
  return act(action, opts, ctx, backend);
}

/**
 * Run `act` with its prose on stderr, then print `{ ok, action, error?,
 * ...status }` on stdout (SPEC §1, §3) — the shape Hallway's `service … --json`
 * prints, and `status --json`'s fields after `ok` and `action`, so a script
 * reads one shape whatever it asked.
 *
 * Every line in this file goes through `console.log`, so the prose is moved by
 * pointing that at stderr for the duration, rather than by threading a writer
 * through every function. A failure still prints its document, and is then
 * re-thrown, so `paddock: <message>` and the exit code are what they are
 * without `--json`.
 */
async function withJson(
  action: ServiceAction,
  run: () => Promise<number>,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<number> {
  const log = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  let code: number;
  let failure: unknown;
  try {
    code = await run();
  } catch (err) {
    failure = err;
    code = err instanceof CliError ? err.exitCode : EXIT.FAILED;
  } finally {
    console.log = log;
  }
  const error =
    failure !== undefined
      ? (failure instanceof Error ? failure.message : String(failure)).split("\n")[0]
      : code === EXIT.BUSY
        ? "busy"
        : code === EXIT.NOT_INSTALLED
          ? "not installed"
          : code !== EXIT.OK
            ? "failed"
            : undefined;
  const report = await buildStatus(ctx, backend);
  console.log(
    JSON.stringify({ ok: code === EXIT.OK, action, ...(error !== undefined ? { error } : {}), ...report }, null, 2),
  );
  if (failure !== undefined) throw failure;
  return code;
}

async function act(
  action: ServiceAction,
  opts: CliOptions,
  ctx: ServiceContext,
  backend: ServiceBackend,
): Promise<number> {
  if (action === "install") return install(opts, ctx, backend);
  if (action === "uninstall") return uninstall(ctx, backend);
  if (action === "start" || action === "restart") return startOrRestart(action, opts, ctx, backend);
  if (action === "stop") return stop(opts, ctx, backend);
  if (action === "logs") return logs(opts, ctx, backend);
  return status(opts, ctx, backend);
}

/**
 * What `paddock update` needs to know and do about the service (SPEC §5).
 *
 * Built here rather than in the update module so that everything which reads a
 * unit file stays in one place: `update` gets the same answer `status` and
 * `logs` get, from the same backend, including the #824 rule that the instance
 * in question is the one the UNIT describes and not whatever `--data-dir` the
 * invocation carries.
 *
 * Returns `home` too, which is the data dir `update.lock` and
 * `update-check.json` go in. It has to be the unit's: the cache's reader is
 * `service status`, which looks in the unit's data dir, so writing it anywhere
 * else would be writing a file nothing reads.
 */
export function updateServiceHooks(ctx: ServiceContext): {
  hooks: ServiceHooksForUpdate;
  home: string;
  installed: boolean;
} {
  const backend = backendFor(ctx);
  const first = backend.status();
  const home = first.registered
    ? dataDirOf(first, ctx)
    : path.resolve(ctx.envDataDir ?? defaultDataDir(ctx.homeDir));

  const inspect = (): {
    installed: boolean;
    running: boolean;
    url?: string;
    log?: string;
  } => {
    const state = backend.status();
    if (!state.registered) {
      // No unit. A foreground `paddock serve` is still worth finding, because
      // SPEC §5's "without a service" path has to be able to say "restart
      // Paddock to use the new version" — and `runtime.json` is the only honest
      // way to find it (no guessing at a default port, the busy client's rule).
      const live = readLiveRuntimeFile(home);
      return {
        installed: false,
        running: live !== null,
        ...(live !== null ? { url: live.url } : {}),
      };
    }
    return {
      installed: true,
      running: state.running,
      url: urlOf(state),
      log: logPathOf(state, dataDirOf(state, ctx)),
    };
  };

  return {
    installed: first.registered,
    home,
    hooks: {
      inspect,
      stop: () => backend.stop(),
      // The NEW version's CLI writes the unit (SPEC §5 step 11). Run with the
      // interpreter we are running, not the bin shim: the shim's shebang has to
      // find `node` on PATH, and under a version manager there may not be one.
      refresh: (cliPath: string) => {
        const run = ctx.run ?? spawnRunner;
        return run(process.execPath, [cliPath, "service", "install", "--refresh"]);
      },
      tail: (lines: number) => {
        const state = backend.status();
        if (!state.registered) return "";
        const file = logPathOf(state, dataDirOf(state, ctx));
        return fs.existsSync(file) ? tailFile(file, lines) : "";
      },
    },
  };
}

/** The shape {@link updateServiceHooks} returns — structurally `UpdateServiceHooks`. */
export interface ServiceHooksForUpdate {
  inspect(): { installed: boolean; running: boolean; url?: string; log?: string };
  stop(): void;
  refresh(cliPath: string): { status: number | null; stdout: string; stderr: string };
  tail(lines: number): string;
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
