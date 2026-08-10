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
  /** Arguments after the script: always starts with the `start` verb. */
  args: string[];
  /** A directory the service can sit in that it certainly owns. */
  workingDirectory: string;
  /** Where stdout/stderr go on launchd. systemd uses journald and ignores these. */
  stdoutPath: string;
  stderrPath: string;
  /** PATH for the service, captured at install time. */
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

/** The data dir the service will use, resolved the same way `paddock.ts` does. */
export function defaultDataDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".paddock");
}

/**
 * Assemble the spec.
 *
 * The argument vector leads with the `start` verb even though bare `paddock`
 * would do the same thing. It costs nothing and it is the difference between
 * `launchctl print` showing an argv you can read and one you have to recognise.
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
  const args = ["start"];
  if (input.port !== undefined) args.push("--port", input.port);
  if (input.host !== undefined) args.push("--host", input.host);
  if (input.dataDirArg !== undefined) args.push("--data-dir", input.dataDirArg);
  if (input.verbose === true) args.push("--verbose");

  const dir = serviceDir(input.dataDir);
  return {
    nodePath: input.nodePath,
    scriptPath: input.scriptPath,
    args,
    workingDirectory: dir,
    stdoutPath: path.join(dir, "paddock.log"),
    stderrPath: path.join(dir, "paddock.error.log"),
    pathEnv: input.pathEnv ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
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
