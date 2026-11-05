/**
 * What a Paddock background service IS, independent of how any one init system
 * spells it (#796).
 *
 * Everything in this file is pure. The two backends — `launchd.ts` and
 * `systemd.ts` — are writers: they take a {@link ServiceSpec} and render a
 * plist or a unit file. Keeping the decisions here rather than in either writer
 * is what lets the darwin plist be tested on Linux, which is the only place it
 * CAN be tested in this project's CI.
 */
import os from "node:os";
import path from "node:path";
import { servicePath } from "./path-env.js";

/**
 * Reverse-DNS on macOS, plain on Linux. Both are stable identifiers a user may
 * end up typing (`launchctl print gui/501/net.edspencer.paddock`,
 * `systemctl --user status paddock`), so neither is derived from anything that
 * could vary between installs.
 */
export const LAUNCHD_LABEL = "net.edspencer.paddock";
export const SYSTEMD_UNIT = "paddock.service";

/** Default port, matching the server's own (#741). Kept here so the generated
 * unit can name a port even when the user passed no flag — a unit that relies
 * on a default is a unit whose port changes under it on upgrade. */
export const DEFAULT_PORT = "7233";

export interface ServiceSpec {
  /** Absolute path to the `node` that will run us — `process.execPath`. */
  nodePath: string;
  /**
   * Absolute path to `dist/cli/paddock.js`.
   *
   * NOT the `bin` shim. npm installs a bin as a symlink whose `#!/usr/bin/env
   * node` shebang has to find `node` on PATH, and launchd's PATH is a stub —
   * under a version manager there is no `node` on it at all. Invoking the
   * interpreter explicitly removes the lookup entirely.
   */
  scriptPath: string;
  /** Arguments after the script: always starts with the `serve` verb. */
  args: string[];
  /** A directory the service can sit in that it certainly owns. */
  workingDirectory: string;
  /**
   * The one file both streams append to, on every OS (SPEC §7).
   *
   * launchd names it twice (`StandardOutPath` and `StandardErrorPath`); systemd
   * names it twice as well (`StandardOutput=append:` / `StandardError=append:`)
   * rather than using the journal. That is what makes `paddock service logs`
   * one Node implementation instead of two, and it is also what makes the
   * Linux logs survive a journal that is volatile or rate-limited — the default
   * on plenty of distributions, where `journalctl --user` after a reboot showed
   * nothing at all.
   */
  logPath: string;
  /** PATH for the service: Node's bin, the usable inherited entries, the system dirs. */
  pathEnv: string;
}

export interface SpecInput {
  nodePath: string;
  scriptPath: string;
  /** Resolved data dir — where the working directory and logs go. */
  dataDir: string;
  /** Only forwarded when the user asked for it explicitly. */
  port?: string;
  host?: string;
  /** Only present when the user wants an instance separate from their terminal one. */
  dataDirArg?: string;
  verbose?: boolean;
  pathEnv?: string;
  /**
   * Injected by tests: "is this an existing directory?", and which system
   * directories to append.
   *
   * Not a knob — a necessity. `servicePath` keeps only directories that EXIST,
   * which is what stops a unit naming a `node` that went away with a terminal
   * (path-env.ts). That makes the rendered unit depend on the filesystem it was
   * rendered on, so a golden plist asserted on this box would differ from the
   * same golden on a macOS runner, for reasons that have nothing to do with the
   * code under test. Pinning both makes the goldens about the renderer again.
   */
  pathExists?: (p: string) => boolean;
  systemDirs?: readonly string[];
}

/**
 * The service's own directory inside the data dir.
 *
 * `WorkingDirectory` has to be *something*, and the two obvious candidates are
 * both wrong. `$HOME` is wrong on the merits — a background process has no cwd
 * anyone chose, and it should not sit in a directory full of the user's things
 * (it was also, until #798, actively dangerous: `.paddock` was the here-marker
 * AND the default data dir, so `$HOME` looked like an already-opened
 * workspace). The data dir root is wrong because launchd's `StandardOutPath`
 * would then drop log files in among the state directories. A dedicated
 * subdirectory is neither.
 */
export function serviceDir(dataDir: string): string {
  return path.join(dataDir, "service");
}

/**
 * Where the service's log lives: `<dataDir>/logs/service.log` (SPEC §7).
 *
 * One file, both streams, every platform — so `paddock service logs` is one
 * implementation and the answer to "where are the logs" is one path. It is NOT
 * under {@link serviceDir}: the logs outlive any one install (`uninstall` keeps
 * them deliberately), and the server rotates this file itself
 * (`service-log.ts`), which means something other than the service CLI has to
 * be able to name it from the data dir alone.
 */
export function logsDir(dataDir: string): string {
  return path.join(dataDir, "logs");
}

/** The single log file both streams append to. */
export function serviceLogPath(dataDir: string): string {
  return path.join(logsDir(dataDir), "service.log");
}

/** The data dir the service will use, resolved the same way `paddock.ts` does. */
export function defaultDataDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".paddock");
}

/**
 * Assemble the spec.
 *
 * The argument vector leads with the `serve` verb even though bare `paddock`
 * would do the same thing. It costs nothing and it is the difference between
 * `launchctl print` showing an argv you can read and one you have to recognise.
 * It was `start` until the CLI contract made `serve` the name for running in
 * the foreground (SPEC §1); `start` is a permanent alias, so a unit written by
 * an older Paddock keeps working untouched and only gets `serve` when something
 * rewrites it.
 *
 * `--data-dir` is forwarded ONLY when the user passed it. The default of
 * setting nothing is load-bearing: with no data dir named anywhere, the service
 * and a `paddock` typed into a terminal both fall through to `~/.paddock` and
 * are the same instance. Naming it — even naming it as the same value — would
 * be a second place to change on the day someone moves it.
 *
 * `--open` is deliberately never forwarded, whatever was passed to `install`: a
 * service opening a browser tab at login is not a feature.
 */
export function buildSpec(input: SpecInput): ServiceSpec {
  const args = ["serve"];
  if (input.port !== undefined) args.push("--port", input.port);
  if (input.host !== undefined) args.push("--host", input.host);
  if (input.dataDirArg !== undefined) args.push("--data-dir", input.dataDirArg);
  if (input.verbose === true) args.push("--verbose");

  return {
    nodePath: input.nodePath,
    scriptPath: input.scriptPath,
    args,
    workingDirectory: serviceDir(input.dataDir),
    logPath: serviceLogPath(input.dataDir),
    // Node's own bin directory leads, so the interpreter the unit names can
    // find its neighbours; `servicePath` drops the installing shell's
    // per-session entries. See path-env.ts for why inheriting PATH verbatim
    // writes a unit that rots when a terminal closes.
    pathEnv: servicePath(path.dirname(input.nodePath), input.pathEnv, {
      ...(input.pathExists !== undefined ? { exists: input.pathExists } : {}),
      ...(input.systemDirs !== undefined ? { systemDirs: input.systemDirs } : {}),
    }),
  };
}

/**
 * Is this copy of Paddock running out of npx's cache?
 *
 * npx materialises a package under `~/.npm/_npx/<hash>/`, where the hash is
 * keyed on the resolved spec. Copies accumulate, and the whole tree is removed
 * by `npm cache clean`. A unit file pointing in there works right up until it
 * doesn't — at a login, unattended, with the failure reported as "Paddock
 * stopped starting". Refusing to write it is the only outcome that cannot
 * mislead someone six months from now.
 *
 * Matched on the path separator both sides so a project genuinely named `_npx`
 * is not caught, and with a Windows-separator variant because `packageRoot` is
 * whatever the platform produced.
 */
export function isNpxPath(p: string): boolean {
  return p.includes(`${path.sep}_npx${path.sep}`) || p.includes("/_npx/");
}

export const NPX_REFUSAL =
  "`service install` needs an install path that will still be there at your\n" +
  "         next login, and this copy is running from npx's cache — a hash-keyed\n" +
  "         directory that `npm cache clean` removes.\n\n" +
  "  npm i -g @edspencer/paddock && paddock service install\n";

/**
 * The port a generated unit will actually serve on, read back out of its own
 * recorded argument vector.
 *
 * `status` reports a URL, and it must be the URL of the service as installed
 * rather than the one an install run today would produce — those differ the
 * moment someone installs with `--port` and then upgrades their expectations.
 */
export function portFromArgv(argv: string[], fallback = DEFAULT_PORT): string {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--port" || argv[i] === "-p") && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return fallback;
}

/** As {@link portFromArgv}, for the bind address. */
export function hostFromArgv(argv: string[], fallback = "127.0.0.1"): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return fallback;
}
