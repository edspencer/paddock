// From edspencer/cli-contract reference/service/manager.ts @ 1.0; local changes: `.ts` import specifiers → `.js`.
// The seam between what a tool's service is and how a service manager spells it (SPEC §7). launchd.ts and
// systemd.ts implement `ServiceManager`; Task Scheduler (Windows, P3) is the third, later, behind the same interface.
// Every command goes through a `Runner`, so the lifecycle is tested with a fake one, on any OS. Node built-ins only.
//
// The Runner is synchronous on purpose: `update`'s service hooks are, and a sleep between launchd's bootout and
// bootstrap (`sleepSync`) is all the waiting there is.

import { spawnSync } from 'node:child_process';

/** Who the service belongs to. */
export interface ServiceIdentity {
  /** `Paddock`: for messages and the unit's header. */
  name: string;
  /** `paddock`: the bin, for the commands messages print. */
  tool: string;
  /** The launchd label: `net.edspencer.paddock`. A person may type it (`launchctl print gui/501/<label>`). */
  label: string;
  /** The systemd user unit: `paddock.service`. */
  unit: string;
  /** systemd's `Description=`. */
  description: string;
  /** systemd's `Documentation=`, if there's a page. */
  documentation?: string;
}

/** What the unit runs, already resolved: every path absolute and real. */
export interface ServiceSpec {
  /** `realpath(process.execPath)`. */
  nodePath: string;
  /** `realpath(<package>/…/cli.js)`, never the bin shim: its `#!/usr/bin/env node` needs a `node` on a PATH a
   *  service manager doesn't have under a version manager. */
  scriptPath: string;
  /** After the script: `serve` and the options. */
  args: string[];
  /** A folder the service owns: `<home>/service`. */
  workingDirectory: string;
  /** `<home>/logs/service.log`: both streams, appended, on every OS. */
  logPath: string;
  /** The service's PATH (path-env.ts). */
  pathEnv: string;
  /** More environment, if the tool needs any. Never a credential: a unit file is readable. */
  env?: Record<string, string>;
}

/** Linux only: whether the user lingers (SPEC §7). Undefined `enabled` means the check couldn't answer. */
export interface LingerState {
  /** False where there's no such thing (macOS, Windows). */
  applies: boolean;
  enabled?: boolean;
  user?: string;
}

/** What the service manager and the unit file say. */
export interface ServiceState {
  /** A unit file is installed. */
  registered: boolean;
  /** The service manager says the process is up. */
  running: boolean;
  pid?: string;
  /** The tool's arguments the unit records, with Node and the script taken off. */
  argv: string[];
  /** The Node and script the unit names, so `status` can say when one has gone (nvm, fnm and volta remove them). */
  nodePath?: string;
  cliPath?: string;
  /** The log the unit names. Read back, so `logs` reads the file the service writes even if an older unit named another. */
  logPath?: string;
  /** The unit restarts the service after a clean exit (launchd `KeepAlive`, systemd `Restart=always`). True when nothing's registered. */
  keepsAlive: boolean;
}

export interface ServiceManager {
  platform: 'darwin' | 'linux' | 'win32';
  /** Where the unit file goes. */
  unitPath: string;
  /** The launchd label or systemd unit: the string a person would type. */
  label: string;
  /** For people: `a launchd LaunchAgent`, `a systemd --user service`. */
  kind: string;
  /** Writes the unit, enables it and starts it, replacing a running one. */
  install(spec: ServiceSpec): void;
  /** Stops it, disables it and removes the unit; true if there was one. Keeps the data and the logs. */
  uninstall(): boolean;
  /**
   * `start`, `stop` and `restart` throw with the manager's own words. `stop` doesn't disable: the service comes back
   * at the next login or boot (SPEC §1). `restart` re-reads the unit.
   */
  start(): void;
  stop(): void;
  restart(): void;
  status(): ServiceState;
  linger(): LingerState;
}

export interface RunResult {
  /** null when it couldn't be run or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => RunResult;

export const spawnRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Blocks for `ms`: the Runner is synchronous, so the waits between its calls are too. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** No service manager here yet: Windows (P3), or anything else. */
export class UnsupportedPlatformError extends Error {
  override name = 'UnsupportedPlatformError';
}
