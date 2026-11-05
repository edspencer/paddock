// From edspencer/cli-contract reference/service/launchd.ts @ 0.2; local changes: `.ts` import specifiers → `.js`.
// macOS: a launchd LaunchAgent in the `gui/<uid>` domain (SPEC §7). It starts at login, not at boot, and runs as the
// user, inside their login session (so the login keychain is unlocked). Node built-ins only.
//
// ## The bootout/bootstrap race
//
// `launchctl bootout` returns once launchd has accepted the request, not once the job has gone. A bootstrap of the
// same label straight after it races launchd's own teardown, and when it loses, fails with exit 5 (`EIO`,
// "Input/output error"). It's timing-dependent: Paddock 0.80.0's release run failed on it after the PR had passed.
// Both halves of the fix are needed:
//
// - **after a bootout we issue, wait for the job to go:** poll `launchctl print` until it fails (the label is
//   unknown), up to `BOOTOUT_POLLS` times. Counted, not timed, so an injected no-op sleep can't spin for ten seconds;
// - **retry a bootstrap that fails with 5 or 37** ("operation already in progress"), a few times with a pause. This
//   covers a bootout someone else issued: `service start` straight after another process's `service stop`.
//
// Anything else launchctl says is reported at once, in its own words.
//
// A fake `launchctl` in tests must fail `print` when nothing is loaded, or every install sits out the whole poll.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleepSync, type LingerState, type Runner, type RunResult, type ServiceIdentity, type ServiceManager, type ServiceSpec, type ServiceState } from './manager.js';

/** `~/Library/LaunchAgents/<label>.plist`. */
export function plistPath(id: Pick<ServiceIdentity, 'label'>, homeDir: string = os.homedir()): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${id.label}.plist`);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/**
 * The plist.
 *
 * - `KeepAlive` is an unconditional `<true/>`. `{ SuccessfulExit: false }` reads as the polite choice, but a server
 *   exits 0 on SIGTERM, so every SIGTERM launchd sends an agent (sleep, logout) would leave it down until the next
 *   login. `bootout` unloads the job, so `KeepAlive` doesn't fight a deliberate stop.
 * - `StandardOutPath` and `StandardErrorPath` name the same file.
 * - `EnvironmentVariables` has PATH (launchd's is a stub) and the spec's `env`. Never a credential: a plist is a
 *   readable file.
 */
export function renderPlist(id: Pick<ServiceIdentity, 'label'>, spec: ServiceSpec): string {
  const strings = [spec.nodePath, spec.scriptPath, ...spec.args].map((a) => `      <string>${xmlEscape(a)}</string>`).join('\n');
  const env = Object.entries({ PATH: spec.pathEnv, ...spec.env })
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(id.label)}</string>
    <key>ProgramArguments</key>
    <array>
${strings}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
  </dict>
</plist>
`;
}

/** `ProgramArguments`, read back from a plist this wrote. A regex is enough for a file whose shape we control. */
export function parsePlistArgv(xml: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  return block === null ? [] : [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
}

/** The log the plist names (`StandardOutPath`). */
export function parsePlistLogPath(xml: string): string | undefined {
  const m = /<key>StandardOutPath<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml);
  return m === null ? undefined : xmlUnescape(m[1]);
}

/** Whether the plist has an unconditional `KeepAlive` (the old `SuccessfulExit` dict doesn't count). */
export function plistKeepsAlive(xml: string): boolean {
  return /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(xml);
}

/** `state = running` and the pid, from `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctlPrint(out: string): { running: boolean; pid?: string } {
  const state = /^\s*state\s*=\s*(\S+)/m.exec(out);
  const pid = /^\s*pid\s*=\s*(\d+)/m.exec(out);
  return { running: state?.[1] === 'running', ...(pid !== null ? { pid: pid[1] } : {}) };
}

function launchctlFailure(verb: string, r: RunResult): string {
  return `launchctl ${verb} failed (exit ${String(r.status)}): ${`${r.stderr || r.stdout}`.trim()}`;
}

export const BOOTOUT_POLLS = 40;
export const BOOTOUT_POLL_MS = 250;
export const BOOTSTRAP_ATTEMPTS = 6;
export const BOOTSTRAP_BACKOFF_MS = 500;
/** 5 is `EIO`; 37 is "operation already in progress". Both mean the last bootout hasn't finished. */
export const BOOTSTRAP_RACE_CODES: ReadonlySet<number> = new Set([5, 37]);

export interface LaunchdOptions {
  run: Runner;
  homeDir?: string;
  uid?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => void;
}

export function createLaunchd(id: ServiceIdentity, o: LaunchdOptions): ServiceManager {
  const { run } = o;
  const sleep = o.sleep ?? sleepSync;
  const file = plistPath(id, o.homeDir);
  const domain = `gui/${o.uid ?? process.getuid?.() ?? 0}`;
  const target = `${domain}/${id.label}`;

  /** Boots the job out and waits until launchd agrees it has gone. A job that won't go fails the bootstrap later. */
  const bootoutAndWait = (): RunResult => {
    const r = run('launchctl', ['bootout', target]);
    for (let poll = 1; poll <= BOOTOUT_POLLS; poll++) {
      if (run('launchctl', ['print', target]).status !== 0) break;
      if (poll < BOOTOUT_POLLS) sleep(BOOTOUT_POLL_MS);
    }
    return r;
  };

  /** Bootstraps the plist, retrying the race codes. Not `load`: that's a shim that reports success when this fails. */
  const bootstrap = (): void => {
    for (let attempt = 1; ; attempt++) {
      const r = run('launchctl', ['bootstrap', domain, file]);
      if (r.status === 0) return;
      if (attempt >= BOOTSTRAP_ATTEMPTS || !BOOTSTRAP_RACE_CODES.has(r.status ?? -1)) throw new Error(launchctlFailure('bootstrap', r));
      sleep(BOOTSTRAP_BACKOFF_MS);
    }
  };

  return {
    platform: 'darwin',
    unitPath: file,
    label: id.label,
    kind: 'a launchd LaunchAgent',

    install(spec) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(spec.workingDirectory, { recursive: true });
      // launchd doesn't create the log's folder; without it the job fails to spawn, and says nothing.
      fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
      fs.writeFileSync(file, renderPlist(id, spec), 'utf8');
      // A bootout first, because bootstrap refuses a label that's loaded. It fails on a first install, as expected.
      bootoutAndWait();
      bootstrap();
      run('launchctl', ['kickstart', '-k', target]);
    },

    uninstall() {
      const existed = fs.existsSync(file);
      bootoutAndWait();
      if (existed) fs.rmSync(file, { force: true });
      return existed;
    },

    /** A bootstrap, because `stop` booted it out: `launchctl start` on an unknown label fails. A login does the same. */
    start() {
      bootstrap();
      run('launchctl', ['kickstart', target]);
    },

    /**
     * A bootout, not `launchctl stop` (which `KeepAlive` immediately overrules). The plist stays, so the next login
     * starts it again (`RunAtLoad`), and `status` still reports it installed.
     */
    stop() {
      const r = bootoutAndWait();
      // Exit 3, "No such process", means it wasn't loaded: the state we wanted.
      if (r.status !== 0 && r.status !== 3 && !/no such process/i.test(`${r.stderr}${r.stdout}`)) throw new Error(launchctlFailure('bootout', r));
    },

    /** Bootout, bootstrap, kickstart: works on a stopped job too, and re-reads the plist. */
    restart() {
      bootoutAndWait();
      bootstrap();
      run('launchctl', ['kickstart', '-k', target]);
    },

    status(): ServiceState {
      if (!fs.existsSync(file)) return { registered: false, running: false, argv: [], keepsAlive: true };
      const xml = fs.readFileSync(file, 'utf8');
      const argv = parsePlistArgv(xml);
      const printed = run('launchctl', ['print', target]);
      const live = printed.status === 0 ? parseLaunchctlPrint(printed.stdout) : { running: false };
      const logPath = parsePlistLogPath(xml);
      return {
        registered: true,
        running: live.running,
        ...(live.pid !== undefined ? { pid: live.pid } : {}),
        argv: argv.slice(2),
        ...(argv[0] !== undefined ? { nodePath: argv[0] } : {}),
        ...(argv[1] !== undefined ? { cliPath: argv[1] } : {}),
        ...(logPath !== undefined ? { logPath } : {}),
        keepsAlive: plistKeepsAlive(xml),
      };
    },

    /** A LaunchAgent lives as long as the login session; there's no linger. */
    linger(): LingerState {
      return { applies: false };
    },
  };
}
